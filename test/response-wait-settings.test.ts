import { afterEach, expect, it, vi } from "vitest";
import type { App, PluginManifest } from "obsidian";
import { AiHelperPlugin } from "../src/main";
import { AiHelperSettingsTab, DEFAULT_SETTINGS } from "../src/settings";
import { en, ru, setLanguage, t } from "../src/i18n";
import { deferred, TestElement } from "./helpers/obsidian";

const controls = vi.hoisted(() => [] as Array<{ name: string; description: string; button?: { click: () => Promise<void> }; input?: { value: string; inputEl: TestElement; change: (value: string) => Promise<void> } }>);
vi.mock("obsidian", async () => {
	const helper = await import("./helpers/obsidian");
	return { ...helper,
		PluginSettingTab: class { containerEl = new helper.TestElement(); },
		Setting: class {
			name = ""; description = ""; controlEl = new helper.TestElement(); descEl = new helper.TestElement();
			input?: { value: string; inputEl: TestElement; change: (value: string) => Promise<void> };
			constructor() { controls.push(this); }
			setClass() { return this; }
			setName(name: string) { this.name = name; return this; }
			setDesc(description: string) { this.description = description; return this; }
			addText(callback: (text: unknown) => void) { return this.addTextArea(callback); }
			addTextArea(callback: (text: unknown) => void) {
				const input = { value: "", inputEl: new helper.TestElement(), change: async (_value: string) => {},
					setPlaceholder() { return this; }, setValue(value: string) { this.value = value; return this; },
					onChange(change: (value: string) => Promise<void>) { this.change = change; return this; } };
				this.input = input; callback(input); return this;
			}
			addDropdown(callback: (dropdown: unknown) => void) { callback({ addOption() { return this; }, setValue() { return this; }, onChange() { return this; } }); return this; }
			addButton(callback: (button: unknown) => void) {
				const button = { buttonEl: new helper.TestElement(), click: async () => {}, setIcon() { return this; }, setTooltip() { return this; }, setButtonText() { return this; }, onClick(click: () => Promise<void>) { this.click = click; return this; } };
				(this as unknown as { button: typeof button }).button = button;
				callback(button); return this;
			}
		},
	};
});
afterEach(() => { controls.length = 0; setLanguage("en"); vi.unstubAllGlobals(); });

it("defaults to empty for new and old saved settings", async () => {
	expect(DEFAULT_SETTINGS.responseWait).toBe("");
	const plugin = new AiHelperPlugin({} as App, {} as PluginManifest);
	vi.spyOn(plugin, "loadData").mockResolvedValue({ model: "legacy" });
	await plugin.loadSettings();
	expect(plugin.settings.responseWait).toBe("");
});

it.each(["en", "ru"] as const)("explains idle seconds and validates saved values in %s", async (locale) => {
	setLanguage(locale);
	const saveSettings = vi.fn(async () => {});
	const plugin = { settings: { ...DEFAULT_SETTINGS }, modelStatus: "idle", t, saveSettings } as unknown as AiHelperPlugin;
	const tab = new AiHelperSettingsTab({} as App, plugin); tab.display();
	const dictionary = locale === "ru" ? ru : en;
	const setting = controls.find((value) => value.name === dictionary["setting-response-wait"])!;
	expect(setting.input?.value).toBe("");
	expect(setting.description).toBe(dictionary["setting-response-wait-desc"]);
	await setting.input!.change(" 12 ");
	expect(plugin.settings.responseWait).toBe("12"); expect(saveSettings).toHaveBeenCalledTimes(1);
	for (const invalid of ["0", "-1", "1.5", "abc", "Infinity", "1e3", "9007199254740992"]) {
		await setting.input!.change(invalid);
		expect(plugin.settings.responseWait).toBe("12");
		expect(setting.description).toContain(dictionary["setting-response-wait-invalid"]);
		expect(setting.input!.inputEl.attributes["aria-invalid"]).toBe("true");
	}
	expect(saveSettings).toHaveBeenCalledTimes(1);
	await setting.input!.change("");
	expect(plugin.settings.responseWait).toBe("");
	expect(setting.description).toBe(dictionary["setting-response-wait-desc"]);
	expect(setting.input!.inputEl.attributes["aria-invalid"]).toBe("false");
	expect(saveSettings).toHaveBeenCalledTimes(2);
});


