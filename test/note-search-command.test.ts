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
