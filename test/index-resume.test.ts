import { describe, expect, it, vi } from "vitest";
import { IDBFactory } from "fake-indexeddb";
import { createNoteSearch } from "../src/note-index";
import { createServerClient } from "../src/server-client";

import { fileIndexAdapter } from "./helpers/file-index";

const connection = { embeddingServerUrl: "http://s/v1", embeddingApiKey: "", embeddingModel: "e", noteUpdateDelaySeconds: 0.01 };
describe.each(["local", "file"] as const)("%s index storage", mode => {
function fixture() {
	const notes = new Map([["Ready.md", "ready"], ["Pending.md", "pending"]]);
	const inputs: string[] = [];
	const signals: (AbortSignal | null | undefined)[] = [];
	let hold = true;
	let finish!: (response: Response) => void;
	const response = () => new Response(JSON.stringify({ data: [{ index: 0, embedding: [1, 0] }] }));
	const client = createServerClient(async (_url, init) => {
		const { input } = JSON.parse(String(init?.body)); inputs.push(...input); signals.push(init?.signal);
		if (hold && input[0].includes("pending")) return new Promise<Response>(resolve => { finish = resolve; });
		return response();
	});
	const environment = { factory: mode === "local" ? new IDBFactory() : undefined, storageMode: mode, fileStorage: { adapter: fileIndexAdapter(), directory: ".obsidian/plugins/obsidian-ai-helper/note-index" }, vaultPath: "/resume", client, list: () => [...notes.keys()], read: async (path: string) => notes.get(path) ?? null, open: async () => {} };
	const search = createNoteSearch(environment); search.configure(connection);
	return { search, environment, notes, inputs, signals, release: () => { hold = false; finish(response()); } };
}
it("persists manual pause and reconciles stopped edits in a new instance without repeating completed notes", async () => {
	const { search, environment, notes, inputs, release } = fixture();
	const indexing = search.indexVault().catch(() => {});
	await vi.waitFor(() => expect(inputs).toHaveLength(2));
	await search.pause(); release(); await indexing;
	expect(search.progress).toMatchObject({ state: "paused", completed: 1, total: 2 });
	notes.set("Pending.md", "latest pending"); await search.changed("Pending.md"); search.dispose();
	notes.set("Empty.md", ""); notes.set("Gone.md", "gone"); notes.delete("Gone.md");
	const restored = createNoteSearch(environment); restored.configure(connection); await restored.restore(); await restored.resume();
	expect(restored.progress).toMatchObject({ state: "paused", completed: 1, total: 3 });
	await new Promise(resolve => setTimeout(resolve, 40)); expect(inputs).toHaveLength(2);
	await restored.resume(true);
	expect(inputs).toHaveLength(3); expect(inputs[2]).toContain("latest pending");
	expect(restored.progress).toMatchObject({ state: "complete", completed: 3, total: 3 }); restored.dispose();
});
it("coalesces repeated continue actions and never retries from offline edits or server startup", async () => {
	const { search, environment, notes, inputs, release } = fixture();
	const indexing = search.indexVault(); await vi.waitFor(() => expect(inputs).toHaveLength(2)); release(); await indexing;
	let offline = true;
	const attempts: string[] = [];
	const client = createServerClient(async (_url, init) => {
		const { input } = JSON.parse(String(init?.body)); attempts.push(...input);
		if (offline) throw new Error("offline");
		return new Response(JSON.stringify({ data: [{ index: 0, embedding: [1, 0] }] }));
	});
	search.dispose(); const active = createNoteSearch({ ...environment, client }); active.configure(connection); await active.restore();
	notes.set("Pending.md", "offline edit"); await active.changed("Pending.md");
	await vi.waitFor(() => expect(active.progress.state).toBe("error"));
	notes.set("Pending.md", "latest version"); await active.changed("Pending.md");
	notes.set("New.md", "new version"); await active.changed("New.md");
	offline = false; await new Promise(resolve => setTimeout(resolve, 60)); expect(attempts).toHaveLength(1);
	expect(active.progress).toMatchObject({ state: "error", completed: 1, total: 3 });
	await Promise.all([active.resume(true), active.resume(true), active.resume(true)]);
	expect(attempts).toHaveLength(3); expect(attempts[1]).toContain("latest version"); expect(attempts[2]).toContain("new version");
	expect(active.progress).toMatchObject({ state: "complete", completed: 3, total: 3 }); active.dispose();
});
it("requires an explicit rebuild for an incompatible saved connection", async () => {
	const { search, environment, inputs, release } = fixture();
	const indexing = search.indexVault(); await vi.waitFor(() => expect(inputs).toHaveLength(2)); release(); await indexing; search.dispose();
	const restored = createNoteSearch(environment); restored.configure({ ...connection, embeddingModel: "different" });
	await restored.restore(); await restored.resume();
	expect(inputs).toHaveLength(2); expect(restored.progress.state).toBe("idle");
	await expect(restored.search("ready")).rejects.toMatchObject({ code: "search-rebuild" });
	await restored.changed("Ready.md"); restored.dispose();
	const reopened = createNoteSearch(environment); reopened.configure({ ...connection, embeddingModel: "different" });
	await reopened.restore(); await reopened.resume();
	expect(reopened.progress.state).toBe("idle"); expect(inputs).toHaveLength(2); reopened.dispose();
});
it("recalculates coverage and queues newly included notes when exclusions change", async () => {
	const { search, notes, inputs, release } = fixture();
	const indexing = search.indexVault(); await vi.waitFor(() => expect(inputs).toHaveLength(2)); release(); await indexing;
	await search.pause(); notes.set("Private/Secret.md", "secret");
	search.configure({ ...connection, excludedFolders: ["Pending.md", "Private"] });
	await vi.waitFor(() => expect(search.progress).toMatchObject({ state: "paused", completed: 1, total: 1 }));
	search.configure(connection);
	await vi.waitFor(() => expect(search.progress).toMatchObject({ state: "paused", completed: 1, total: 3 }));
	await search.resume(true); expect(inputs).toHaveLength(4); search.dispose();
});
it("keeps completed work on unload, aborts the request and rejects a late result without notifying subscribers", async () => {
	const { search, environment, inputs, signals, release } = fixture();
	const listener = vi.fn(); search.subscribe(listener);
	const indexing = search.indexVault().catch(error => error);
	await vi.waitFor(() => expect(inputs).toHaveLength(2));
	search.dispose(); expect(signals[1]?.aborted).toBe(true); listener.mockClear(); release();
	expect(await indexing).toMatchObject({ code: "search-rebuild" });
	await search.changed("Ready.md"); await search.resume(true);
	expect(inputs).toHaveLength(2); expect(listener).not.toHaveBeenCalled();
	const restored = createNoteSearch(environment); restored.configure(connection); await restored.restore();
	expect(restored.progress).toMatchObject({ state: "partial", completed: 1, total: 2 });
	await restored.resume(); expect(inputs).toHaveLength(3); expect(inputs[2]).toContain("pending"); restored.dispose();
});
it("counts allowed notes before first indexing and after idle vault events without background requests", async () => {
	const { search, notes, inputs, environment } = fixture(); await search.restore();
	expect(search.progress).toMatchObject({ state: "idle", completed: 0, total: 2 });
	notes.set("New.md", "new"); await search.changed("New.md");
	expect(search.progress).toMatchObject({ state: "idle", completed: 0, total: 3 });
	search.configure({ ...connection, excludedFolders: ["New.md"] });
	await vi.waitFor(() => expect(search.progress).toMatchObject({ state: "idle", completed: 0, total: 2 }));
	search.dispose(); const restored = createNoteSearch(environment); restored.configure(connection); await restored.restore(); await restored.resume();
	expect(restored.progress).toMatchObject({ state: "idle", completed: 0, total: 3 });
	expect(inputs).toHaveLength(0); restored.dispose();
});
it("starts a fresh rebuild when the cancelled resume is still waiting for a vault read", async () => {
	const { search, environment, inputs, release } = fixture();
	const indexing = search.indexVault(); await vi.waitFor(() => expect(inputs).toHaveLength(2)); release(); await indexing; search.dispose();
	let reading = false; let finish!: (text: string | null) => void;
	const active = createNoteSearch({ ...environment, read: async path => {
		if (!reading) { reading = true; return new Promise<string | null>(resolve => { finish = resolve; }); }
		return environment.read(path);
	} });
	active.configure(connection);
	// Restore without holding a read, then hold the explicit resume snapshot.
	reading = true; await active.restore(); reading = false;
	const resuming = active.resume(true).catch(error => error);
	await vi.waitFor(() => expect(reading).toBe(true));
	const rebuilding = active.rebuild().catch(error => error);
	try { await vi.waitFor(() => expect(inputs).toHaveLength(4)); }
	finally { finish("ready"); await resuming; }
	expect(await rebuilding).toBeUndefined();
	expect(active.progress).toMatchObject({ state: "complete", completed: 2, total: 2 }); active.dispose();
});

it("retains offline edits and manual pause across restart, then retries only latest versions", async () => {
	const { search, environment, notes, inputs, release } = fixture();
	const indexing = search.indexVault(); await vi.waitFor(() => expect(inputs).toHaveLength(2)); release(); await indexing; search.dispose();
	let offline = true; const attempts: string[] = [];
	const client = createServerClient(async (_url, init) => {
		attempts.push(...JSON.parse(String(init?.body)).input);
		if (offline) throw new Error("offline");
		return new Response(JSON.stringify({ data: [{ index: 0, embedding: [1, 0] }] }));
	});
	const active = createNoteSearch({ ...environment, client }); active.configure(connection); await active.restore();
	notes.set("Pending.md", "offline edit"); await active.changed("Pending.md");
	await vi.waitFor(() => expect(active.progress.state).toBe("error"));
	notes.set("Pending.md", "latest pending"); await active.changed("Pending.md");
	notes.set("New.md", "latest new"); await active.changed("New.md");
	await active.pause(); active.dispose();
	const restored = createNoteSearch({ ...environment, client }); restored.configure(connection); await restored.restore(); await restored.resume();
	expect(restored.progress).toMatchObject({ state: "paused", completed: 1, total: 3 });
	expect(attempts).toHaveLength(1);
	await expect(restored.resume(true)).rejects.toMatchObject({ code: "search-failed" });
	expect(restored.progress).toMatchObject({ state: "error", completed: 1, total: 3 });
	offline = false; await new Promise(resolve => setTimeout(resolve, 60)); expect(attempts).toHaveLength(2);
	await restored.resume(true);
	expect(attempts.slice(2)).toEqual([expect.stringContaining("latest pending"), expect.stringContaining("latest new")]);
	expect(restored.progress).toMatchObject({ state: "complete", completed: 3, total: 3 }); restored.dispose();
});

});
