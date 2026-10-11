import type { ServerClient } from "./server-client";
import type { EmbeddingConnection } from "./note-search";

import { noteFragments, DEFAULT_FRAGMENT_OPTIONS, isValidFragmentOptions, type FragmentOptions } from "./note-fragments";

export interface NoteSource { path: string; text: string; headings: string[]; contentHash: string; partial?: boolean; }
export type NoteSearchErrorCode = "search-fragment-settings" | "search-storage" | "search-rebuild" | "search-note" | "search-empty" | "search-budget" | "search-failed" | "search-excluded";
export class NoteSearchError extends Error {
	constructor(public readonly code: NoteSearchErrorCode) { super(code); }
}
interface IndexedFragment { text: string; headings: string[]; vector: number[]; }
interface IndexedNote { path: string; contentHash: string; fingerprint: string; fragments: IndexedFragment[]; }
interface NoteSearchEnvironment {
	vaultPath: string;
	factory: IDBFactory | undefined;
	client: ServerClient;
	read(path: string): Promise<string | null>;
	list?(): string[];
	open(path: string, heading?: string): Promise<void>;
	metadata?(path: string, raw: string): Record<string, unknown>;
}

// Calibrated on the Russian single-note acceptance scenario with Qwen3 embeddings.
export const DEFAULT_MIN_SOURCE_SIMILARITY = 0.45;
export function isValidMinimumSimilarity(value: unknown): value is number {
	return typeof value === "number" && Number.isFinite(value) && value >= 0 && value <= 1;
}
async function hash(text: string): Promise<string> {
	const digest = await globalThis.crypto.subtle.digest("SHA-256", new TextEncoder().encode(text));
	return Array.from(new Uint8Array(digest), (byte) => byte.toString(16).padStart(2, "0")).join("");
}

// Derived data is validated before use, including records from earlier plugin versions.
function validNote(value: unknown): value is IndexedNote {
	if (!value || typeof value !== "object") return false;
	const note = value as Partial<IndexedNote>;
	return typeof note.path === "string" && /\.md$/i.test(note.path) && typeof note.contentHash === "string"
		&& typeof note.fingerprint === "string" && Array.isArray(note.fragments) && note.fragments.length > 0
		&& note.fragments.every((fragment) => fragment !== null && typeof fragment === "object" && typeof fragment.text === "string" && fragment.text.length > 0 && fragment.text.length <= 16000
			&& Array.isArray(fragment.headings) && fragment.headings.every((heading: unknown) => typeof heading === "string")
			&& Array.isArray(fragment.vector) && fragment.vector.length > 0 && fragment.vector.length <= 65536
			&& fragment.vector.every((value: unknown) => typeof value === "number" && Number.isFinite(value))
			&& Number.isFinite(Math.hypot(...fragment.vector)) && Math.hypot(...fragment.vector) > 0);
}

export interface IndexProgress {
	state: "idle" | "indexing" | "partial" | "complete" | "error";
	completed: number;
	total: number;
	error?: NoteSearchErrorCode;
}
interface SavedProgress extends IndexProgress { fingerprint: string; }
function storage(environment: NoteSearchEnvironment) {
	async function access<T>(mode: IDBTransactionMode, action: (store: IDBObjectStore, set: (value: T) => void) => void): Promise<T> {
		if (!environment.vaultPath || !environment.factory) throw new NoteSearchError("search-storage");
		const name = `obsidian-ai-helper-note-index-v1-${await hash(environment.vaultPath)}`;
		return new Promise((resolve, reject) => {
			let db: IDBDatabase | undefined;
			let expired = false;
			let transaction: IDBTransaction | undefined;
			const fail = () => {
				if (expired) return;
				expired = true; clearTimeout(timer);
				try { transaction?.abort(); } catch { /* Already completed or aborted. */ }
				db?.close(); reject(new NoteSearchError("search-storage"));
			};
			const timer = setTimeout(fail, 5000);
			try {
				const request = environment.factory!.open(name, 1);
				request.onupgradeneeded = () => request.result.createObjectStore("note");
				request.onerror = fail;
				request.onblocked = fail;
				request.onsuccess = () => {
					db = request.result;
					if (expired) { db.close(); return; }
					db.onversionchange = () => db?.close();
					try {
						const tx = db.transaction("note", mode);
						transaction = tx;
						let result: T;
						action(tx.objectStore("note"), (value) => { result = value; });
						tx.onabort = fail;
						tx.onerror = fail;
						tx.oncomplete = () => { clearTimeout(timer); db?.close(); resolve(result); };
					} catch { fail(); }
				};
			} catch { fail(); }
		});
	}
	return {
		read: () => access<{ notes: unknown[]; progress?: SavedProgress }>("readonly", (store, set) => {
			const notes = store.getAll();
			const keys = store.getAllKeys();
			const progress = store.get("progress");
			progress.onsuccess = () => set({ notes: notes.result.filter((_value, index) => keys.result[index] !== "progress"), progress: progress.result });
		}),
		write: (action: (store: IDBObjectStore) => void) => access<void>("readwrite", (store) => action(store)),
	};
}

