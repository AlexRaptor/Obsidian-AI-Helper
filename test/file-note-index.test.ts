import { expect, it, vi } from "vitest";
import { createNoteSearch } from "../src/note-index";
import { createServerClient } from "../src/server-client";
import { fileIndexAdapter } from "./helpers/file-index";

const connection = { embeddingServerUrl: "http://s/v1", embeddingApiKey: "", embeddingModel: "e", autoUpdateNotes: false };
it("restores searchable file-backed work without local storage and clears only derived data", async () => {
	const adapter = fileIndexAdapter();
	const notes = new Map([["Train.md", "The train departs at 18:30."]]);
	const client = createServerClient(async () => new Response(JSON.stringify({ data: [{ index: 0, embedding: [1, 0] }] })));
	const environment = { client, factory: undefined, vaultPath: "/files", storageMode: "file" as const, fileStorage: { adapter, directory: ".obsidian/plugins/obsidian-ai-helper/note-index" }, list: () => [...notes.keys()], read: async (path: string) => notes.get(path) ?? null, open: async () => {} };
	const first = createNoteSearch(environment); first.configure(connection); await first.indexVault(); first.dispose();
	const restored = createNoteSearch(environment); restored.configure(connection); await restored.restore();
	expect(restored.progress).toMatchObject({ state: "complete", completed: 1, total: 1 });
	expect(await restored.search("train")).toMatchObject({ path: "Train.md", text: expect.stringContaining("18:30") });
	await restored.clear();
	await expect(restored.search("train")).rejects.toMatchObject({ code: "search-rebuild" });
	expect(notes.get("Train.md")).toBe("The train departs at 18:30.");
	restored.dispose();
});

it("requires rebuilding on every storage switch, including a switch back to saved local work", async () => {
	const { IDBFactory } = await import("fake-indexeddb");
	const adapter = fileIndexAdapter();
	const client = createServerClient(async () => new Response(JSON.stringify({ data: [{ index: 0, embedding: [1, 0] }] })));
	const search = createNoteSearch({ client, factory: new IDBFactory(), vaultPath: "/switch", fileStorage: { adapter, directory: ".obsidian/plugins/obsidian-ai-helper/note-index" }, list: () => ["Train.md"], read: async () => "Train at 18:30", open: async () => {} });
	search.configure(connection); await search.indexVault();
	await search.switchStorage("file");
	expect(search.progress).toMatchObject({ state: "idle", completed: 0, total: 1 });
	await expect(search.search("train")).rejects.toMatchObject({ code: "search-rebuild" });
	await search.rebuild(); expect(await search.search("train")).toMatchObject({ path: "Train.md" });
	await search.switchStorage("local");
	await expect(search.search("train")).rejects.toMatchObject({ code: "search-rebuild" });
	search.dispose();
});

it("reports unavailable selected files in coverage and never reads a ready local index", async () => {
	const { IDBFactory } = await import("fake-indexeddb");
	const adapter = fileIndexAdapter(); const factory = new IDBFactory();
	const client = createServerClient(async () => new Response(JSON.stringify({ data: [{ index: 0, embedding: [1, 0] }] })));
	const environment = { client, factory, vaultPath: "/unavailable", fileStorage: { adapter, directory: ".obsidian/plugins/obsidian-ai-helper/note-index" }, list: () => ["Train.md"], read: async () => "Train at 18:30", open: async () => {} };
	const local = createNoteSearch(environment); local.configure(connection); await local.indexVault(); local.dispose();
	adapter.setUnavailable(true);
	const files = createNoteSearch({ ...environment, storageMode: "file" }); files.configure(connection);
	await expect(files.restore()).rejects.toMatchObject({ code: "search-storage" });
	expect(files.progress).toMatchObject({ state: "error", error: "search-storage" });
	await expect(files.search("train")).rejects.toMatchObject({ code: "search-storage" });
	files.dispose();
	const unavailableLocal = createNoteSearch({ ...environment, factory: undefined }); unavailableLocal.configure(connection);
	await expect(unavailableLocal.restore()).rejects.toMatchObject({ code: "search-storage" });
	expect(unavailableLocal.progress).toMatchObject({ state: "error", error: "search-storage" }); unavailableLocal.dispose();
});

