import type { ServerClient, EmbeddingErrorCode } from "./server-client";

export interface EmbeddingConnection {
	embeddingServerUrl: string;
	embeddingApiKey: string;
	embeddingModel: string;
}

export type EmbeddingStatus =
	| { state: "idle" | "checking" }
	| { state: "verified"; dimensions: number }
	| { state: "error"; code: EmbeddingErrorCode };

export function createNoteSearchConnection(client: ServerClient) {
	let connection: EmbeddingConnection = { embeddingServerUrl: "", embeddingApiKey: "", embeddingModel: "" };
	let status: EmbeddingStatus = { state: "idle" };
	let request: AbortController | null = null;
	function cancel() {
		request?.abort();
		request = null;
		status = { state: "idle" };
	}
	return {
		get status(): EmbeddingStatus { return status; },
		configure(next: EmbeddingConnection): void {
			if (connection.embeddingServerUrl === next.embeddingServerUrl && connection.embeddingApiKey === next.embeddingApiKey && connection.embeddingModel === next.embeddingModel) return;
			cancel();
			connection = { embeddingServerUrl: next.embeddingServerUrl, embeddingApiKey: next.embeddingApiKey, embeddingModel: next.embeddingModel };
		},
		cancel,
		async verify(): Promise<void> {
			cancel();
			const active = new AbortController();
			request = active;
			status = { state: "checking" };
			// Synthetic texts only: never read or send notes as part of a connection check.
			const result = await client.embeddings(connection.embeddingServerUrl, connection.embeddingModel,
				["A cat sits by the window.", "The train arrives at the station."], connection.embeddingApiKey, active.signal);
			if (request !== active) return;
			request = null;
			status = result.ok ? { state: "verified", dimensions: result.value[0].length }
				: { state: "error", code: result.error.code as EmbeddingErrorCode };
		},
	};
}

// Technical probe only: no note content, embeddings or file-backed fallback.
const BLOCK_BYTES = 64 * 1024;
export const PROBE_BYTES = 6 * 1024 * 1024;
export const PROBE_LIMIT_BYTES = 8 * 1024 * 1024;
const TIMEOUT_MS = 5000;

export type StorageProbeErrorCode = "unavailable" | "write" | "limit" | "corrupt";
export class StorageProbeError extends Error {
	constructor(public readonly code: StorageProbeErrorCode) { super(code); }
}

export async function createNoteSearchStorageProbe(vaultPath: string, factory: IDBFactory | undefined) {
	if (!vaultPath) throw new StorageProbeError("unavailable");
	const digest = await globalThis.crypto.subtle.digest("SHA-256", new TextEncoder().encode(vaultPath));
	const id = Array.from(new Uint8Array(digest), (byte) => byte.toString(16).padStart(2, "0")).join("");
	const databaseName = `obsidian-ai-helper-storage-probe-v1-${id}`;

	async function open(): Promise<IDBDatabase> {
		if (!factory) throw new StorageProbeError("unavailable");
		return new Promise((resolve, reject) => {
			let expired = false;
			const timer = setTimeout(() => { expired = true; reject(new StorageProbeError("unavailable")); }, TIMEOUT_MS);
			try {
				const request = factory.open(databaseName, 1);
				request.onupgradeneeded = () => request.result.createObjectStore("probe");
				request.onerror = () => { clearTimeout(timer); reject(new StorageProbeError("unavailable")); };
				request.onblocked = () => { expired = true; clearTimeout(timer); reject(new StorageProbeError("unavailable")); };
				request.onsuccess = () => {
					clearTimeout(timer);
					if (expired) { request.result.close(); return; }
					request.result.onversionchange = () => request.result.close();
					resolve(request.result);
				};
			} catch { clearTimeout(timer); reject(new StorageProbeError("unavailable")); }
		});
	}

	async function transaction<T>(db: IDBDatabase, mode: IDBTransactionMode, action: (store: IDBObjectStore, set: (value: T) => void) => void): Promise<T> {
		return new Promise((resolve, reject) => {
			let value: T;
			const tx = db.transaction("probe", mode);
			const timer = setTimeout(() => { tx.abort(); }, TIMEOUT_MS);
			tx.oncomplete = () => { clearTimeout(timer); resolve(value); };
			tx.onabort = () => { clearTimeout(timer); reject(new StorageProbeError("write")); };
			try { action(tx.objectStore("probe"), (result) => { value = result; }); }
			catch { tx.abort(); }
		});
	}

	return {
		databaseName,
		async testAbortedWrite(): Promise<void> {
			const db = await open();
			try {
				await transaction(db, "readwrite", (store) => {
					store.put("disposable", "aborted");
					store.transaction.abort();
				});
			} finally { db.close(); }
		},
		async write(bytes = PROBE_BYTES): Promise<void> {
			if (!Number.isSafeInteger(bytes) || bytes <= 0 || bytes > PROBE_LIMIT_BYTES) throw new StorageProbeError("limit");
			const db = await open();
			try {
				await transaction(db, "readwrite", (store) => { store.clear(); });
				// One block per transaction: bounded allocation and a yield between blocks.
				for (let offset = 0; offset < bytes; offset += BLOCK_BYTES) {
					await transaction(db, "readwrite", (store) => {
						store.put(new Uint8Array(Math.min(BLOCK_BYTES, bytes - offset)).fill(13), offset / BLOCK_BYTES);
					});
				}
				await transaction(db, "readwrite", (store) => { store.put(bytes, "complete"); });
			} finally { db.close(); }
		},
		async read(): Promise<{ bytes: number; blocks: number } | null> {
			const db = await open();
			try {
				const bytes = await transaction<unknown>(db, "readonly", (store, set) => {
					const request = store.get("complete");
					request.onsuccess = () => set(request.result);
				});
				if (bytes === undefined) return null;
				if (typeof bytes !== "number" || !Number.isSafeInteger(bytes) || bytes <= 0 || bytes > PROBE_LIMIT_BYTES) throw new StorageProbeError("corrupt");
				for (let offset = 0; offset < bytes; offset += BLOCK_BYTES) {
					const valid = await transaction<boolean>(db, "readonly", (store, set) => {
						const request = store.get(offset / BLOCK_BYTES);
						request.onsuccess = () => {
							const block = request.result;
							set(block instanceof Uint8Array && block.length === Math.min(BLOCK_BYTES, bytes - offset) && block.every((byte) => byte === 13));
						};
					});
					if (!valid) throw new StorageProbeError("corrupt");
				}
				return { bytes, blocks: Math.ceil(bytes / BLOCK_BYTES) };
			} finally { db.close(); }
		},
		async clear(): Promise<void> {
			const db = await open();
			try { await transaction(db, "readwrite", (store) => { store.clear(); }); }
			finally { db.close(); }
		},
	};
}
