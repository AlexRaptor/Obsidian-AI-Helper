import { afterEach, expect, it, vi } from "vitest";
import { FileSystemAdapter, Menu, TFile, TFolder, type App, type PluginManifest } from "obsidian";
import { IDBFactory } from "fake-indexeddb";
import { AiHelperPlugin } from "../src/main";
import { createServerClient } from "../src/server-client";
import { AiHelperSettingsTab, DEFAULT_SETTINGS } from "../src/settings";
import { en, ru } from "../src/i18n";
import { Notice } from "./helpers/obsidian";
vi.mock("obsidian", async () => import("./helpers/obsidian"));
afterEach(() => { vi.unstubAllGlobals(); vi.restoreAllMocks(); });

it.each([
	{ path: "Private", folders: ["Other"], language: "en", excluded: false },
	{ path: "Private", folders: [" /Private/ ", "Private", "Other"], language: "ru", excluded: true },
	{ path: "/", folders: ["/", "Other"], language: "en", excluded: true },
	{ path: "Private/Nested", folders: ["Private", "Other"], language: "ru", excluded: false },
] as const)("changes folder exclusions from the menu: $path, $language, excluded=$excluded", async ({ path, folders, language, excluded }) => {
	vi.stubGlobal("indexedDB", new IDBFactory());
	const handlers = new Map<string, (...args: any[]) => void>();
	const on = (event: string, callback: (...args: any[]) => void) => { handlers.set(event, callback); return {}; };
	const app = { vault: { on, getMarkdownFiles: () => [] }, workspace: { on, detachLeavesOfType: () => {} } } as unknown as App;
	const plugin = new AiHelperPlugin(app, {} as PluginManifest);
	vi.spyOn(plugin, "loadData").mockResolvedValue({ ...DEFAULT_SETTINGS, language, excludedFolders: [...folders] });
	vi.spyOn(plugin, "refreshModels").mockResolvedValue();
	vi.spyOn(plugin, "refreshEmbeddingModels").mockResolvedValue();
	const save = vi.fn(async () => {}); Object.assign(plugin, { saveData: save });
	const refresh = vi.spyOn(AiHelperSettingsTab.prototype, "refreshExcludedFolders");
	await plugin.onload();
	const folder = Object.assign(new TFolder(), { path });
	const menu = () => {
		const result = new Menu(); handlers.get("file-menu")!(result, folder);
		return (result as unknown as { items: Array<{ title: string; callback: () => void }> }).items.filter(item => [en["folder-menu-include"], en["folder-menu-exclude"], ru["folder-menu-include"], ru["folder-menu-exclude"]].some(title => title === item.title));
	};
	const dictionary = language === "ru" ? ru : en;
	const first = menu();
	expect(first).toHaveLength(1);
	expect(first[0].title).toBe(dictionary[excluded ? "folder-menu-include" : "folder-menu-exclude"]);
	first[0].callback();
	const remaining = folders.filter(folder => folder.trim().replace(/^\/+|\/+$/g, "") !== path.replace(/^\/+|\/+$/g, ""));
	const expected = excluded ? remaining : [...remaining, path];
	expect(plugin.settings.excludedFolders).toEqual(expected);
	expect(plugin.noteSearch.excludedFolders).toEqual(expected.map(folder => folder === "/" ? "" : folder));
	expect(refresh).toHaveBeenCalledOnce();
	await vi.waitFor(() => expect(save).toHaveBeenCalledWith(expect.objectContaining({ excludedFolders: expected })));
	const second = menu();
	expect(second[0].title).toBe(dictionary[excluded ? "folder-menu-exclude" : "folder-menu-include"]);
	second[0].callback();
	expect(plugin.settings.excludedFolders).toEqual(excluded ? [...remaining, path] : remaining);
	const attachmentMenu = new Menu();
	handlers.get("file-menu")!(attachmentMenu, Object.assign(new TFile(), { path: "Image.png", extension: "png" }));
	expect((attachmentMenu as unknown as { items: unknown[] }).items).toHaveLength(0);
	plugin.onunload();
	second[0].callback();
	expect(refresh).toHaveBeenCalledTimes(2);
});