export function createNoteSearch(environment: NoteSearchEnvironment) {
	const store = storage(environment);
	let connection: EmbeddingConnection | undefined;
	let fragmentOptions = { ...DEFAULT_FRAGMENT_OPTIONS };
	let minimumSimilarity = DEFAULT_MIN_SOURCE_SIMILARITY;
	let excludedFolders: string[] = [];
	let revision = 0;
	let writes: Promise<unknown> = Promise.resolve();
	let disposed = false;
	let controller: AbortController | undefined;
	let progress: IndexProgress = { state: "idle", completed: 0, total: 0 };
	const listeners = new Set<() => void>();
	const notify = () => listeners.forEach((listener) => listener());
	const fingerprint = () => hash(JSON.stringify({ connection, fragmentOptions, format: 2 }));
	const permitted = (path: string, folders: string[]) => typeof path === "string" && /\.md$/i.test(path) && !path.split("/").some((part) => part === "." || part === "..") && !folders.some((folder) => !folder || path === folder || path.startsWith(folder + "/"));
	const allowed = (path: string) => permitted(path, excludedFolders);
	const check = (version: number, signal?: AbortSignal) => {
		if (disposed || revision !== version || signal?.aborted) throw new NoteSearchError("search-rebuild");
	};
	function cancel() { controller?.abort(); controller = undefined; revision++; }
	function write(action: (store: IDBObjectStore) => void) {
		const operation = writes.catch(() => {}).then(() => store.write(action));
		writes = operation;
		void writes.catch(() => {});
		return operation;
	}
	async function saveProgress(version: number, identity: string, note?: IndexedNote) {
		const saved = { ...progress, fingerprint: identity };
		await write((store) => {
			check(version);
			if (note) store.put(note, note.path);
			store.put(saved, "progress");
		});
		check(version); notify();
	}
	async function embed(text: string, signal?: AbortSignal): Promise<number[]> {
		if (!connection) throw new NoteSearchError("search-rebuild");
		const result = await environment.client.embeddings(connection.embeddingServerUrl, connection.embeddingModel, [text], connection.embeddingApiKey, signal);
		if (!result.ok || result.value[0].length > 65536) throw new NoteSearchError("search-failed");
		return result.value[0];
	}
	async function processNote(path: string, version: number, identity: string): Promise<IndexedNote | null> {
		check(version);
		if (!allowed(path)) throw new NoteSearchError("search-excluded");
		const text = await environment.read(path);
		check(version);
		if (!text?.trim()) return null;
		const fragments: IndexedFragment[] = [];
		try {
			// A single bounded fragment per HTTP batch; yield even with an immediate transport.
			for (const fragment of noteFragments(path, text, environment.metadata?.(path, text) ?? {}, fragmentOptions)) {
				check(version);
				const vector = await embed(fragment.text, controller?.signal);
				check(version);
				fragments.push({ ...fragment, vector });
				await new Promise<void>((resolve) => setTimeout(resolve, 0));
			}
		} catch (error) {
			check(version);
			if (error instanceof NoteSearchError) throw error;
			throw new NoteSearchError("search-fragment-settings");
		}
		check(version);
		if (!fragments.length) return null;
		if (await environment.read(path) !== text) throw new NoteSearchError("search-rebuild");
		const contentHash = await hash(text);
		check(version);
		return { path, contentHash, fingerprint: identity, fragments };
	}
	async function run(paths: string[], full: boolean): Promise<void> {
		cancel(); controller = new AbortController();
		const version = revision;
		const identity = await fingerprint();
		check(version);
		progress = { state: "indexing", completed: 0, total: paths.length }; notify();
		try {
			await saveProgress(version, identity);
			for (const path of paths) {
				const note = await processNote(path, version, identity);
				check(version);
				if (!note && !full) throw new NoteSearchError("search-note");
				progress = { ...progress, completed: progress.completed + 1 };
				if (!note) await write((store) => { check(version); store.delete(path); });
				await saveProgress(version, identity, note ?? undefined);
			}
			progress = { ...progress, state: full ? "complete" : "partial" };
			await saveProgress(version, identity);
		} catch (error) {
			if (version === revision && !disposed) {
				progress = { ...progress, state: "error", error: error instanceof NoteSearchError ? error.code : "search-failed" }; notify();
				await saveProgress(version, identity).catch(() => {});
			}
			throw error;
		} finally { if (version === revision) controller = undefined; }
	}
	function restoreProgress(saved: SavedProgress | undefined, identity: string) {
		if (saved?.fingerprint !== identity || !["idle", "indexing", "partial", "complete", "error"].includes(saved.state)
			|| !Number.isSafeInteger(saved.completed) || !Number.isSafeInteger(saved.total) || saved.completed < 0 || saved.total < saved.completed) return;
		progress = { state: saved.state === "indexing" ? "partial" : saved.state, completed: saved.completed, total: saved.total, error: saved.error }; notify();
	}
	return {
		get progress(): IndexProgress { return { ...progress }; },
		subscribe(listener: () => void): () => void { listeners.add(listener); return () => { listeners.delete(listener); }; },
		configure(next: EmbeddingConnection & { noteSearchMinSimilarity?: number; excludedFolders?: string[] } & Partial<FragmentOptions>): void {
			const options = { noteFragmentSize: next.noteFragmentSize ?? DEFAULT_FRAGMENT_OPTIONS.noteFragmentSize, noteFragmentOverlap: next.noteFragmentOverlap ?? DEFAULT_FRAGMENT_OPTIONS.noteFragmentOverlap };
			if (!isValidFragmentOptions(options)) throw new NoteSearchError("search-fragment-settings");
			minimumSimilarity = isValidMinimumSimilarity(next.noteSearchMinSimilarity) ? next.noteSearchMinSimilarity : DEFAULT_MIN_SOURCE_SIMILARITY;
			const folders = [...new Set((next.excludedFolders ?? []).map((path) => path.trim().replace(/\\/g, "/").replace(/^\/+|\/+$/g, "").replace(/\/+/g, "/")))];
			const copy = { embeddingServerUrl: next.embeddingServerUrl, embeddingApiKey: next.embeddingApiKey, embeddingModel: next.embeddingModel };
			const incompatible = JSON.stringify(connection) !== JSON.stringify(copy) || JSON.stringify(fragmentOptions) !== JSON.stringify(options);
			const exclusionsChanged = JSON.stringify(folders) !== JSON.stringify(excludedFolders);
			if (!incompatible && !exclusionsChanged) return;
			const changed = connection !== undefined;
			connection = copy; fragmentOptions = options; excludedFolders = folders; cancel();
			if (changed || folders.length) {
				if (changed) { progress = incompatible ? { state: "idle", completed: 0, total: 0 } : { ...progress, state: "partial" }; notify(); }
				const version = revision;
				let updated: SavedProgress | undefined;
				const identity = fingerprint();
				void write((store) => {
					if (changed && incompatible) { store.clear(); return; }
					let removed = 0;
					let saved: SavedProgress | undefined;
					const cursor = store.openCursor();
					cursor.onsuccess = () => {
						const entry = cursor.result;
						if (!entry) {
							if (saved && (removed || changed)) {
								updated = { ...saved, state: "partial", completed: Math.max(0, saved.completed - removed) };
								store.put(updated, "progress");
							}
							return;
						}
						if (entry.key === "progress") saved = entry.value;
						else if (!validNote(entry.value) || !permitted(entry.value.path, folders)) { entry.delete(); removed++; }
						entry.continue();
					};
				}).then(async () => {
					const currentIdentity = await identity;
					if (version === revision && !disposed && updated) restoreProgress(updated, currentIdentity);
				}).catch(() => {});
			}
		},
		dispose(): void { disposed = true; cancel(); listeners.clear(); },
		async restore(): Promise<void> {
			const version = revision;
			try { await writes; } catch { throw new NoteSearchError("search-storage"); }
			const saved = await store.read();
			const identity = await fingerprint();
			check(version);
			restoreProgress(saved.progress, identity);
		},
		async index(path: string): Promise<void> {
			if (!/\.md$/i.test(path)) throw new NoteSearchError("search-note");
			if (!allowed(path)) throw new NoteSearchError("search-excluded");
			await run([path], false);
		},
		async indexVault(): Promise<void> {
			if (!environment.list) throw new NoteSearchError("search-note");
			await run([...new Set(environment.list())].filter(allowed), true);
		},
		async clear(): Promise<void> {
			cancel(); progress = { state: "idle", completed: 0, total: 0 }; notify();
			await write((store) => store.clear());
		},
		async rebuild(): Promise<void> { await this.clear(); await this.indexVault(); },
		async search(question: string, signal?: AbortSignal): Promise<NoteSource | null> {
			const version = revision;
			const threshold = minimumSimilarity;
			try { await writes; } catch { throw new NoteSearchError("search-storage"); }
			const saved = await store.read();
			check(version, signal);
			const identity = await fingerprint();
			check(version, signal);
			const notes = saved.notes.filter(validNote).filter((note) => allowed(note.path) && note.fingerprint === identity);
			if (progress.state === "idle") restoreProgress(saved.progress, identity);
			if (!notes.length) throw new NoteSearchError("search-rebuild");
			const current: IndexedNote[] = [];
			for (const note of notes) {
				check(version, signal);
				if (await hash(await environment.read(note.path) ?? "") === note.contentHash) current.push(note);
			}
			check(version, signal);
			if (!current.length) throw new NoteSearchError("search-rebuild");
			const vector = await embed(question, signal);
			check(version, signal);
			let best: NoteSource | null = null;
			let score = -Infinity;
			for (const note of current) {
				for (const fragment of note.fragments) {
					if (vector.length !== fragment.vector.length) throw new NoteSearchError("search-rebuild");
					const similarity = vector.reduce((sum, value, index) => sum + value * fragment.vector[index], 0) / (Math.hypot(...vector) * Math.hypot(...fragment.vector));
					if (similarity + 1e-12 >= threshold && similarity > score) {
						score = similarity;
						best = { path: note.path, text: fragment.text, headings: fragment.headings, contentHash: note.contentHash, partial: progress.state !== "complete" || current.length !== notes.length };
					}
				}
			}
			if (best && await hash(await environment.read(best.path) ?? "") !== best.contentHash) throw new NoteSearchError("search-rebuild");
			check(version, signal);
			return best;
		},
		async open(source: NoteSource): Promise<void> {
			const version = revision;
			if (!allowed(source.path)) throw new NoteSearchError("search-excluded");
			if (await hash(await environment.read(source.path) ?? "") !== source.contentHash) throw new NoteSearchError("search-rebuild");
			check(version);
			if (source.headings.length) await environment.open(source.path, source.headings[source.headings.length - 1]);
			else await environment.open(source.path);
		},
	};
}
export type NoteSearch = ReturnType<typeof createNoteSearch>;
