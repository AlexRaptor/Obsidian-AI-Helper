import { describe, expect, it, vi } from "vitest";
import type { App, PluginManifest } from "obsidian";
import { AiHelperPlugin } from "../src/main";
import { DEFAULT_SETTINGS } from "../src/settings";
import { ChatView, VIEW_TYPE_CHAT } from "../src/chat-view";
import { deferred, flushPromises } from "./helpers/obsidian";
import type { ServerClientResult } from "../src/server-client";

vi.mock("obsidian", async () => import("./helpers/obsidian"));

describe("chat toggle", () => {
	it.each(["ribbon", "command"])("opens, closes and reopens the sidebar through %s", async (trigger) => {
		const leaf = { detach: vi.fn(() => { leaves = []; }) };
		let leaves: typeof leaf[] = [];
		const workspace = {
			getLeavesOfType: vi.fn(() => leaves),
			ensureSideLeaf: vi.fn(async () => { leaves = [leaf]; }),
			revealLeaf: vi.fn(),
		};
		const plugin = new AiHelperPlugin({ workspace } as unknown as App, {} as PluginManifest);
		const ribbon = vi.spyOn(plugin, "addRibbonIcon");
		const command = vi.spyOn(plugin, "addCommand");
		await plugin.onload();
		const toggle = trigger === "ribbon"
			? () => ribbon.mock.calls[0][2]({} as MouseEvent)
			: () => command.mock.calls.find(([c]) => c.id === "toggle-view")![0].callback!();

		await toggle();
		expect(workspace.ensureSideLeaf).toHaveBeenCalledWith(VIEW_TYPE_CHAT, "right", { active: true, reveal: true });
		expect(leaves).toHaveLength(1);
		await toggle();
		expect(leaf.detach).toHaveBeenCalledTimes(1);
		expect(leaves).toHaveLength(0);
		await toggle();
		expect(workspace.ensureSideLeaf).toHaveBeenCalledTimes(2);
		expect(leaves).toHaveLength(1);
	});
});

describe("plugin model loading", () => {
	it("registers the interface without waiting for the model server", async () => {
		const pending = deferred<ServerClientResult<string[]>>();
		const plugin = new AiHelperPlugin({} as App, {} as PluginManifest);
		vi.spyOn(plugin, "loadData").mockResolvedValue({ serverUrl: "http://s" });
		const registerView = vi.spyOn(plugin, "registerView");
		const addSettingTab = vi.spyOn(plugin, "addSettingTab");
		vi.spyOn(plugin.serverClient, "listModels").mockReturnValue(pending.promise);
		let loaded = false;
		const load = plugin.onload().then(() => { loaded = true; });
		await flushPromises();
		expect(loaded).toBe(true);
		expect(registerView).toHaveBeenCalledTimes(2);
		expect(addSettingTab).toHaveBeenCalledTimes(1);
		pending.resolve({ ok: true, value: ["m"] });
		await load;
		await flushPromises();
		expect(plugin.models).toEqual(["m"]);
	});

	it("ignores a stale model list after the server URL changes", async () => {
		const pending = deferred<ServerClientResult<string[]>>();
		const plugin = new AiHelperPlugin({} as App, {} as PluginManifest);
		plugin.settings = { ...DEFAULT_SETTINGS, serverUrl: "http://old" };
		vi.spyOn(plugin.serverClient, "listModels")
			.mockReturnValueOnce(pending.promise)
			.mockResolvedValueOnce({ ok: true, value: ["new-model"] });
		const old = plugin.refreshModels();
		plugin.settings.serverUrl = "http://new";
		await plugin.refreshModels();
		pending.resolve({ ok: true, value: ["old-model"] });
		await old;
		expect(plugin.models).toEqual(["new-model"]);
	});

	it("aborts model loading on unload and ignores the late result", async () => {
		const pending = deferred<ServerClientResult<string[]>>();
		const app = { workspace: { detachLeavesOfType: vi.fn() } } as unknown as App;
		const plugin = new AiHelperPlugin(app, {} as PluginManifest);
		plugin.settings = { ...DEFAULT_SETTINGS, serverUrl: "http://s" };
		const listModels = vi.spyOn(plugin.serverClient, "listModels").mockReturnValue(pending.promise);
		const refresh = plugin.refreshModels();
		plugin.onunload();
		expect(listModels.mock.calls[0][2]?.aborted).toBe(true);
		pending.resolve({ ok: true, value: ["late-model"] });
		await refresh;
		expect(plugin.models).toEqual([]);
	});
});