it("saves an independent embedding connection and verifies it through the settings button", async () => {
	const plugin = new AiHelperPlugin({} as App, {} as PluginManifest);
	plugin.settings = { ...DEFAULT_SETTINGS, serverUrl: "http://chat/v1", apiKey: "chat-key", model: "chat-model" };
	const save = vi.fn(async () => {});
	// Persistence and HTTP are the external boundaries.
	Object.assign(plugin, { saveData: save });
	const fetch = vi.fn(async (_url: string, _init?: RequestInit) => new Response(JSON.stringify({ data: [
		{ index: 0, embedding: [1, 2] }, { index: 1, embedding: [3, 4] },
	] })));
	vi.stubGlobal("fetch", fetch);
	const tab = new AiHelperSettingsTab({} as App, plugin);
	tab.display();
	for (const [name, value] of [["Embedding model server URL", "http://embed/v1"], ["Embedding API key", "embed-key"], ["Embedding model API identifier", "embed-model"]]) {
		await controls.find((control) => control.name === name)!.input!.change(value);
	}
	expect(save).toHaveBeenLastCalledWith(expect.objectContaining({ embeddingServerUrl: "http://embed/v1", embeddingApiKey: "embed-key", embeddingModel: "embed-model", serverUrl: "http://chat/v1", apiKey: "chat-key", model: "chat-model" }));
	expect(fetch).not.toHaveBeenCalled();
	await controls.find((control) => control.name === "Check embeddings")!.button!.click();
	expect(fetch.mock.calls[0][0]).toBe("http://embed/v1/embeddings");
	expect(controls.find((control) => control.name === "Check embeddings")!.description).toContain("verified");
});


it.each(["en", "ru"] as const)("shows embedding errors in %s and resets confirmation when edited", async (locale) => {
	setLanguage(locale);
	const dictionary = locale === "ru" ? ru : en;
	const plugin = new AiHelperPlugin({} as App, {} as PluginManifest);
	plugin.settings = { ...DEFAULT_SETTINGS, embeddingServerUrl: "http://s", embeddingModel: "chosen" };
	Object.assign(plugin, { saveData: vi.fn(async () => {}) });
	vi.stubGlobal("fetch", async () => new Response("private error", { status: 401 }));
	const tab = new AiHelperSettingsTab({} as App, plugin);
	tab.display();
	const check = controls.find((control) => control.name === dictionary["embedding-check"])!;
	await check.button!.click();
	expect(check.description).toContain(dictionary["embedding-auth"]);
	await controls.find((control) => control.name === dictionary["setting-embedding-model"])!.input!.change("new-model");
	expect(check.description).toContain(dictionary["embedding-idle"]);
	expect(check.description).not.toContain(dictionary["embedding-auth"]);
});

it("clears an active check when the user edits the connection", async () => {
	const pending = deferred<Response>();
	vi.stubGlobal("fetch", () => pending.promise);
	const plugin = new AiHelperPlugin({} as App, {} as PluginManifest);
	plugin.settings = { ...DEFAULT_SETTINGS, embeddingServerUrl: "http://s", embeddingModel: "m" };
	Object.assign(plugin, { saveData: vi.fn(async () => {}) });
	const tab = new AiHelperSettingsTab({} as App, plugin);
	tab.display();
	const check = controls.find((control) => control.name === en["embedding-check"])!;
	const checking = check.button!.click();
	expect(check.description).toContain(en["embedding-checking"]);
	await controls.find((control) => control.name === en["setting-embedding-server-url"])!.input!.change("http://new");
	pending.resolve(new Response(JSON.stringify({ data: [{ index: 0, embedding: [1] }, { index: 1, embedding: [2] }] })));
	await checking;
	expect(check.description).toContain(en["embedding-idle"]);
});

