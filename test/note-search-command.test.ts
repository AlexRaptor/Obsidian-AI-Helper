import { afterEach, expect, it, vi } from "vitest";
import { FileSystemAdapter, type App, type PluginManifest } from "obsidian";
import { IDBFactory } from "fake-indexeddb";
import { AiHelperPlugin } from "../src/main";
import { createServerClient } from "../src/server-client";
import { DEFAULT_SETTINGS } from "../src/settings";
import { Notice } from "./helpers/obsidian";
vi.mock("obsidian", async () => import("./helpers/obsidian"));
afterEach(() => { vi.unstubAllGlobals(); vi.restoreAllMocks(); });

it("indexes only on the explicit active-note command through the public module", async () => {
	vi.stubGlobal("indexedDB", new IDBFactory());
	const adapter = new FileSystemAdapter(); adapter.getBasePath = () => "/command-vault";
	const file = { path: "Train.md", extension: "md" };
	const read = vi.fn(async () => "Train departs at 18:30.");
	const app = { vault: { adapter, getFileByPath: () => file, read }, workspace: { getActiveFile: () => file } } as unknown as App;
	const plugin = new AiHelperPlugin(app, {} as PluginManifest);
	vi.spyOn(plugin, "loadData").mockResolvedValue({ ...DEFAULT_SETTINGS, embeddingServerUrl: "http://s/v1", embeddingModel: "e" });
	let embeddings = 0;
	plugin.serverClient = createServerClient(async (url) => new Response(JSON.stringify(url.endsWith("/models")
		? { data: [{ id: "e" }] }
		: { data: [{ index: 0, embedding: ++embeddings === 1 ? [1, 0] : [0.6, 0.8] }] })));
	const save = vi.fn(async () => {}); Object.assign(plugin, { saveData: save });
	const commands = vi.spyOn(plugin, "addCommand"); await plugin.onload(); expect(read).not.toHaveBeenCalled();
	const command = commands.mock.calls.find(([command]) => command.id === "index-active-note")![0];
	Notice.messages.length = 0; command.callback!();
	await vi.waitFor(() => expect(Notice.messages.join(" ")).toContain("Note indexed locally"));
	expect(await plugin.noteSearch.search("When?")).toMatchObject({ path: "Train.md", text: "Train\nTrain.md\n\nTrain departs at 18:30." });
	plugin.settings.noteSearchMinSimilarity = 0.7; await plugin.saveSettings();
	expect(await plugin.noteSearch.search("When?")).toBeNull();
	plugin.settings.noteSearchMinSimilarity = 0.5; await plugin.saveSettings();
	expect(await plugin.noteSearch.search("When?")).toMatchObject({ path: "Train.md", text: "Train\nTrain.md\n\nTrain departs at 18:30." });
	expect(save).toHaveBeenLastCalledWith(expect.objectContaining({ noteSearchMinSimilarity: 0.5 }));
});

it("exposes vault indexing, clearing and rebuilding with server disclosure", async () => {
	vi.stubGlobal("indexedDB", new IDBFactory());
	const adapter = new FileSystemAdapter(); adapter.getBasePath = () => "/vault-commands";
	const files = [{ path: "Travel/Train.md", extension: "md" }, { path: "Private/Secret.md", extension: "md" }];
	const read = vi.fn(async (_file: { path: string }) => "Train at 18:30");
	const app = { vault: { adapter, getFileByPath: (path: string) => files.find((f) => f.path === path), getMarkdownFiles: () => files, read }, workspace: { detachLeavesOfType: () => {} } } as unknown as App;
	const plugin = new AiHelperPlugin(app, {} as PluginManifest);
	vi.spyOn(plugin, "loadData").mockResolvedValue({ ...DEFAULT_SETTINGS, embeddingServerUrl: "http://embeddings/v1", embeddingModel: "e", serverUrl: "http://conversation/v1", excludedFolders: ["Private"] });
	plugin.serverClient = createServerClient(async (url) => new Response(JSON.stringify(url.endsWith("/models") ? { data: [] } : { data: [{ index: 0, embedding: [1, 0] }] })));
	const commands = vi.spyOn(plugin, "addCommand"); await plugin.onload();
	const invoke = (id: string) => commands.mock.calls.find(([command]) => command.id === id)![0].callback!();
	Notice.messages.length = 0; invoke("index-vault");
	await vi.waitFor(() => expect(plugin.noteSearch.progress.state).toBe("complete"));
	expect(Notice.messages.join(" ")).toContain("http://embeddings/v1");
	expect(Notice.messages.join(" ")).toContain("http://conversation/v1");
	expect(read.mock.calls.every(([file]) => file.path === "Travel/Train.md")).toBe(true);
	invoke("clear-note-index");
	await vi.waitFor(() => expect(Notice.messages.join(" ")).toContain("Index deleted"));
	await expect(plugin.noteSearch.search("When?")).rejects.toMatchObject({ code: "search-rebuild" });
	invoke("rebuild-note-index");
	await vi.waitFor(() => expect(plugin.noteSearch.progress.state).toBe("complete"));
	expect(await plugin.noteSearch.search("When?")).toMatchObject({ path: "Travel/Train.md" });
	plugin.onunload();
});
