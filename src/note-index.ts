import type { ServerClient } from "./server-client";
import type { EmbeddingConnection } from "./note-search";

import { noteFragments, DEFAULT_FRAGMENT_OPTIONS, isValidFragmentOptions, type FragmentOptions } from "./note-fragments";

export interface NoteSource { path: string; text: string; headings: string[]; contentHash: string; }
export type NoteSearchErrorCode = "search-fragment-settings" | "search-storage" | "search-rebuild" | "search-note" | "search-empty" | "search-budget" | "search-failed";
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

function storage(environment: NoteSearchEnvironment) {
	async function access(mode: IDBTransactionMode, value?: IndexedNote | null): Promise<IndexedNote | undefined> {
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
						const store = tx.objectStore("note");
						let result: IndexedNote | undefined;
						if (mode === "readonly") {
							const read = store.get("current"); read.onsuccess = () => { result = read.result; };
						} else if (value) store.put(value, "current");
						else store.clear();
						tx.onabort = fail;
						tx.onerror = fail;
						tx.oncomplete = () => { clearTimeout(timer); db?.close(); resolve(result); };
					} catch { fail(); }
				};
			} catch { fail(); }
		});
	}
	return { read: () => access("readonly"), write: (value: IndexedNote | null) => access("readwrite", value) };
}

export function createNoteSearch(environment: NoteSearchEnvironment) {
	const store = storage(environment);
	let connection: EmbeddingConnection | undefined;
	let fragmentOptions = { ...DEFAULT_FRAGMENT_OPTIONS };
	let minimumSimilarity = DEFAULT_MIN_SOURCE_SIMILARITY;
	let revision = 0;
	let writes: Promise<unknown> = Promise.resolve();
	let disposed = false;
	const fingerprint = () => hash(JSON.stringify({ connection, fragmentOptions, format: 2 }));
	const check = (version: number, signal?: AbortSignal) => {
		if (disposed || revision !== version || signal?.aborted) throw new NoteSearchError("search-rebuild");
	};
	function write(value: IndexedNote | null) {
		const operation = writes.then(() => store.write(value));
		// Keep failure observable on the operation, and retain it for searches until a successful rebuild.
		writes = operation;
		void writes.catch(() => {});
		return operation;
	}
	async function embed(text: string, signal?: AbortSignal): Promise<number[]> {
		if (!connection) throw new NoteSearchError("search-rebuild");
		const result = await environment.client.embeddings(connection.embeddingServerUrl, connection.embeddingModel, [text], connection.embeddingApiKey, signal);
		if (!result.ok) throw new NoteSearchError("search-failed");
		if (result.value[0].length > 65536) throw new NoteSearchError("search-failed");
		return result.value[0];
	}
	return {
		configure(next: EmbeddingConnection & { noteSearchMinSimilarity?: number } & Partial<FragmentOptions>): void {
			const options = { noteFragmentSize: next.noteFragmentSize ?? DEFAULT_FRAGMENT_OPTIONS.noteFragmentSize, noteFragmentOverlap: next.noteFragmentOverlap ?? DEFAULT_FRAGMENT_OPTIONS.noteFragmentOverlap };
			if (!isValidFragmentOptions(options)) throw new NoteSearchError("search-fragment-settings");
			minimumSimilarity = isValidMinimumSimilarity(next.noteSearchMinSimilarity) ? next.noteSearchMinSimilarity : DEFAULT_MIN_SOURCE_SIMILARITY;
			const copy = { embeddingServerUrl: next.embeddingServerUrl, embeddingApiKey: next.embeddingApiKey, embeddingModel: next.embeddingModel };
			if (JSON.stringify(connection) === JSON.stringify(copy) && JSON.stringify(fragmentOptions) === JSON.stringify(options)) return;
			const changed = connection !== undefined;
			connection = copy; fragmentOptions = options; revision++;
			if (changed) { writes = writes.catch(() => {}); void write(null); }
		},
		dispose(): void { disposed = true; revision++; },
		async index(path: string): Promise<void> {
			const version = ++revision;
			if (!path.toLowerCase().endsWith(".md")) throw new NoteSearchError("search-note");
			const text = await environment.read(path);
			if (!text?.trim()) throw new NoteSearchError("search-note");
			const identity = await fingerprint();
			const fragments: IndexedFragment[] = [];
			try {
				for (const fragment of noteFragments(path, text, environment.metadata?.(path, text) ?? {}, fragmentOptions)) {
					check(version);
					fragments.push({ ...fragment, vector: await embed(fragment.text) });
				}
			} catch (error) {
				if (error instanceof NoteSearchError) throw error;
				throw new NoteSearchError("search-fragment-settings");
			}
			if (!fragments.length) throw new NoteSearchError("search-note");
			check(version);
			if (await environment.read(path) !== text) throw new NoteSearchError("search-rebuild");
			check(version);
			writes = writes.catch(() => {});
			const contentHash = await hash(text);
			check(version);
			await write({ path, contentHash, fingerprint: identity, fragments });
			check(version);
		},
		async search(question: string, signal?: AbortSignal): Promise<NoteSource | null> {
			const version = revision;
			const threshold = minimumSimilarity;
			try { await writes; } catch { throw new NoteSearchError("search-storage"); }
			const note = await store.read();
			check(version, signal);
			if (!validNote(note) || note.fingerprint !== await fingerprint()) throw new NoteSearchError("search-rebuild");
			if (await hash(await environment.read(note.path) ?? "") !== note.contentHash) throw new NoteSearchError("search-rebuild");
			const vector = await embed(question, signal);
			check(version, signal);
			if (await hash(await environment.read(note.path) ?? "") !== note.contentHash) throw new NoteSearchError("search-rebuild");
			check(version, signal);
			const norm = (values: number[]) => Math.hypot(...values);
			let best: IndexedFragment | undefined;
			let score = -Infinity;
			for (const fragment of note.fragments) {
				if (vector.length !== fragment.vector.length) throw new NoteSearchError("search-rebuild");
				const similarity = vector.reduce((sum, value, index) => sum + value * fragment.vector[index], 0) / (norm(vector) * norm(fragment.vector));
				if (similarity + 1e-12 >= threshold && similarity > score) { best = fragment; score = similarity; }
			}
			// One bounded fragment per request keeps a long note from consuming the entire context.
			return best ? { path: note.path, text: best.text, headings: best.headings, contentHash: note.contentHash } : null;
		},
		async open(source: NoteSource): Promise<void> {
			if (await hash(await environment.read(source.path) ?? "") !== source.contentHash) throw new NoteSearchError("search-rebuild");
			if (source.headings.length) await environment.open(source.path, source.headings[source.headings.length - 1]);
			else await environment.open(source.path);
		},
	};
}
export type NoteSearch = ReturnType<typeof createNoteSearch>;
