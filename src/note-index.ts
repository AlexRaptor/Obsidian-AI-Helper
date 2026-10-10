import type { ServerClient } from "./server-client";
import type { EmbeddingConnection } from "./note-search";

export interface NoteSource { path: string; text: string; }
export type NoteSearchErrorCode = "search-storage" | "search-rebuild" | "search-note" | "search-long" | "search-empty" | "search-budget" | "search-failed";
export class NoteSearchError extends Error {
	constructor(public readonly code: NoteSearchErrorCode) { super(code); }
}
interface IndexedNote extends NoteSource { fingerprint: string; vector: number[]; }
interface NoteSearchEnvironment {
	vaultPath: string;
	factory: IDBFactory | undefined;
	client: ServerClient;
	read(path: string): Promise<string | null>;
	open(path: string): Promise<void>;
}
const SOURCE_CHAR_LIMIT = 4000;
// Calibrated on the Russian single-note acceptance scenario with Qwen3 embeddings.
const MIN_SOURCE_SIMILARITY = 0.45;
async function hash(text: string): Promise<string> {
	const digest = await globalThis.crypto.subtle.digest("SHA-256", new TextEncoder().encode(text));
	return Array.from(new Uint8Array(digest), (byte) => byte.toString(16).padStart(2, "0")).join("");
}

// One bounded record in a vault-specific renderer database. No file fallback.
function validNote(value: unknown): value is IndexedNote {
	if (!value || typeof value !== "object") return false;
	const note = value as Partial<IndexedNote>;
	return typeof note.path === "string" && note.path.endsWith(".md") && typeof note.text === "string"
		&& note.text.length > 0 && note.text.length <= SOURCE_CHAR_LIMIT && typeof note.fingerprint === "string"
		&& Array.isArray(note.vector) && note.vector.length > 0 && note.vector.length <= 65536
		&& note.vector.every((value) => typeof value === "number" && Number.isFinite(value))
		&& Number.isFinite(Math.hypot(...note.vector)) && Math.hypot(...note.vector) > 0;
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
	let revision = 0;
	let writes: Promise<unknown> = Promise.resolve();
	let disposed = false;
	const fingerprint = () => hash(JSON.stringify(connection));
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
		configure(next: EmbeddingConnection): void {
			const copy = { embeddingServerUrl: next.embeddingServerUrl, embeddingApiKey: next.embeddingApiKey, embeddingModel: next.embeddingModel };
			if (JSON.stringify(connection) === JSON.stringify(copy)) return;
			const changed = connection !== undefined;
			connection = copy; revision++;
			if (changed) { writes = writes.catch(() => {}); void write(null); }
		},
		dispose(): void { disposed = true; revision++; },
		async index(path: string): Promise<void> {
			const version = ++revision;
			if (!path.toLowerCase().endsWith(".md")) throw new NoteSearchError("search-note");
			const text = await environment.read(path);
			if (!text?.trim()) throw new NoteSearchError("search-note");
			if (text.length > SOURCE_CHAR_LIMIT) throw new NoteSearchError("search-long");
			const identity = await fingerprint();
			const vector = await embed(text);
			check(version);
			if (await environment.read(path) !== text) throw new NoteSearchError("search-rebuild");
			check(version);
			writes = writes.catch(() => {});
			await write({ path, text, fingerprint: identity, vector });
			check(version);
		},
		async search(question: string, signal?: AbortSignal): Promise<NoteSource | null> {
			const version = revision;
			try { await writes; } catch { throw new NoteSearchError("search-storage"); }
			const note = await store.read();
			check(version, signal);
			if (!validNote(note) || note.fingerprint !== await fingerprint()) throw new NoteSearchError("search-rebuild");
			if (await environment.read(note.path) !== note.text) throw new NoteSearchError("search-rebuild");
			const vector = await embed(question, signal);
			check(version, signal);
			if (await environment.read(note.path) !== note.text) throw new NoteSearchError("search-rebuild");
			check(version, signal);
			if (vector.length !== note.vector.length) throw new NoteSearchError("search-rebuild");
			const norm = (values: number[]) => Math.hypot(...values);
			const similarity = vector.reduce((sum, value, index) => sum + value * note.vector[index], 0) / (norm(vector) * norm(note.vector));
			return similarity >= MIN_SOURCE_SIMILARITY ? { path: note.path, text: note.text } : null;
		},
		async open(source: NoteSource): Promise<void> {
			if (await environment.read(source.path) !== source.text) throw new NoteSearchError("search-rebuild");
			await environment.open(source.path);
		},
	};
}
export type NoteSearch = ReturnType<typeof createNoteSearch>;