it("ignores an old embedding model list after the key changes and keeps the main model list independent", async () => {
	const pending = deferred<Response>();
	const fetch = vi.fn().mockReturnValueOnce(pending.promise).mockResolvedValueOnce(new Response(JSON.stringify({ data: [{ id: "new-embedding" }] })));
	vi.stubGlobal("fetch", fetch);
	try {
		const plugin = new AiHelperPlugin({} as App, {} as PluginManifest);
		plugin.settings = { ...DEFAULT_SETTINGS, embeddingServerUrl: "http://embed", embeddingApiKey: "old", model: "chat-model" };
		const first = plugin.refreshEmbeddingModels();
		plugin.settings.embeddingApiKey = "new";
		await plugin.refreshEmbeddingModels();
		pending.resolve(new Response(JSON.stringify({ data: [{ id: "old-embedding" }] })));
		await first;
		expect(plugin.embeddingModels).toEqual(["new-embedding"]);
		expect(plugin.embeddingModelStatus).toBe("loaded");
		expect(plugin.models).toEqual([]);
		expect(plugin.settings.model).toBe("chat-model");
	} finally { vi.unstubAllGlobals(); }
});


it("targets the active chat and disables commands when no matching state exists", async () => {
	const first = new ChatView({} as never, {} as never);
	const second = new ChatView({} as never, {} as never);
	vi.spyOn(first, "updateContextIndicators").mockImplementation(() => {});
	vi.spyOn(second, "updateContextIndicators").mockImplementation(() => {});
	let active: ChatView | null = second;
	let leaves = [{ view: first }, { view: second }];
	const workspace = { getActiveViewOfType: () => active, getLeavesOfType: () => leaves, revealLeaf: vi.fn(async () => {}), ensureSideLeaf: vi.fn(async () => ({ view: first })) };
	const plugin = new AiHelperPlugin({ workspace } as unknown as App, {} as PluginManifest);
	const commands = vi.spyOn(plugin, "addCommand"); await plugin.onload();
	const stop = commands.mock.calls.find(([command]) => command.id === "stop-generation")![0];
	const toggle = commands.mock.calls.find(([command]) => command.id === "toggle-note-search")![0];
	const cancel = vi.spyOn(second, "stopGeneration").mockImplementation(() => {});
	const generating = vi.spyOn(second, "isGenerating").mockReturnValue(false);
	expect(stop.checkCallback!(true)).toBe(false);
	generating.mockReturnValue(true); expect(stop.checkCallback!(true)).toBe(true); expect(cancel).not.toHaveBeenCalled();
	stop.checkCallback!(false); expect(cancel).toHaveBeenCalledOnce();
	const search = vi.spyOn(second, "toggleSearch").mockImplementation(() => {});
	expect(toggle.checkCallback!(true)).toBe(true); expect(search).not.toHaveBeenCalled();
	toggle.checkCallback!(false); expect(search).toHaveBeenCalledOnce();
	const clearFirst = vi.spyOn(first, "clearConversation").mockImplementation(() => {});
	const clearSecond = vi.spyOn(second, "clearConversation").mockImplementation(() => {});
	await plugin.newConversation(); expect(clearSecond).toHaveBeenCalledOnce(); expect(clearFirst).not.toHaveBeenCalled();
	active = null; leaves = []; expect(toggle.checkCallback!(true)).toBe(false); expect(stop.checkCallback!(true)).toBe(false);
	await plugin.newConversation(); expect(workspace.ensureSideLeaf).toHaveBeenCalledOnce(); expect(clearFirst).toHaveBeenCalledOnce();
});