it("lets the user rebuild corrupt derived files without modifying notes or Git settings", async () => {
	const adapter = fileIndexAdapter();
	adapter.files.set(".obsidian/plugins/obsidian-ai-helper/note-index/index.json", "corrupt");
	adapter.files.set(".gitignore", "existing-rule\n");
	adapter.files.set("Train.md", "Train at 18:30");
	const client = createServerClient(async () => new Response(JSON.stringify({ data: [{ index: 0, embedding: [1, 0] }] })));
	const search = createNoteSearch({ client, factory: undefined, vaultPath: "/corrupt", storageMode: "file", fileStorage: { adapter, directory: ".obsidian/plugins/obsidian-ai-helper/note-index" }, list: () => ["Train.md"], read: path => adapter.read(path), open: async () => {} });
	search.configure(connection); await expect(search.restore()).rejects.toMatchObject({ code: "search-storage" });
	await search.rebuild();
	expect(await search.search("train")).toMatchObject({ path: "Train.md" });
	expect(adapter.files.get("Train.md")).toBe("Train at 18:30"); expect(adapter.files.get(".gitignore")).toBe("existing-rule\n"); search.dispose();
});

it("treats a moved vault as a new index rather than reusing copied file results", async () => {
	const adapter = fileIndexAdapter();
	const client = createServerClient(async () => new Response(JSON.stringify({ data: [{ index: 0, embedding: [1, 0] }] })));
	const environment = { client, factory: undefined, vaultPath: "/old", storageMode: "file" as const, fileStorage: { adapter, directory: ".obsidian/plugins/obsidian-ai-helper/note-index" }, list: () => ["Train.md"], read: async () => "Train at 18:30", open: async () => {} };
	const old = createNoteSearch(environment); old.configure(connection); await old.indexVault(); old.dispose();
	const moved = createNoteSearch({ ...environment, vaultPath: "/new" }); moved.configure(connection); await moved.restore();
	expect(moved.progress).toMatchObject({ state: "idle", completed: 0, total: 1 });
	await expect(moved.search("train")).rejects.toMatchObject({ code: "search-rebuild" });
	await moved.rebuild(); expect(await moved.search("train")).toMatchObject({ path: "Train.md" }); moved.dispose();
});

it("recovers completed work when publishing a new file snapshot is interrupted", async () => {
	const adapter = fileIndexAdapter(); const inputs: string[] = [];
	const notes = new Map([["Ready.md", "ready"], ["Pending.md", "original"]]);
	const client = createServerClient(async (_url, init) => {
		inputs.push(...JSON.parse(String(init?.body)).input);
		return new Response(JSON.stringify({ data: [{ index: 0, embedding: [1, 0] }] }));
	});
	let interrupt = false;
	const originalRename = adapter.rename;
	adapter.rename = async (from, to) => { if (interrupt && from.endsWith(".tmp")) throw new Error("Interrupted publication"); await originalRename(from, to); };
	const environment = { client, factory: undefined, vaultPath: "/interrupted", storageMode: "file" as const, fileStorage: { adapter, directory: ".obsidian/plugins/obsidian-ai-helper/note-index" }, list: () => [...notes.keys()], read: async (path: string) => notes.get(path) ?? null, open: async () => {} };
	const search = createNoteSearch(environment); search.configure(connection); await search.indexVault();
	interrupt = true; notes.set("Pending.md", "latest text");
	await expect(search.changed("Pending.md")).rejects.toMatchObject({ code: "search-storage" }); search.dispose();
	interrupt = false; const restored = createNoteSearch(environment); restored.configure(connection); await restored.restore();
	expect(restored.progress).toMatchObject({ completed: 1, total: 2 });
	await restored.resume(true);
	expect(inputs).toHaveLength(3); expect(inputs[2]).toContain("latest text");
	expect(restored.progress.state).toBe("complete"); restored.dispose();
});

