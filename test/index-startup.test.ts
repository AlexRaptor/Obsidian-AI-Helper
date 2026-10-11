import { afterEach, expect, it, vi } from "vitest";
import { FileSystemAdapter, type App, type PluginManifest } from "obsidian";
import { IDBFactory } from "fake-indexeddb";
import { AiHelperPlugin } from "../src/main";
import { createNoteSearch } from "../src/note-index";
import { createServerClient } from "../src/server-client";
import { DEFAULT_SETTINGS } from "../src/settings";
import { deferred } from "./helpers/obsidian";
vi.mock("obsidian", async () => import("./helpers/obsidian"));
afterEach(() => { vi.unstubAllGlobals(); vi.restoreAllMocks(); });

it("loads promptly on repeated starts after an excluded-folder rename without waiting for note reads", async () => {
	const factory = new IDBFactory(); vi.stubGlobal("indexedDB", factory);
	const settings = { ...DEFAULT_SETTINGS, embeddingServerUrl: "http://s/v1", embeddingModel: "e", excludedFolders: ["Private"] };
	const client = createServerClient(async url => new Response(JSON.stringify(url.endsWith("/models") ? { data: [] } : { data: [{ index: 0, embedding: [1, 0] }] })));
	const indexed = createNoteSearch({ factory, vaultPath: "/startup", client, list: () => ["Train.md"], read: async () => "train", open: async () => {} });
	indexed.configure(settings); await indexed.indexVault();
	settings.excludedFolders = await indexed.renamed("Secrets", "Private"); indexed.dispose();
	for (let attempt = 0; attempt < 2; attempt++) {
		const adapter = new FileSystemAdapter(); adapter.getBasePath = () => "/startup";
		const note = { path: "Train.md", extension: "md" };
		const reading = deferred<string>();
		const read = vi.fn(() => reading.promise);
		let ready!: () => void;
		const app = { vault: { adapter, getFileByPath: () => note, getMarkdownFiles: () => [note], read },
			workspace: { onLayoutReady: (callback: () => void) => { ready = callback; }, detachLeavesOfType: () => {} } } as unknown as App;
		const plugin = new AiHelperPlugin(app, {} as PluginManifest); plugin.serverClient = client;
		vi.spyOn(plugin, "loadData").mockResolvedValue(settings);
		const registerView = vi.spyOn(plugin, "registerView");
		let loaded = false; const loading = plugin.onload().then(() => { loaded = true; });
		try {
			await vi.waitFor(() => expect(loaded).toBe(true), { timeout: 200 });
			expect(registerView).toHaveBeenCalledOnce(); expect(read).not.toHaveBeenCalled();
			ready(); await vi.waitFor(() => expect(read).toHaveBeenCalled());
		} finally { reading.resolve("train"); await loading; plugin.onunload(); }
	}
});
it("keeps a complete saved index when the vault file list is incomplete until layout readiness", async () => {
	const factory = new IDBFactory(); vi.stubGlobal("indexedDB", factory);
	const settings = { ...DEFAULT_SETTINGS, embeddingServerUrl: "http://s/v1", embeddingModel: "e", excludedFolders: ["Secrets"] };
	const paths = Array.from({ length: 399 }, (_, index) => `Notes/${index}.md`);
	let embeddings = 0;
	const client = createServerClient(async url => {
		if (url.endsWith("/models")) return new Response(JSON.stringify({ data: [] }));
		embeddings++; return new Response(JSON.stringify({ data: [{ index: 0, embedding: [1, 0] }] }));
	});
	const indexed = createNoteSearch({ factory, vaultPath: "/complete-startup", client, list: () => paths, read: async path => path, open: async () => {} });
	indexed.configure(settings); await indexed.indexVault(); indexed.dispose(); embeddings = 0;
	const adapter = new FileSystemAdapter(); adapter.getBasePath = () => "/complete-startup";
	let visiblePaths = paths.slice(0, 359); let ready!: () => void;
	const file = (path: string) => ({ path, extension: "md" });
	const app = { vault: { adapter, getMarkdownFiles: () => visiblePaths.map(file), getFileByPath: (path: string) => visiblePaths.includes(path) ? file(path) : null, read: async (note: { path: string }) => note.path },
		workspace: { onLayoutReady: (callback: () => void) => { ready = callback; }, detachLeavesOfType: () => {} } } as unknown as App;
	const plugin = new AiHelperPlugin(app, {} as PluginManifest); plugin.serverClient = client;
	vi.spyOn(plugin, "loadData").mockResolvedValue(settings);
	try {
		await plugin.onload(); visiblePaths = paths; ready();
		await vi.waitFor(() => expect(plugin.noteSearch.progress).toMatchObject({ state: "complete", completed: 399, total: 399 }), { timeout: 3000 });
		expect(embeddings).toBe(0);
	} finally { plugin.onunload(); }
});
it("finishes restoring and keeps automation available after a rename during restoration", async () => {
	const factory = new IDBFactory(); vi.stubGlobal("indexedDB", factory);
	const settings = { ...DEFAULT_SETTINGS, embeddingServerUrl: "http://s/v1", embeddingModel: "e", excludedFolders: ["Private"], noteUpdateDelaySeconds: 0.01 };
	const inputs: string[] = [];
	const client = createServerClient(async (url, init) => {
		if (url.endsWith("/models")) return new Response(JSON.stringify({ data: [] }));
		const { input } = JSON.parse(String(init?.body)); inputs.push(...input);
		return new Response(JSON.stringify({ data: [{ index: 0, embedding: [1, 0] }] }));
	});
	const indexed = createNoteSearch({ factory, vaultPath: "/rename-startup", client, list: () => ["Train.md"], read: async () => "train", open: async () => {} });
	indexed.configure(settings); await indexed.indexVault(); indexed.dispose(); inputs.length = 0;
	const adapter = new FileSystemAdapter(); adapter.getBasePath = () => "/rename-startup";
	const handlers = new Map<string, (...args: any[]) => void>();
	const on = (event: string, callback: (...args: any[]) => void) => { handlers.set(event, callback); return {}; };
	let text = "train"; let ready!: () => void;
	const app = { vault: { adapter, on, getMarkdownFiles: () => [{ path: "Train.md", extension: "md" }], getFileByPath: () => ({ path: "Train.md", extension: "md" }), read: async () => text },
		workspace: { on, onLayoutReady: (callback: () => void) => { ready = callback; }, detachLeavesOfType: () => {} } } as unknown as App;
	const plugin = new AiHelperPlugin(app, {} as PluginManifest); plugin.serverClient = client;
	vi.spyOn(plugin, "loadData").mockResolvedValue(settings); Object.assign(plugin, { saveData: async () => {} });
	try {
		await plugin.onload(); ready(); handlers.get("rename")!({ path: "Secrets" }, "Private");
		await vi.waitFor(() => expect(plugin.noteSearch.progress).toMatchObject({ state: "complete", completed: 1, total: 1 }));
		expect(inputs).toHaveLength(0);
		text = "updated after rename"; await plugin.noteSearch.changed("Train.md");
		await vi.waitFor(() => expect(inputs).toHaveLength(1));
		expect(inputs[0]).toContain("updated after rename");
	} finally { plugin.onunload(); }
});
it.each(["note", "vault"] as const)("keeps the saved index when an awaited %s command outlives plugin unloading", async action => {
	const factory = new IDBFactory(); vi.stubGlobal("indexedDB", factory);
	const settings = { ...DEFAULT_SETTINGS, embeddingServerUrl: "http://s/v1", embeddingModel: "e" };
	let embeddings = 0;
	const client = createServerClient(async url => {
		if (url.endsWith("/models")) return new Response(JSON.stringify({ data: [] }));
		embeddings++; return new Response(JSON.stringify({ data: [{ index: 0, embedding: [1, 0] }] }));
	});
	const environment = { factory, vaultPath: "/command-unload", client, list: () => ["Train.md"], read: async () => "train", open: async () => {} };
	const indexed = createNoteSearch(environment); indexed.configure(settings); await indexed.indexVault(); indexed.dispose(); embeddings = 0;
	const adapter = new FileSystemAdapter(); adapter.getBasePath = () => "/command-unload";
	const reading = deferred<string>(); const read = vi.fn(() => reading.promise); let ready!: () => void;
	const app = { vault: { adapter, getMarkdownFiles: () => [{ path: "Train.md", extension: "md" }], getFileByPath: () => ({ path: "Train.md", extension: "md" }), read },
		workspace: { onLayoutReady: (callback: () => void) => { ready = callback; }, detachLeavesOfType: () => {} } } as unknown as App;
	const plugin = new AiHelperPlugin(app, {} as PluginManifest); plugin.serverClient = client;
	vi.spyOn(plugin, "loadData").mockResolvedValue(settings);
	await plugin.onload(); ready(); await vi.waitFor(() => expect(read).toHaveBeenCalled());
	const indexing = action === "note" ? plugin.indexNote("Train.md") : plugin.manageNoteIndex("index");
	plugin.onunload(); reading.resolve("train"); await indexing;
	const reopened = createNoteSearch(environment); reopened.configure(settings); await reopened.restore();
	expect(reopened.progress).toMatchObject({ state: "complete", completed: 1, total: 1 }); expect(embeddings).toBe(0); reopened.dispose();
});