it("loads saved embedding parameters while old settings receive empty defaults", async () => {
	const plugin = new AiHelperPlugin({} as App, {} as PluginManifest);
	vi.spyOn(plugin, "loadData").mockResolvedValueOnce({ model: "legacy" }).mockResolvedValueOnce({ embeddingServerUrl: "http://saved", embeddingApiKey: "saved-key", embeddingModel: "saved-model", model: "chat-model" });
	await plugin.loadSettings();
	expect(plugin.settings).toMatchObject({ embeddingServerUrl: "", embeddingApiKey: "", embeddingModel: "", model: "legacy" });
	await plugin.loadSettings();
	expect(plugin.settings).toMatchObject({ embeddingServerUrl: "http://saved", embeddingApiKey: "saved-key", embeddingModel: "saved-model", model: "chat-model" });
	expect(plugin.noteSearchConnection.status.state).toBe("idle");
});


it("resets a pending check when the settings are redisplayed", async () => {
	const pending = deferred<Response>();
	vi.stubGlobal("fetch", () => pending.promise);
	const plugin = new AiHelperPlugin({} as App, {} as PluginManifest);
	plugin.settings = { ...DEFAULT_SETTINGS, embeddingServerUrl: "http://s", embeddingModel: "m" };
	const tab = new AiHelperSettingsTab({} as App, plugin);
	tab.display();
	const checking = controls.find((control) => control.name === en["embedding-check"])!.button!.click();
	controls.length = 0;
	tab.display();
	pending.resolve(new Response(JSON.stringify({ data: [{ index: 0, embedding: [1] }, { index: 1, embedding: [2] }] })));
	await checking;
	expect(controls.find((control) => control.name === en["embedding-check"])!.description).toContain(en["embedding-idle"]);
});

it.each(["en", "ru"] as const)("saves the minimum source similarity, accepts decimal commas and rejects invalid values in %s", async (locale) => {
	setLanguage(locale);
	const dictionary = locale === "ru" ? ru : en;
	const plugin = new AiHelperPlugin({} as App, {} as PluginManifest);
	vi.spyOn(plugin, "loadData").mockResolvedValue({ model: "legacy" });
	await plugin.loadSettings();
	expect(plugin.settings.noteSearchMinSimilarity).toBe(0.45);
	const save = vi.fn(async () => {}); Object.assign(plugin, { saveData: save });
	const tab = new AiHelperSettingsTab({} as App, plugin); tab.display();
	const setting = controls.find((control) => control.name === dictionary["setting-search-min-similarity"])!;
	expect(setting.input!.value).toBe("0.45");
	await setting.input!.change(" 0,6 ");
	expect(plugin.settings.noteSearchMinSimilarity).toBe(0.6);
	expect(save).toHaveBeenLastCalledWith(expect.objectContaining({ noteSearchMinSimilarity: 0.6 }));
	for (const invalid of ["", "-0.1", "1.01", "NaN", "Infinity", "abc", "0,4,5"]) {
		await setting.input!.change(invalid);
		expect(plugin.settings.noteSearchMinSimilarity).toBe(0.6);
		expect(setting.description).toContain(dictionary["setting-search-min-similarity-invalid"]);
		expect(setting.input!.inputEl.attributes["aria-invalid"]).toBe("true");
	}
	expect(save).toHaveBeenCalledTimes(1);
	await setting.input!.change("0"); expect(plugin.settings.noteSearchMinSimilarity).toBe(0);
	await setting.input!.change("1"); expect(plugin.settings.noteSearchMinSimilarity).toBe(1);
	expect(setting.input!.inputEl.attributes["aria-invalid"]).toBe("false");
	expect(setting.description).toBe(dictionary["setting-search-min-similarity-desc"]);
	const restored = new AiHelperPlugin({} as App, {} as PluginManifest);
	vi.spyOn(restored, "loadData").mockResolvedValue(plugin.settings); await restored.loadSettings();
	expect(restored.settings.noteSearchMinSimilarity).toBe(1);
});


it.each([null, -1, 2, "invalid", "0.6"])("uses the default for an invalid saved threshold %s", async (value) => {
	const plugin = new AiHelperPlugin({} as App, {} as PluginManifest);
	vi.spyOn(plugin, "loadData").mockResolvedValue({ noteSearchMinSimilarity: value }); await plugin.loadSettings();
	expect(plugin.settings.noteSearchMinSimilarity).toBe(0.45);
});