it.each(["local", "file"] as const)("keeps %s storage empty after deletion during automatic indexing and a late model response", async mode => {
	const { IDBFactory } = await import("fake-indexeddb");
	let finish!: (response: Response) => void; let requests = 0;
	const response = () => new Response(JSON.stringify({ data: [{ index: 0, embedding: [1, 0] }] }));
	const client = createServerClient(async () => { requests++; return requests === 2 ? new Promise<Response>(resolve => { finish = resolve; }) : response(); });
	const notes = new Map([["Ready.md", "ready"], ["Pending.md", "pending"]]);
	const environment = { client, factory: new IDBFactory(), vaultPath: "/delete-active", storageMode: mode, fileStorage: { adapter: fileIndexAdapter(), directory: ".obsidian/plugins/obsidian-ai-helper/note-index" }, list: () => [...notes.keys()], read: async (path: string) => notes.get(path) ?? null, open: async () => {} };
	const search = createNoteSearch(environment); search.configure({ ...connection, autoUpdateNotes: true, noteUpdateDelaySeconds: 0.01 });
	const indexing = search.indexVault().catch(error => error);
	await vi.waitFor(() => expect(requests).toBe(2));
	await search.clear(); finish(response()); expect(await indexing).toMatchObject({ code: "search-rebuild" });
	notes.set("Pending.md", "new text after deletion"); await search.changed("Pending.md");
	await new Promise(resolve => setTimeout(resolve, 40));
	expect(requests).toBe(2); expect(search.progress).toMatchObject({ state: "idle", completed: 0, total: 2 });
	await expect(search.search("ready")).rejects.toMatchObject({ code: "search-rebuild" }); search.dispose();
	const restored = createNoteSearch(environment); restored.configure(connection); await restored.restore(); await restored.resume();
	expect(restored.progress).toMatchObject({ state: "idle", completed: 0 }); expect(requests).toBe(2); restored.dispose();
});

it("restores the previous single-file format and preserves it when saving a pause in the new format", async () => {
	const adapter = fileIndexAdapter();
	// A complete index in the format used by the previous release.
	const fingerprint = "1d500f12ce4c02d88443a2596ab5a849c13ed0c672a436f7f49c72e41b7b59bd";
	adapter.files.set(".obsidian/plugins/obsidian-ai-helper/note-index/index.json", JSON.stringify({ format: 1,
		vault: "c73272cf05cadf8ef7b0f813e2182e97a2f755b76e4115cef74f6ab4979aab74", entries: [
			["progress", { fingerprint, state: "complete", completed: 1, total: 1 }],
			["updates", { initialized: true, pending: [], failed: false, paused: false }],
			["Train.md", { path: "Train.md", contentHash: "66ee1cb237c6384849229bb4fd7272d039a92379362e45e529c55a48598e4d74", fingerprint, fragments: [{ text: "Train\nTrain.md\n\nTrain at 18:30", headings: [], vector: [1, 0] }] }],
		] }));
	let requests = 0;
	const client = createServerClient(async () => { requests++; return new Response(JSON.stringify({ data: [{ index: 0, embedding: [1, 0] }] })); });
	const environment = { client, factory: undefined, vaultPath: "/legacy-files", storageMode: "file" as const, fileStorage: { adapter, directory: ".obsidian/plugins/obsidian-ai-helper/note-index" }, list: () => ["Train.md"], read: async () => "Train at 18:30", open: async () => {} };
	const search = createNoteSearch(environment); search.configure(connection); await search.restore();
	expect(search.progress).toMatchObject({ state: "complete", completed: 1, total: 1 });
	await search.pause(); search.dispose();
	const restored = createNoteSearch(environment); restored.configure(connection); await restored.restore(); await restored.resume();
	expect(restored.progress).toMatchObject({ state: "paused", completed: 1, total: 1 }); expect(requests).toBe(0);
	expect(await restored.search("train")).toMatchObject({ path: "Train.md", text: expect.stringContaining("18:30") }); restored.dispose();
});