it("indexes only on the explicit active-note command through the public module", async () => {
	vi.stubGlobal("indexedDB", new IDBFactory());
	const adapter = new FileSystemAdapter(); adapter.getBasePath = () => "/command-vault";
	const file = { path: "Train.md", extension: "md" };
	const read = vi.fn(async () => "Train departs at 18:30.");
	const app = { vault: { adapter, getFileByPath: () => file, getMarkdownFiles: () => [file], read }, workspace: { getActiveFile: () => file } } as unknown as App;
	const plugin = new AiHelperPlugin(app, {} as PluginManifest);
	vi.spyOn(plugin, "loadData").mockResolvedValue({ ...DEFAULT_SETTINGS, embeddingServerUrl: "http://s/v1", embeddingModel: "e", noteUpdateDelaySeconds: 0.35 });
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

it("indexes the vault from scratch with one command and server disclosure", async () => {
	vi.stubGlobal("indexedDB", new IDBFactory());
	const adapter = new FileSystemAdapter(); adapter.getBasePath = () => "/vault-commands";
	const files = [{ path: "Travel/Train.md", extension: "md" }, { path: "Private/Secret.md", extension: "md" }];
	const read = vi.fn(async (_file: { path: string }) => "Train at 18:30");
	const app = { vault: { adapter, getFileByPath: (path: string) => files.find((f) => f.path === path), getMarkdownFiles: () => files, read }, workspace: { detachLeavesOfType: () => {} } } as unknown as App;
	const plugin = new AiHelperPlugin(app, {} as PluginManifest);
	vi.spyOn(plugin, "loadData").mockResolvedValue({ ...DEFAULT_SETTINGS, embeddingServerUrl: "http://embeddings/v1", embeddingModel: "e", serverUrl: "http://conversation/v1", excludedFolders: ["Private"] });
	let hold = false;
	let finish: ((response: Response) => void) | undefined;
	plugin.serverClient = createServerClient(async (url) => {
		if (hold && url.endsWith("/embeddings")) return new Promise<Response>((resolve) => { finish = resolve; });
		return new Response(JSON.stringify(url.endsWith("/models") ? { data: [] } : { data: [{ index: 0, embedding: [1, 0] }] }));
	});
	const commands = vi.spyOn(plugin, "addCommand"); await plugin.onload();
	const invoke = (id: string) => commands.mock.calls.find(([command]) => command.id === id)![0].callback!();
	Notice.messages.length = 0; invoke("index-vault");
	await vi.waitFor(() => expect(plugin.noteSearch.progress.state).toBe("complete"));
	expect(Notice.messages.join(" ")).toContain("http://embeddings/v1");
	expect(Notice.messages.join(" ")).toContain("http://conversation/v1");
	expect(read.mock.calls.every(([file]) => file.path === "Travel/Train.md")).toBe(true);
	expect(commands.mock.calls.some(([command]) => command.id === "rebuild-note-index")).toBe(false);
	hold = true; invoke("index-vault");
	await vi.waitFor(() => expect(finish).toBeDefined());
	await expect(plugin.noteSearch.search("When?")).rejects.toMatchObject({ code: "search-rebuild" });
	hold = false;
	finish!(new Response(JSON.stringify({ data: [{ index: 0, embedding: [1, 0] }] })));
	await vi.waitFor(() => expect(plugin.noteSearch.progress.state).toBe("complete"));
	expect(await plugin.noteSearch.search("When?")).toMatchObject({ path: "Travel/Train.md" });
	invoke("clear-note-index");
	await vi.waitFor(() => expect(Notice.messages.join(" ")).toContain("Index deleted"));
	await expect(plugin.noteSearch.search("When?")).rejects.toMatchObject({ code: "search-rebuild" });
	invoke("index-vault");
	await vi.waitFor(() => expect(plugin.noteSearch.progress.state).toBe("complete"));
	expect(await plugin.noteSearch.search("When?")).toMatchObject({ path: "Travel/Train.md" });
	plugin.onunload();
});


it("updates through vault events and indexes the menu-selected file rather than the active note", async () => {
	vi.stubGlobal("indexedDB", new IDBFactory());
	const adapter = new FileSystemAdapter(); adapter.getBasePath = () => "/event-vault";
	const file = Object.assign(new TFile(), { path: "Train.md", extension: "md" });
	const other = Object.assign(new TFile(), { path: "Other.md", extension: "md" });
	const files = [file, other]; let text = "initial train";
	const handlers = new Map<string, (...args: any[]) => void>();
	const on = (event: string, callback: (...args: any[]) => void) => { handlers.set(event, callback); return {}; };
	const app = { vault: { adapter, on, getFileByPath: (path: string) => files.find(f => f.path === path), getMarkdownFiles: () => files,
		read: async (f: TFile) => f === file ? text : "boat" }, workspace: { on, getActiveFile: () => other, detachLeavesOfType: () => {} } } as unknown as App;
	const plugin = new AiHelperPlugin(app, {} as PluginManifest);
	vi.spyOn(plugin, "loadData").mockResolvedValue({ ...DEFAULT_SETTINGS, embeddingServerUrl: "http://s/v1", embeddingModel: "e", noteUpdateDelaySeconds: 0.35 });
	const inputs: string[] = [];
	plugin.serverClient = createServerClient(async (url, init) => {
		if (url.endsWith("/models")) return new Response(JSON.stringify({ data: [] }));
		const { input } = JSON.parse(String(init?.body)); inputs.push(...input);
		return new Response(JSON.stringify({ data: [{ index: 0, embedding: input[0].includes("boat") ? [0, 1] : [1, 0] }] }));
	});
	await plugin.onload(); await plugin.noteSearch.indexVault(); inputs.length = 0;
	text = "updated train"; handlers.get("modify")!(file);
	await vi.waitFor(() => expect(inputs).toHaveLength(1));
	await vi.waitFor(() => expect(plugin.noteSearch.progress.state).toBe("complete"));
	expect(inputs[0]).toContain("updated train");
	plugin.settings.autoUpdateNotes = false; Object.assign(plugin, { saveData: async () => {} }); await plugin.saveSettings();
	text = "manual train"; handlers.get("modify")!(file);
	let click!: () => void;
	const item = { setTitle: () => item, setIcon: () => item, onClick: (callback: () => void) => { click = callback; return item; } };
	handlers.get("file-menu")!({ addItem: (callback: (item: unknown) => void) => callback(item) }, file);
	inputs.length = 0; Notice.messages.length = 0; click();
	await vi.waitFor(() => expect(Notice.messages.join(" ")).toContain("Note indexed locally"));
	expect(inputs).toHaveLength(1); expect(inputs[0]).toContain("manual train"); expect(inputs[0]).not.toContain("boat"); plugin.onunload();
});
