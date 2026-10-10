import { describe, expect, it, vi } from "vitest";
import type { App, PluginManifest } from "obsidian";
import { AiHelperPlugin } from "../src/main";
import { DEFAULT_SETTINGS } from "../src/settings";
import { VIEW_TYPE_CHAT } from "../src/chat-view";
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
			: () => command.mock.calls[0][0].callback!();

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
		expect(registerView).toHaveBeenCalledTimes(1);
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
