import { afterEach, expect, it, vi } from "vitest";
import { FileSystemAdapter, type App, type PluginManifest } from "obsidian";
import { IDBFactory } from "fake-indexeddb";
import { AiHelperPlugin } from "../src/main";
import { createNoteSearch } from "../src/note-index";
import { createServerClient } from "../src/server-client";
import { AiHelperSettingsTab, DEFAULT_SETTINGS } from "../src/settings";
import { FolderDescriptions, folderSourceData } from "../src/folder-descriptions";
import { en, ru, setLanguage, t } from "../src/i18n";
import { deferred, TestElement } from "./helpers/obsidian";

const controls = vi.hoisted(() => [] as Array<{ name: string; description: string; toggle?: { change: (value: boolean) => Promise<void> }; slider?: { value: number; change: (value: number) => Promise<void> }; picker?: { value: string; disabled: boolean; change: (value: string) => Promise<void> }; button?: { buttonEl: TestElement; click: () => Promise<void> }; dropdown?: { selectEl: TestElement; value: string; options: Record<string, string>; change: (value: string) => Promise<void> }; input?: { value: string; inputEl: TestElement; change: (value: string) => Promise<void> } }>);
vi.mock("obsidian", async () => {
	const helper = await import("./helpers/obsidian");
	const MockSetting = class {
			name = ""; get description() { return this.descEl.getText(); } controlEl = new helper.TestElement(); descEl = new helper.TestElement();
			input?: { value: string; inputEl: TestElement; change: (value: string) => Promise<void> };
			dropdown?: { selectEl: TestElement; value: string; options: Record<string, string>; change: (value: string) => Promise<void> };
			constructor() {
				controls.push(this);
				this.controlEl.empty = () => { this.input = undefined; this.dropdown = undefined; };
			}
			setClass() { return this; }
			setName(name: string) { this.name = name; return this; }
			setDesc(description: string) { this.descEl.setText(description); return this; }
			addToggle(callback: (toggle: unknown) => void) {
				const toggle = { toggleEl: new helper.TestElement(), setTooltip() { return this; }, change: async (_value: boolean) => {}, setValue() { return this; }, onChange(change: (value: boolean) => Promise<void>) { this.change = change; return this; } };
				Object.assign(this, { toggle }); callback(toggle); return this;
			}
			addSlider(callback: (slider: unknown) => void) {
				const slider = { sliderEl: new helper.TestElement(), setDisplayFormat() { return this; }, value: 0, change: async (_value: number) => {}, setLimits() { return this; }, setDynamicTooltip() { return this; }, setDisabled() { return this; }, setValue(value: number) { this.value = value; return this; }, onChange(change: (value: number) => Promise<void>) { this.change = change; return this; } };
				Object.assign(this, { slider }); callback(slider); return this;
			}
			addSearch(callback: (text: unknown) => void) { return this.addTextArea(callback); }
			addText(callback: (text: unknown) => void) { return this.addTextArea(callback); }
			addTextArea(callback: (text: unknown) => void) {
				const input = { value: "", inputEl: new helper.TestElement(), change: async (_value: string) => {},
					setDisabled(value: boolean) { this.inputEl.disabled = value; return this; }, getValue() { return this.value; }, setPlaceholder() { return this; }, setValue(value: string) { this.value = value; return this; },
					onChange(change: (value: string) => Promise<void>) { this.change = change; return this; } };
				this.input = input; callback(input); return this;
			}
			addDropdown(callback: (dropdown: unknown) => void) {
				const dropdown = { selectEl: new helper.TestElement(), setDisabled(value: boolean) { this.selectEl.disabled = value; return this; }, value: "", options: {} as Record<string, string>, change: async (_value: string) => {},
					addOption(value: string, label: string) { this.options[value] = label; return this; },
					setValue(value: string) { this.value = value; return this; },
					onChange(change: (value: string) => Promise<void>) { this.change = change; return this; } };
				this.dropdown = dropdown; callback(dropdown); return this;
			}
			addColorPicker(callback: (picker: unknown) => void) {
				const picker = { value: "", disabled: false, change: async (_value: string) => {},
					setValue(value: string) { this.value = value; return this; },
					setDisabled(disabled: boolean) { this.disabled = disabled; return this; },
					onChange(change: (value: string) => Promise<void>) { this.change = change; return this; } };
				Object.assign(this, { picker }); callback(picker); return this;
			}
			addButton(callback: (button: unknown) => void) {
				const button = { buttonEl: new helper.TestElement(), setDisabled(value: boolean) { this.buttonEl.disabled = value; return this; }, click: async () => {}, setIcon() { return this; }, setWarning() { this.buttonEl.addClass("mod-warning"); return this; }, setTooltip() { return this; }, setButtonText() { return this; }, onClick(click: () => Promise<void>) { this.click = click; return this; } };
				(this as unknown as { button: typeof button }).button = button;
				callback(button); return this;
			}
			addExtraButton(callback: (button: unknown) => void) {
				return this.addButton((button: any) => {
					button.extraSettingsEl = button.buttonEl;
					callback(button);
				});
			}
		};
	return { ...helper, Setting: MockSetting, PluginSettingTab: class extends helper.PluginSettingTab { createSetting(parent: TestElement) { return new MockSetting(); } } };
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

it.each(["en", "ru"] as const)("shows a detected context window and preserves a validated manual override in %s", async (locale) => {
	setLanguage(locale);
	const dictionary = locale === "ru" ? ru : en;
	const plugin = new AiHelperPlugin({} as App, {} as PluginManifest);
	plugin.settings = { ...DEFAULT_SETTINGS, serverUrl: "http://s/v1", model: "m" };
	plugin.contextWindowConnection.configure(plugin.settings);
	Object.assign(plugin, { saveData: vi.fn(async () => {}) });
	vi.stubGlobal("fetch", async () => new Response(JSON.stringify({ data: [{ id: "m", max_model_len: 8192 }] })));
	const tab = new AiHelperSettingsTab({} as App, plugin); tab.display();
	const setting = controls.find((control) => control.name === dictionary["setting-context-window"])!;
	await setting.button!.click();
	expect(setting.description).toContain("8192 (vLLM)");
	expect(setting.input!.value).toBe("");
	await setting.input!.change("4096");
	expect(plugin.settings.contextWindow).toBe("4096");
	expect(setting.description).toContain(`${dictionary["context-manual"]}: 4096`);
	await setting.input!.change("-1");
	expect(plugin.settings.contextWindow).toBe("4096");
	expect(setting.input!.inputEl.attributes["aria-invalid"]).toBe("true");
	await setting.button!.click();
	expect(plugin.settings.contextWindow).toBe("4096");
	await setting.input!.change("");
	expect(setting.description).toContain("8192 (vLLM)");
	tab.hide();
});


it("saves an independent embedding connection and verifies it through the settings button", async () => {
	const plugin = new AiHelperPlugin({} as App, {} as PluginManifest);
	plugin.settings = { ...DEFAULT_SETTINGS, serverUrl: "http://chat/v1", apiKey: "chat-key", model: "chat-model" };
	plugin.contextWindowConnection.configure(plugin.settings);
	const save = vi.fn(async () => {});
	// Persistence and HTTP are the external boundaries.
	Object.assign(plugin, { saveData: save });
	const fetch = vi.fn(async (_url: string, _init?: RequestInit) => new Response(JSON.stringify({ data: [
		{ index: 0, embedding: [1, 2] }, { index: 1, embedding: [3, 4] },
	] })));
	vi.stubGlobal("fetch", fetch);
	const tab = new AiHelperSettingsTab({} as App, plugin);
	tab.display();
	for (const [name, value] of [["Embedding model server URL", "http://embed/v1"], ["Embedding API key", "embed-key"], ["Embedding model", "embed-model"]]) {
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


it("offers embedding server models and lets the user select or enter a model manually", async () => {
	const plugin = new AiHelperPlugin({} as App, {} as PluginManifest);
	plugin.settings = { ...DEFAULT_SETTINGS, embeddingServerUrl: "http://embed/v1/", embeddingApiKey: "embed-key", embeddingModel: "custom-id", model: "chat-model" };
	const save = vi.fn(async () => {}); Object.assign(plugin, { saveData: save });
	const fetch = vi.fn(async (_url: string, _init?: RequestInit) => new Response(JSON.stringify({ data: [{ id: "embed-a" }, { id: "embed-b" }] })));
	vi.stubGlobal("fetch", fetch);
	const tab = new AiHelperSettingsTab({} as App, plugin); tab.display();
	await controls.find((control) => control.name === en["setting-embedding-model"])!.button!.click();
	const selector = controls.filter((control) => control.name === en["setting-embedding-model"]).slice(-1)[0]!;
	expect(fetch.mock.calls[0][0]).toBe("http://embed/v1/models");
	expect(fetch.mock.calls[0][1]?.headers).toEqual({ Authorization: "Bearer embed-key" });
	expect(selector.dropdown!.options).toEqual({ "": "Enter manually", "embed-a": "embed-a", "embed-b": "embed-b" });
	expect(selector.input!.value).toBe("custom-id");
	await selector.dropdown!.change("embed-b");
	expect(plugin.settings.embeddingModel).toBe("embed-b");
	expect(plugin.settings.model).toBe("chat-model");
	expect(selector.dropdown!.value).toBe("embed-b");
	await selector.dropdown!.change("");
	await selector.input!.change("private-model");
	expect(save).toHaveBeenLastCalledWith(expect.objectContaining({ embeddingModel: "private-model" }));
	await controls.filter((control) => control.name === en["setting-embedding-api-key"]).slice(-1)[0]!.input!.change("new-key");
	expect(selector.dropdown).toBeUndefined();
	expect(selector.input!.value).toBe("private-model");
	expect(plugin.embeddingModels).toEqual([]);
	expect(plugin.noteSearchConnection.status.state).toBe("idle");
});

it.each(["en", "ru"] as const)("checks the main model without sending history and exposes success/error status in %s", async (locale) => {
	setLanguage(locale); const dictionary = locale === "ru" ? ru : en;
	const plugin = new AiHelperPlugin({} as App, {} as PluginManifest);
	plugin.settings = { ...DEFAULT_SETTINGS, serverUrl: "http://chat/v1", apiKey: "chat-key", model: "selected" };
	Object.assign(plugin, { saveData: vi.fn(async () => {}) });
	const fetch = vi.fn(async (_url: string, _init?: RequestInit) => new Response(JSON.stringify({ choices: [{ message: { content: "OK" } }] })));
	vi.stubGlobal("fetch", fetch);
	const tab = new AiHelperSettingsTab({} as App, plugin); tab.display();
	const check = controls.find((control) => control.name === dictionary["model-check"])!;
	await check.button!.click();
	expect(check.description).toContain(dictionary["model-verified"]);
	expect((check as unknown as { descEl: TestElement }).descEl.find("ai-helper-connection-status").attributes["data-state"]).toBe("verified");
	expect(fetch.mock.calls[0][0]).toBe("http://chat/v1/chat/completions");
	expect(JSON.parse(fetch.mock.calls[0][1]!.body as string)).toMatchObject({ model: "selected", messages: [{ role: "user", content: "Reply with OK." }] });
	await controls.find((control) => control.name === dictionary["setting-api-key"])!.input!.change("bad-key");
	expect(check.description).toContain(dictionary["model-idle"]);
	fetch.mockImplementation(async () => new Response("private server details", { status: 401 }));
	await check.button!.click();
	expect(check.description).toContain(dictionary["model-auth"]);
	expect((check as unknown as { descEl: TestElement }).descEl.find("ai-helper-connection-status").attributes["data-state"]).toBe("error");
});


it.each(["en", "ru"] as const)("validates advanced fragment settings and saves only compatible values in %s", async (locale) => {
	setLanguage(locale); const dictionary = locale === "ru" ? ru : en;
	const plugin = new AiHelperPlugin({} as App, {} as PluginManifest);
	plugin.settings = { ...DEFAULT_SETTINGS };
	const save = vi.fn(async () => {}); Object.assign(plugin, { saveData: save });
	const tab = new AiHelperSettingsTab({} as App, plugin); tab.display();
	const size = controls.find((control) => control.name === dictionary["setting-fragment-size"])!;
	const overlap = controls.find((control) => control.name === dictionary["setting-fragment-overlap"])!;
	await size.input!.change("256");
	expect(size.input!.inputEl.attributes["aria-invalid"]).toBe("true");
	expect(plugin.settings.noteFragmentSize).toBe(4000); expect(save).not.toHaveBeenCalled();
	await overlap.input!.change("32"); await size.input!.change("512");
	expect(save).toHaveBeenLastCalledWith(expect.objectContaining({ noteFragmentSize: 512, noteFragmentOverlap: 32 }));
	for (const raw of ["-1", "1.5", "Infinity", "", "129"]) await overlap.input!.change(raw);
	expect(plugin.settings.noteFragmentOverlap).toBe(32);
	expect(overlap.description).toContain(dictionary["search-fragment-settings"]);
	expect(save).toHaveBeenCalledTimes(2);
});


it("configures ordered similarity boundaries and custom HEX colors through settings", async () => {
	setLanguage("ru");
	const saveSettings = vi.fn(async () => {});
	const plugin = { settings: { ...DEFAULT_SETTINGS }, modelStatus: "idle", t, saveSettings } as unknown as AiHelperPlugin;
	const tab = new AiHelperSettingsTab({} as App, plugin); tab.display();
	const weak = controls.find((value) => value.name === ru["setting-similarity-weak"])!;
	const medium = controls.find((value) => value.name === ru["setting-similarity-medium"])!;
	const strong = controls.find((value) => value.name === ru["setting-similarity-strong"])!;
	expect(weak.input?.value).toBe("0.3"); expect(medium.input?.value).toBe("0.5"); expect(strong.input).toBeUndefined();
	expect(weak.dropdown?.value).toBe("red"); expect(medium.dropdown?.value).toBe("orange"); expect(strong.dropdown?.value).toBe("green");
	for (const raw of ["0,5", "1", "-0.1", "text", ""]) {
		await weak.input!.change(raw);
		expect(weak.input!.inputEl.attributes["aria-invalid"]).toBe("true");
		expect(plugin.settings.similarityAppearance.weakUpper).toBe(0.3);
	}
	await weak.input!.change("0,4");
	await medium.input!.change("0,7");
	expect(plugin.settings.similarityAppearance).toMatchObject({ weakUpper: 0.4, mediumUpper: 0.7 });
	await strong.dropdown!.change("custom"); expect(strong.picker!.disabled).toBe(false);
	await strong.picker!.change("#123abc");
	expect(plugin.settings.similarityAppearance.strongColor).toBe("#123abc");
	await strong.dropdown!.change("purple");
	expect(strong.picker!.disabled).toBe(true); expect(plugin.settings.similarityAppearance.strongColor).toBe("purple");
	expect(plugin.settings.noteSearchMinSimilarity).toBe(0.45);
	tab.display();
	const strongAgain = controls.filter((value) => value.name === ru["setting-similarity-strong"]).at(-1)!;
	expect(strongAgain.dropdown?.value).toBe("purple");
});

it("restores valid similarity colors and replaces invalid saved values", async () => {
	const plugin = new AiHelperPlugin({} as App, {} as PluginManifest);
	vi.spyOn(plugin, "loadData").mockResolvedValue({ similarityAppearance: { weakUpper: 0.8, mediumUpper: 0.2, weakColor: "untrusted-css", mediumColor: "blue", strongColor: "#abcdef" } });
	await plugin.loadSettings();
	expect(plugin.settings.similarityAppearance).toEqual({ weakUpper: 0.3, mediumUpper: 0.5, weakColor: "red", mediumColor: "blue", strongColor: "#abcdef" });
});


it.each(["en", "ru"] as const)("saves the note-update delay in seconds and rejects invalid values in %s", async locale => {
	setLanguage(locale);
	const saveSettings = vi.fn(async () => {});
	const plugin = { settings: { ...DEFAULT_SETTINGS }, modelStatus: "idle", t, saveSettings } as unknown as AiHelperPlugin;
	const tab = new AiHelperSettingsTab({} as App, plugin); tab.display();
	const dictionary = locale === "ru" ? ru : en;
	const setting = controls.find(value => value.name === dictionary["search-update-delay"])!;
	expect(setting.input?.value).toBe("3");
	await setting.input!.change(" 5 ");
	expect(plugin.settings.noteUpdateDelaySeconds).toBe(5);
	await setting.input!.change("1,5");
	expect(plugin.settings.noteUpdateDelaySeconds).toBe(1.5);
	for (const invalid of ["", "0", "-1", "abc", "Infinity", "1e3", "2147484"]) {
		await setting.input!.change(invalid);
		expect(plugin.settings.noteUpdateDelaySeconds).toBe(1.5);
		expect(setting.input!.inputEl.attributes["aria-invalid"]).toBe("true");
	}
	expect(saveSettings).toHaveBeenCalledTimes(2);
});

it.each([undefined, null, -1, "5", Infinity, 2147484])("defaults invalid or missing saved note-update delay %s to three seconds", async value => {
	const plugin = new AiHelperPlugin({} as App, {} as PluginManifest);
	vi.spyOn(plugin, "loadData").mockResolvedValue({ noteUpdateDelaySeconds: value });
	await plugin.loadSettings(); expect(plugin.settings.noteUpdateDelaySeconds).toBe(3);
});


it("shows the renamed exclusion immediately in open settings and persists it before index cleanup", async () => {
	vi.stubGlobal("indexedDB", new IDBFactory());
	const adapter = new FileSystemAdapter(); adapter.getBasePath = () => "/rename-settings";
	const handlers = new Map<string, Array<(...args: any[]) => void>>();
	const on = (event: string, callback: (...args: any[]) => void) => { handlers.set(event, [...handlers.get(event) ?? [], callback]); return { event, callback }; };
	const offref = ({ event, callback }: { event: string; callback: (...args: any[]) => void }) => { handlers.set(event, handlers.get(event)!.filter(handler => handler !== callback)); };
	const app = { vault: { adapter, on, offref, getMarkdownFiles: () => [], getAbstractFileByPath: () => ({ path: "Secrets" }) }, workspace: { on, onLayoutReady: () => {}, detachLeavesOfType: () => {} } } as unknown as App;
	const plugin = new AiHelperPlugin(app, {} as PluginManifest);
	vi.spyOn(plugin, "loadData").mockResolvedValue({ ...DEFAULT_SETTINGS, excludedFolders: ["Private", "Private/Nested", "Private-public"] });
	const saving = vi.fn(async () => {}); Object.assign(plugin, { saveData: saving });
	const tabs = vi.spyOn(plugin, "addSettingTab"); await plugin.onload();
	const tab = tabs.mock.calls[0][0] as AiHelperSettingsTab; tab.display();
	for (const handler of [...handlers.get("rename")!]) handler({ path: "Secrets" }, "Private");
	try {
		expect(controls.filter(value => value.name === "" && value.input).slice(-3).map(value => value.input!.value)).toEqual(["Secrets", "Secrets/Nested", "Private-public"]);
		expect(plugin.settings.excludedFolders).toEqual(["Secrets", "Secrets/Nested", "Private-public"]);
		await vi.waitFor(() => expect(saving).toHaveBeenCalledWith(expect.objectContaining({ excludedFolders: ["Secrets", "Secrets/Nested", "Private-public"] })));
	} finally { tab.hide(); plugin.onunload(); }
});


it.each(["en", "ru"] as const)("clears the full index and pending updates through settings in %s", async locale => {
	setLanguage(locale);
	const plugin = new AiHelperPlugin({} as App, {} as PluginManifest);
	plugin.settings = { ...DEFAULT_SETTINGS, embeddingServerUrl: "http://s/v1", embeddingModel: "e", autoUpdateNotes: false };
	let text = "original note"; let requests = 0;
	const client = createServerClient(async () => {
		requests++; return new Response(JSON.stringify({ data: [{ index: 0, embedding: [1, 0] }] }));
	});
	const environment = { factory: new IDBFactory(), vaultPath: "/settings-clear", client, list: () => ["Note.md"], read: async () => text, open: async () => {} };
	plugin.noteSearch = createNoteSearch(environment); plugin.noteSearch.configure(plugin.settings);
	await plugin.noteSearch.indexVault(); await plugin.noteSearch.pause();
	text = "edited note"; await plugin.noteSearch.changed("Note.md");
	const tab = new AiHelperSettingsTab({} as App, plugin); tab.display();
	const clear = controls.find(control => control.name === t("search-vault-clear"))!;
	expect(clear.description).toBe(t("search-clear-desc"));
	await clear.button!.click();
	expect(plugin.noteSearch.progress).toMatchObject({ state: "idle", completed: 0, total: 1 });
	plugin.noteSearch.dispose();
	const restored = createNoteSearch(environment); restored.configure({ ...plugin.settings, autoUpdateNotes: true });
	await restored.restore(); await restored.resume(true);
	expect(restored.progress.state).toBe("idle"); expect(requests).toBe(1); expect(text).toBe("edited note");
	await expect(restored.search("note")).rejects.toMatchObject({ code: "search-rebuild" }); restored.dispose();
});


it("adds absent folders and root, rejects duplicate edits and removes rows", async () => {
	const plugin = { settings: { ...DEFAULT_SETTINGS, excludedFolders: ["Private"] }, modelStatus: "idle", t, saveSettings: vi.fn(async () => {}) } as unknown as AiHelperPlugin;
	const tab = new AiHelperSettingsTab({} as App, plugin); tab.display();
	const list = () => (tab.getSettingDefinitions().find(def => "type" in def && def.type === "page" && def.name === en["settings-page-search"]) as any).items.find((def: any) => def.type === "list");
	const add = () => controls.filter(row => row.name === en["setting-excluded-folders"]).slice(-1)[0].button!.click();
	await add(); await tab.setControlValue("excluded-folder:new", "Missing");
	await add(); await tab.setControlValue("excluded-folder:new", "/");
	await add(); await tab.setControlValue("excluded-folder:new", "Missing");
	expect(plugin.settings.excludedFolders).toEqual(["Private", "Missing", "/"]);
	await tab.setControlValue("excluded-folder:0", "Missing");
	expect(plugin.settings.excludedFolders[0]).toBe("Private");
	list().onDelete(0);
	list().onDelete(list().items.length - 1);
	expect(plugin.settings.excludedFolders).toEqual(["Private", "Missing", "/"]);
	list().onDelete(2); await Promise.resolve();
	expect(plugin.settings.excludedFolders).toEqual(["Private", "/"]);
	list().onDelete(3);
	expect(plugin.settings.excludedFolders).toEqual(["Private", "/"]);
	expect(tab.getControlValue("excluded-folder:new")).toBe("");
	tab.hide();
});


it("defaults missing language to auto and preserves saved manual preferences", async () => {
	for (const [saved, expected] of [[{}, "auto"], [{ language: "ru" }, "ru"], [{ language: "en" }, "en"], [{ language: "bad" }, "auto"]]) {
		const plugin = new AiHelperPlugin({} as App, {} as PluginManifest);
		vi.spyOn(plugin, "loadData").mockResolvedValue(saved);
		await plugin.loadSettings(); expect(plugin.settings.language).toBe(expected);
	}
});


it("preserves exact top P values and server defaults while validating manual edits", async () => {
	const plugin = { settings: { ...DEFAULT_SETTINGS, topP: "0.12345" }, modelStatus: "idle", t, saveSettings: vi.fn(async () => {}) } as unknown as AiHelperPlugin;
	new AiHelperSettingsTab({} as App, plugin).display();
	const row = controls.find(row => row.name === en["setting-top-p"])!;
	const toggle = row.toggle!;
	expect(plugin.settings.topP).toBe("0.12345");
	await row.input!.change("1.2"); expect(plugin.settings.topP).toBe("0.12345");
	await row.input!.change("0,23456"); expect(plugin.settings.topP).toBe("0.23456");
	await toggle.change(true); expect(plugin.settings.topP).toBe(""); expect(row.input!.inputEl.disabled).toBe(true);
	await toggle.change(false); expect(plugin.settings.topP).toBe("0.23456");
	await row.slider!.change(0.7); expect(plugin.settings.topP).toBe("0.7"); expect(row.input!.value).toBe("0.7");
});


it("indexes all pages without rendering, requesting models or subscribing", () => {
	const plugin = new AiHelperPlugin({} as App, {} as PluginManifest);
	const tab = new AiHelperSettingsTab({} as App, plugin);
	const network = vi.spyOn(plugin.serverClient, "listModels");
	const subscribe = vi.spyOn(plugin.contextWindowConnection, "subscribe");
	const walk = (items: any[]): any[] => items.flatMap(item => [item, ...walk(item.items ?? [])]);
	const definitions = tab.getSettingDefinitions();
	expect(definitions.filter(def => "type" in def && def.type === "page").map(def => (def as any).name)).toEqual([en["settings-page-conversation"], en["settings-page-search"], en["settings-page-review"], en["translation-title"]]);
	const names = walk(definitions).map(def => def.name);
	for (const key of ["setting-response-wait", "setting-model", "setting-embedding-model", "setting-fragment-size", "setting-top-p"]) expect(names).toContain(en[key as keyof typeof en]);
	const pages = definitions.filter(def => "type" in def && def.type === "page" && def.name !== en["translation-title"]) as any[];
	const translation = definitions.find(def => "type" in def && def.type === "page" && def.name === en["translation-title"]);
	expect(translation && "items" in translation ? walk(translation.items ?? []).map(def => def.name) : []).toContain(en["translation-language"]);
	expect(pages[0].items.filter((group: any) => group.type === "group").map((group: any) => group.heading)).toEqual([en["settings-group-connection"], en["settings-group-generation"]]);
	expect(pages[1].items.filter((group: any) => group.type === "group" || group.type === "list").map((group: any) => group.heading)).toEqual([en["settings-group-embedding"], en["settings-group-search-scope"], en["settings-group-index"], en["settings-group-search-results"], en["settings-group-fragments"]]);
	expect(walk(pages[1].items).map(def => def.name)).toContain(en["setting-source-budget"]);
	expect(walk(pages[1].items).map(def => def.name)).not.toContain(en["folder-description-name"]);
	expect(walk(pages[2].items).map(def => def.name)).toContain(en["folder-description-name"]);
	expect(pages[2].items[1].desc).toBe(en["settings-review-model-desc"]);
	expect(walk(definitions).filter(def => def.desc === en["setting-excluded-folders-desc"])).toHaveLength(1);
	expect(network).not.toHaveBeenCalled(); expect(subscribe).not.toHaveBeenCalled(); expect(controls).toHaveLength(0);
});

it("cleans subscriptions on redisplay and hide while status updates retain controls", async () => {
	const plugin = new AiHelperPlugin({} as App, {} as PluginManifest);
	let updateIndex!: () => void;
	const cleanup = vi.fn();
	Object.assign(plugin, { noteSearch: { progress: { state: "idle", completed: 0, total: 0 }, subscribe: vi.fn((callback: () => void) => { updateIndex = callback; return cleanup; }) } });
	const tab = new AiHelperSettingsTab({} as App, plugin); tab.display();
	const count = controls.length; updateIndex(); expect(controls).toHaveLength(count);
	tab.display(); expect(cleanup).toHaveBeenCalledTimes(1);
	tab.hide(); expect(cleanup).toHaveBeenCalledTimes(2);
});

it("renders a draft folder without persisting an empty exclusion", () => {
	const plugin = { settings: { ...DEFAULT_SETTINGS, excludedFolders: [] }, modelStatus: "idle", t, saveSettings: vi.fn(async () => {}) } as unknown as AiHelperPlugin;
	const tab = new AiHelperSettingsTab({} as App, plugin); tab.display();
	controls.find(row => row.name === en["setting-excluded-folders"])!.button!.click();
	expect(controls.filter(row => row.name === "" && row.input).slice(-1)[0].input!.value).toBe("");
	expect(plugin.settings.excludedFolders).toEqual([]); expect(plugin.saveSettings).not.toHaveBeenCalled();
});


it("validates the advanced source budget and preserves the last valid setting", async () => {
	const plugin = { settings: { ...DEFAULT_SETTINGS }, t, saveSettings: vi.fn(async () => {}) } as unknown as AiHelperPlugin;
	const tab = new AiHelperSettingsTab({} as App, plugin);
	const walk = (items: any[]): any[] => items.flatMap(item => [item, ...walk(item.items ?? [])]);
	const page = tab.getSettingDefinitions().find((item: any) => item.name === en["settings-page-search"]) as any;
	const control = walk(page.items).find(item => item.control?.key === "noteSourceBudget").control;
	await tab.setControlValue("noteSourceBudget", "24000");
	expect(plugin.settings.noteSourceBudget).toBe("24000");
	for (const value of ["", "0", "-1", "1.5", "NaN", "Infinity", "9007199254740992"]) {
		expect(control.validate(value)).toBeTruthy();
		await tab.setControlValue("noteSourceBudget", value);
		expect(plugin.settings.noteSourceBudget).toBe("24000");
	}
});


it("restores the saved source budget and defaults invalid persisted values", async () => {
	for (const [value, expected] of [[undefined, "12000"], ["24000", "24000"], ["0", "12000"], [12000, "12000"]]) {
		const plugin = new AiHelperPlugin({} as App, {} as PluginManifest);
		vi.spyOn(plugin, "loadData").mockResolvedValue({ noteSourceBudget: value });
		await plugin.loadSettings(); expect(plugin.settings.noteSourceBudget).toBe(expected);
	}
});

it("defaults legacy settings to local storage and requires a localized confirmation before switching", async () => {
	const { Modal } = await import("./helpers/obsidian");
	const plugin = new AiHelperPlugin({} as App, { id: "obsidian-ai-helper" } as PluginManifest);
	await plugin.loadSettings();
	expect(plugin.settings.indexStorageMode).toBe("local");
	Object.assign(plugin.settings, { embeddingServerUrl: "https://server/v1", embeddingModel: "модель" });
	const switchMode = vi.fn(async () => {});
	Object.assign(plugin, { changeIndexStorage: switchMode });
	for (const locale of ["en", "ru"] as const) {
		setLanguage(locale); controls.length = 0;
		const tab = new AiHelperSettingsTab({} as App, plugin); tab.display();
		const setting = controls.find(control => control.name === t("index-storage-mode"))!;
		expect(setting.description).toContain(".obsidian/plugins/obsidian-ai-helper/note-index");
		expect(setting.description).toContain(".gitignore");
		await setting.dropdown!.change("file");
		expect(plugin.settings.indexStorageMode).toBe("local"); expect(switchMode).not.toHaveBeenCalled();
		const modal = Modal.opened.at(-1)!;
		expect(modal.contentEl.getText()).toContain(t("index-storage-warning"));
		modal.contentEl.find("ai-helper-storage-cancel").click();
		expect(switchMode).not.toHaveBeenCalled();
		await setting.dropdown!.change("file");
		Modal.opened.at(-1)!.contentEl.find("ai-helper-storage-confirm").click();
		await vi.waitFor(() => expect(switchMode).toHaveBeenCalledWith("file"));
		switchMode.mockClear(); tab.hide();
	}
});

it("persists the explicit mode and rebuilds through the confirmed storage action", async () => {
	const { fileIndexAdapter } = await import("./helpers/file-index");
	const adapter = fileIndexAdapter();
	const plugin = new AiHelperPlugin({} as App, { id: "obsidian-ai-helper" } as PluginManifest);
	plugin.settings = { ...DEFAULT_SETTINGS, embeddingServerUrl: "http://s/v1", embeddingModel: "e", autoUpdateNotes: false };
	const client = createServerClient(async () => new Response(JSON.stringify({ data: [{ index: 0, embedding: [1, 0] }] })));
	const search = createNoteSearch({ client, factory: new IDBFactory(), vaultPath: "/confirmed", fileStorage: { adapter, directory: plugin.noteIndexDirectory() }, list: () => ["Train.md"], read: async () => "Train at 18:30", open: async () => {} });
	plugin.noteSearch = search; search.configure(plugin.settings); await search.indexVault();
	const save = vi.fn(async () => {}); Object.assign(plugin, { saveData: save });
	await plugin.changeIndexStorage("file");
	expect(save).toHaveBeenCalledWith(expect.objectContaining({ indexStorageMode: "file" }));
	expect(search.storageMode).toBe("file"); expect(search.progress.state).toBe("complete");
	expect(await search.search("train")).toMatchObject({ path: "Train.md" }); search.dispose();
});

it("does not reuse an old destination after a failed storage switch and restart", async () => {
	const { fileIndexAdapter } = await import("./helpers/file-index");
	const adapter = fileIndexAdapter(); const factory = new IDBFactory();
	const client = createServerClient(async () => new Response(JSON.stringify({ data: [{ index: 0, embedding: [1, 0] }] })));
	const environment = { client, factory, vaultPath: "/failed-switch", fileStorage: { adapter, directory: ".obsidian/plugins/obsidian-ai-helper/note-index" }, list: () => ["Train.md"], read: async () => "Train at 18:30", open: async () => {} };
	const settings = { ...DEFAULT_SETTINGS, embeddingServerUrl: "http://s/v1", embeddingModel: "e", autoUpdateNotes: false };
	const oldFiles = createNoteSearch({ ...environment, storageMode: "file" }); oldFiles.configure(settings); await oldFiles.indexVault(); oldFiles.dispose();
	const local = createNoteSearch(environment); local.configure(settings); await local.indexVault();
	const plugin = new AiHelperPlugin({} as App, { id: "obsidian-ai-helper" } as PluginManifest);
	Object.assign(plugin, { settings, noteSearch: local });
	let persisted = settings; Object.assign(plugin, { saveData: async (value: typeof settings) => { persisted = JSON.parse(JSON.stringify(value)); } });
	adapter.setUnavailable(true); await plugin.changeIndexStorage("file"); local.dispose();
	adapter.setUnavailable(false);
	const reopened = createNoteSearch({ ...environment, storageMode: persisted.indexStorageMode }); reopened.configure(persisted); await reopened.restore(); await reopened.resume();
	expect(reopened.progress.state).toBe("idle");
	await expect(reopened.search("train")).rejects.toMatchObject({ code: "search-rebuild" }); reopened.dispose();
});

it("keeps the displayed and actual mode consistent if the mode selection cannot be saved", async () => {
	const client = createServerClient(async () => new Response(JSON.stringify({ data: [{ index: 0, embedding: [1, 0] }] })));
	const search = createNoteSearch({ client, factory: new IDBFactory(), vaultPath: "/settings-failure", list: () => ["Train.md"], read: async () => "Train", open: async () => {} });
	const plugin = new AiHelperPlugin({} as App, {} as PluginManifest); plugin.settings = { ...DEFAULT_SETTINGS, embeddingServerUrl: "http://s/v1", embeddingModel: "e" };
	plugin.noteSearch = search; search.configure(plugin.settings); await search.indexVault();
	Object.assign(plugin, { saveData: async () => { throw new Error("Settings unavailable"); } });
	await plugin.changeIndexStorage("file");
	expect(plugin.settings.indexStorageMode).toBe(search.storageMode);
	expect(await search.search("train")).toMatchObject({ path: "Train.md" }); search.dispose();
});

it("shows the confirmed mode while rebuilding and ignores a repeated selection", async () => {
	const { fileIndexAdapter } = await import("./helpers/file-index");
	const { Modal } = await import("./helpers/obsidian");
	const adapter = fileIndexAdapter();
	const plugin = new AiHelperPlugin({} as App, { id: "obsidian-ai-helper" } as PluginManifest);
	plugin.settings = { ...DEFAULT_SETTINGS, embeddingServerUrl: "http://s/v1", embeddingModel: "e" };
	const waiting = deferred<Response>(); let hold = false; let requests = 0;
	const response = () => new Response(JSON.stringify({ data: [{ index: 0, embedding: [1, 0] }] }));
	const client = createServerClient(async () => { requests++; return hold ? waiting.promise : response(); });
	const search = createNoteSearch({ client, factory: new IDBFactory(), vaultPath: "/visible-switch", fileStorage: { adapter, directory: plugin.noteIndexDirectory() }, list: () => ["Train.md"], read: async () => "Train at 18:30", open: async () => {} });
	plugin.noteSearch = search; search.configure(plugin.settings); await search.indexVault();
	Object.assign(plugin, { saveData: async () => {} });
	const tab = new AiHelperSettingsTab({} as App, plugin); tab.display();
	let dropdown = controls.find(control => control.name === t("index-storage-mode"))!.dropdown!;
	let clear = controls.find(control => control.name === t("search-vault-clear"))!.button!;
	try {
		hold = true; await dropdown.change("file");
		Modal.opened.at(-1)!.contentEl.find("ai-helper-storage-confirm").click();
		await vi.waitFor(() => expect(requests).toBe(2));
		expect(search.progress.state).toBe("indexing");
		expect(dropdown.value).toBe("file");
		expect(dropdown.selectEl.disabled).toBe(true); expect(clear.buttonEl.disabled).toBe(true);
		controls.length = 0; tab.display();
		dropdown = controls.find(control => control.name === t("index-storage-mode"))!.dropdown!;
		clear = controls.find(control => control.name === t("search-vault-clear"))!.button!;
		expect(dropdown.value).toBe("file"); expect(dropdown.selectEl.disabled).toBe(true);
		await dropdown.change("file"); await dropdown.change("local"); expect(Modal.opened).toHaveLength(0);
		expect(requests).toBe(2);
	} finally {
		hold = false; waiting.resolve(response());
		await vi.waitFor(() => expect(search.progress.state).toBe("complete"));
		await vi.waitFor(() => expect(dropdown.selectEl.disabled).toBe(false)); expect(clear.buttonEl.disabled).toBe(false);
		tab.hide(); search.dispose();
	}
});

it.each(["en", "ru"] as const)("показывает объём блока описаний и обновляет его после изменений (%s)", async locale => {
	const { TFile, TFolder } = await import("./helpers/obsidian");
	setLanguage(locale);
	const texts = new Map([["_folder.md", "Общие правила."], ["Знания/_folder.md", "Справка."], ["Пустая/_folder.md", "# Заголовок"]]);
	const files = [...texts.keys()].map(path => Object.assign(new TFile(), { path, name: "_folder.md", parent: Object.assign(new TFolder(), { path: path.split("/").slice(0, -1).join("/") }) }));
	const events = new Map<string, () => void>();
	const offref = vi.fn();
	const app = { vault: {
		getMarkdownFiles: () => files, read: vi.fn(async (file: { path: string }) => texts.get(file.path)!),
		on: (event: string, callback: () => void) => { events.set(event, callback); return { event }; }, offref,
	} } as unknown as App;
	const plugin = { settings: { ...DEFAULT_SETTINGS }, modelStatus: "idle", t, saveSettings: vi.fn() } as unknown as AiHelperPlugin;
	plugin.folderDescriptions = new FolderDescriptions(app, () => plugin.settings.folderDescriptionName, t);
	const tab = new AiHelperSettingsTab(app, plugin); tab.display();
	const row = controls.find(control => control.name === t("folder-description-name"))!;
	const expected = async () => t("folder-description-context-size").replace("{tokens}",
		(new TextEncoder().encode(JSON.stringify(JSON.stringify(folderSourceData(await plugin.folderDescriptions.sources())))).length - 2).toLocaleString(locale));
	expect(row.description).toContain(t("folder-description-context-loading"));
	const initial = await expected();
	await vi.waitFor(() => expect(row.description).toContain(initial));
	await row.input!.change("Новое.md");
	expect(row.description).toContain(initial);
	texts.set("_folder.md", "Общие правила хранения заметок и справочных материалов."); events.get("modify")!();
	const updated = await expected(); expect(updated).not.toBe(initial);
	await vi.waitFor(() => expect(row.description).toContain(updated));
	vi.mocked(app.vault.read).mockRejectedValue(new Error("Нет доступа")); events.get("modify")!();
	await vi.waitFor(() => expect(row.description).toContain(t("folder-description-context-error")));
	tab.hide(); expect(offref).toHaveBeenCalledTimes(4);
});

it.each(["en", "ru"] as const)("validates and confirms description name changes with all old files counted (%s)", async locale => {
	const { TFile, TFolder, Modal } = await import("./helpers/obsidian");
	setLanguage(locale);
	const names = ["Private/_folder.md", "Empty/_folder.md", "Other/_folder.md", "Other/Note.md"];
	const files = names.map(path => Object.assign(new TFile(), { path, name: path.split("/").at(-1), parent: new TFolder() }));
	const app = { vault: { getMarkdownFiles: () => files } } as unknown as App;
	const plugin = new AiHelperPlugin(app, {} as PluginManifest);
	plugin.settings = { ...DEFAULT_SETTINGS, excludedFolders: ["Private"] };
	const save = vi.spyOn(plugin, "saveSettings").mockResolvedValue();
	const tab = new AiHelperSettingsTab(app, plugin); tab.display();
	const row = controls.find(control => control.name === t("folder-description-name"))!;
	expect(row).toBeDefined();
	for (const invalid of ["", "folder", "folder.txt", "../folder.md", "a/b.md", "a\\b.md", "a: b.md", ".md", "CON.md", "folder .md"]) {
		await row.input!.change(invalid); await row.button!.click();
		expect(plugin.settings.folderDescriptionName).toBe("_folder.md"); expect(Modal.opened).toHaveLength(0);
	}
	await row.input!.change("about.md"); await row.button!.click();
	expect(plugin.settings.folderDescriptionName).toBe("_folder.md"); expect(save).not.toHaveBeenCalled();
	let modal = Modal.opened.at(-1)!;
	expect(modal.contentEl.getText()).toContain("3");
	await controls.find(control => control.button?.buttonEl.classes.has("ai-helper-description-cancel"))!.button!.click();
	expect(plugin.settings.folderDescriptionName).toBe("_folder.md"); expect(save).not.toHaveBeenCalled();
	await row.input!.change("about.md"); await row.button!.click();
	modal = Modal.opened.at(-1)!; await controls.filter(control => control.button?.buttonEl.classes.has("ai-helper-description-confirm")).at(-1)!.button!.click();
	await vi.waitFor(() => expect(save).toHaveBeenCalledOnce());
	expect(plugin.settings.folderDescriptionName).toBe("about.md");
	expect(files.map(file => file.path)).toEqual(names);
	expect(plugin.folderDescriptions.list()).toEqual([]);
	tab.hide();
});

it("keeps name confirmation open while saving and restores the old name on failure", async () => {
	const { Modal } = await import("./helpers/obsidian");
	const plugin = new AiHelperPlugin({ vault: { getMarkdownFiles: () => [] } } as unknown as App, {} as PluginManifest);
	plugin.settings = { ...DEFAULT_SETTINGS };
	let reject!: (error: Error) => void;
	const pending = new Promise<void>((_resolve, fail) => { reject = fail; });
	vi.spyOn(plugin, "saveSettings").mockReturnValue(pending);
	const tab = new AiHelperSettingsTab(plugin.app, plugin); tab.display();
	const row = controls.find(control => control.name === t("folder-description-name"))!;
	await row.input!.change("about.md"); await row.button!.click();
	const modal = Modal.opened.at(-1)!;
	const buttons = (cls: string) => controls.find(control => control.button?.buttonEl.classes.has(cls))!.button!;
	const saving = buttons("ai-helper-description-confirm").click();
	expect(buttons("ai-helper-description-cancel").buttonEl.disabled).toBe(true);
	modal.close(); expect(Modal.opened).toContain(modal);
	reject(new Error("Settings unavailable")); await saving;
	expect(plugin.settings.folderDescriptionName).toBe("_folder.md");
	expect(buttons("ai-helper-description-cancel").buttonEl.disabled).toBe(false);
	await buttons("ai-helper-description-cancel").click(); expect(Modal.opened).not.toContain(modal);
	tab.hide();
});


async function descriptionRenameSettings(name = "about.md") {
	const { TFile, TFolder, Modal } = await import("./helpers/obsidian");
	const entries = new Map<string, { file: InstanceType<typeof TFile>; text: string }>();
	const add = (path: string, text: string) => {
		const folderPath = path.split("/").slice(0, -1).join("/");
		const file = Object.assign(new TFile(), { path, name: path.split("/").at(-1)!, parent: Object.assign(new TFolder(), { path: folderPath }) });
		entries.set(path, { file, text }); return file;
	};
	add("_folder.md", "Root rules"); add("Private/_folder.md", "Private rules");
	add("Empty/_folder.md", "## Purpose\n<!-- What this folder is for -->\n");
	add("Other/Note.md", "Ordinary note");
	let fail = (_from: string, _to: string) => false;
	const moves: string[] = [];
	const app = { vault: {
		getMarkdownFiles: () => [...entries.values()].map(entry => entry.file),
		getAbstractFileByPath: (path: string) => entries.get(path)?.file ?? null,
		adapter: { exists: async (path: string) => entries.has(path) },
		read: async (file: { path: string }) => entries.get(file.path)!.text,
	}, fileManager: { renameFile: async (file: { path: string; name: string }, path: string) => {
		moves.push(path);
		if (fail(file.path, path)) throw new Error("Controlled rename failure");
		if (entries.has(path)) throw new Error("Occupied destination");
		const entry = entries.get(file.path)!; entries.delete(file.path);
		file.path = path; file.name = path.split("/").at(-1)!; entries.set(path, entry);
	} } } as unknown as App;
	const plugin = new AiHelperPlugin(app, {} as PluginManifest);
	plugin.settings = { ...DEFAULT_SETTINGS, excludedFolders: ["Private"] };
	const saved: string[] = [];
	const save = vi.spyOn(plugin, "saveSettings").mockImplementation(async () => { saved.push(plugin.settings.folderDescriptionName); });
	const tab = new AiHelperSettingsTab(app, plugin); tab.display();
	const row = controls.find(control => control.name === t("folder-description-name"))!;
	await row.input!.change(name); await row.button!.click();
	const modal = Modal.opened.at(-1)!;
	const button = (cls: string) => controls.filter(control => control.button?.buttonEl.classes.has(cls)).at(-1)!.button!;
	return { plugin, entries, add, moves, saved, save, tab, modal, button, setFailure: (value: typeof fail) => { fail = value; } };
}

it("renames every description through settings before saving, including root, templates and exclusions", async () => {
	const env = await descriptionRenameSettings();
	try {
		expect(env.modal.contentEl.getText()).toContain("3");
		await env.button("ai-helper-description-rename").click();
		expect([...env.entries.keys()].sort()).toEqual(["Empty/about.md", "Other/Note.md", "Private/about.md", "about.md"]);
		expect(env.entries.get("Private/about.md")!.text).toBe("Private rules");
		expect(env.entries.get("Empty/about.md")!.text).toBe("## Purpose\n<!-- What this folder is for -->\n");
		expect(env.saved).toEqual(["about.md"]);
		expect(env.plugin.folderDescriptions.list()).toHaveLength(3);
	} finally { env.modal.close(); env.tab.hide(); }
});

it.each(["retry", "settings only"])("checks all conflicts before moving files and allows %s", async choice => {
	const env = await descriptionRenameSettings();
	try {
		env.add("Private/about.md", "Keep private conflict"); env.add("Empty/about.md", "Keep empty conflict");
		await env.button("ai-helper-description-rename").click();
		expect(env.moves).toEqual([]); expect(env.saved).toEqual([]);
		expect(env.plugin.settings.folderDescriptionName).toBe("_folder.md");
		expect(env.modal.contentEl.getText()).toContain("Private/about.md");
		expect(env.modal.contentEl.getText()).toContain("Empty/about.md");
		if (choice === "retry") {
			env.entries.delete("Private/about.md"); env.entries.delete("Empty/about.md");
			await env.button("ai-helper-description-rename").click();
			expect(env.entries.has("Private/_folder.md")).toBe(false);
		} else {
			await env.button("ai-helper-description-confirm").click();
			expect(env.entries.get("Private/about.md")!.text).toBe("Keep private conflict");
			expect(env.moves).toEqual([]);
		}
		expect(env.saved).toEqual(["about.md"]);
	} finally { env.modal.close(); env.tab.hide(); }
});

it("restores renamed files and the old setting when a later rename fails", async () => {
	const env = await descriptionRenameSettings();
	try {
		env.setFailure((_from, to) => to === "Empty/about.md");
		await env.button("ai-helper-description-rename").click();
		expect([...env.entries.keys()].sort()).toEqual(["Empty/_folder.md", "Other/Note.md", "Private/_folder.md", "_folder.md"]);
		expect(env.entries.get("Private/_folder.md")!.text).toBe("Private rules");
		expect(env.saved).toEqual([]); expect(env.plugin.settings.folderDescriptionName).toBe("_folder.md");
		expect(env.modal.contentEl.getText()).toContain(t("folder-description-restored"));
	} finally { env.modal.close(); env.tab.hide(); }
});

it("reports exact residual paths and continues restoring other files when rollback fails", async () => {
	const env = await descriptionRenameSettings();
	try {
		env.setFailure((_from, to) => to === "Empty/about.md" || to === "Private/_folder.md");
		await env.button("ai-helper-description-rename").click();
		expect([...env.entries.keys()].sort()).toEqual(["Empty/_folder.md", "Other/Note.md", "Private/about.md", "_folder.md"]);
		expect(env.saved).toEqual([]); expect(env.plugin.settings.folderDescriptionName).toBe("_folder.md");
		expect(env.modal.contentEl.getText()).toContain(t("folder-description-restore-incomplete"));
		expect(env.modal.contentEl.getText()).toContain("Private/about.md → Private/_folder.md");
		expect(env.modal.contentEl.getText()).not.toContain(t("folder-description-restored"));
	} finally { env.modal.close(); env.tab.hide(); }
});

it("restores the whole rename set if the new setting cannot be persisted", async () => {
	const env = await descriptionRenameSettings();
	try {
		env.save.mockRejectedValue(new Error("Settings unavailable"));
		await env.button("ai-helper-description-rename").click();
		expect([...env.entries.keys()].sort()).toEqual(["Empty/_folder.md", "Other/Note.md", "Private/_folder.md", "_folder.md"]);
		expect(env.plugin.settings.folderDescriptionName).toBe("_folder.md");
		expect(env.modal.contentEl.getText()).toContain(t("folder-description-restored"));
	} finally { env.modal.close(); env.tab.hide(); }
});

it("preflights folders and adapter-only destinations as conflicts", async () => {
	const env = await descriptionRenameSettings();
	try {
		const { TFolder } = await import("./helpers/obsidian");
		const lookup = env.plugin.app.vault.getAbstractFileByPath.bind(env.plugin.app.vault);
		vi.spyOn(env.plugin.app.vault, "getAbstractFileByPath").mockImplementation(path => path === "Private/about.md" ? Object.assign(new TFolder(), { path }) : lookup(path));
		vi.spyOn(env.plugin.app.vault.adapter, "exists").mockImplementation(async path => path === "Empty/about.md");
		await env.button("ai-helper-description-rename").click();
		expect(env.moves).toEqual([]); expect(env.saved).toEqual([]);
		expect(env.modal.contentEl.getText()).toContain("Private/about.md");
		expect(env.modal.contentEl.getText()).toContain("Empty/about.md");
	} finally { env.modal.close(); env.tab.hide(); }
});

it("preserves a file that appears at the old path during rollback", async () => {
	const env = await descriptionRenameSettings();
	try {
		env.setFailure((_from, to) => {
			if (to !== "Empty/about.md") return false;
			env.add("Private/_folder.md", "External content"); return true;
		});
		await env.button("ai-helper-description-rename").click();
		expect(env.entries.get("Private/_folder.md")!.text).toBe("External content");
		expect(env.entries.get("Private/about.md")!.text).toBe("Private rules");
		expect(env.modal.contentEl.getText()).toContain("Private/about.md → Private/_folder.md");
		expect(env.entries.has("about.md")).toBe(false);
	} finally { env.modal.close(); env.tab.hide(); }
});

it("keeps the previous setting and disables all actions until renaming finishes", async () => {
	const env = await descriptionRenameSettings();
	try {
		const pending = deferred<void>();
		const rename = env.plugin.app.fileManager.renameFile.bind(env.plugin.app.fileManager);
		let first = true;
		vi.spyOn(env.plugin.app.fileManager, "renameFile").mockImplementation(async (file, path) => {
			if (first) { first = false; await pending.promise; } await rename(file, path);
		});
		const operation = env.button("ai-helper-description-rename").click();
		await vi.waitFor(() => expect(first).toBe(false));
		expect(env.plugin.settings.folderDescriptionName).toBe("_folder.md"); expect(env.saved).toEqual([]);
		for (const cls of ["ai-helper-description-confirm", "ai-helper-description-rename", "ai-helper-description-cancel"]) expect(env.button(cls).buttonEl.disabled).toBe(true);
		env.modal.close();
		const { Modal } = await import("./helpers/obsidian"); expect(Modal.opened).toContain(env.modal);
		pending.resolve(); await operation;
		expect(env.saved).toEqual(["about.md"]);
	} finally { env.modal.close(); env.tab.hide(); }
});

it.each(["cancel", "settings only"])("preserves all vault contents when choosing %s", async choice => {
	const env = await descriptionRenameSettings();
	try {
		const contents = [...env.entries].map(([path, entry]) => [path, entry.text]);
		await env.button(choice === "cancel" ? "ai-helper-description-cancel" : "ai-helper-description-confirm").click();
		expect([...env.entries].map(([path, entry]) => [path, entry.text])).toEqual(contents);
		expect(env.moves).toEqual([]);
		expect(env.plugin.settings.folderDescriptionName).toBe(choice === "cancel" ? "_folder.md" : "about.md");
		expect(env.saved).toEqual(choice === "cancel" ? [] : ["about.md"]);
	} finally { env.modal.close(); env.tab.hide(); }
});

it("restores a file even if the external operation moves it and then rejects", async () => {
	const env = await descriptionRenameSettings();
	try {
		const rename = env.plugin.app.fileManager.renameFile.bind(env.plugin.app.fileManager);
		vi.spyOn(env.plugin.app.fileManager, "renameFile").mockImplementation(async (file, path) => {
			await rename(file, path);
			if (path === "Private/about.md") throw new Error("Link update failed after move");
		});
		await env.button("ai-helper-description-rename").click();
		expect([...env.entries.keys()].sort()).toEqual(["Empty/_folder.md", "Other/Note.md", "Private/_folder.md", "_folder.md"]);
		expect(env.plugin.settings.folderDescriptionName).toBe("_folder.md"); expect(env.saved).toEqual([]);
		expect(env.modal.contentEl.getText()).toContain(t("folder-description-restored"));
	} finally { env.modal.close(); env.tab.hide(); }
});


it.each(["success", "rollback"])("supports case-only name changes on a case-insensitive vault (%s)", async outcome => {
	const env = await descriptionRenameSettings("_Folder.md");
	try {
		vi.spyOn(env.plugin.app.vault.adapter, "exists").mockImplementation(async (path, sensitive) =>
			sensitive ? env.entries.has(path) : [...env.entries.keys()].some(key => key.toLowerCase() === path.toLowerCase()));
		if (outcome === "rollback") env.setFailure((_from, to) => to === "Empty/_Folder.md");
		await env.button("ai-helper-description-rename").click();
		if (outcome === "success") {
			expect([...env.entries.keys()].sort()).toEqual(["Empty/_Folder.md", "Other/Note.md", "Private/_Folder.md", "_Folder.md"]);
			expect(env.saved).toEqual(["_Folder.md"]);
		} else {
			expect([...env.entries.keys()].sort()).toEqual(["Empty/_folder.md", "Other/Note.md", "Private/_folder.md", "_folder.md"]);
			expect(env.saved).toEqual([]);
			expect(env.modal.contentEl.getText()).toContain(t("folder-description-restored"));
		}
	} finally { env.modal.close(); env.tab.hide(); }
});

it("does not overwrite a distinct case-only destination on a case-sensitive vault", async () => {
	const env = await descriptionRenameSettings("_Folder.md");
	try {
		env.add("Private/_Folder.md", "Different description");
		await env.button("ai-helper-description-rename").click();
		expect(env.moves).toEqual([]); expect(env.saved).toEqual([]);
		expect(env.entries.get("Private/_Folder.md")!.text).toBe("Different description");
		expect(env.modal.contentEl.getText()).toContain("Private/_Folder.md");
	} finally { env.modal.close(); env.tab.hide(); }
});


it("объясняет отсутствие embeddings в настройках и блокирует перестроение и смену хранения", async () => {
	const { Modal, Notice } = await import("./helpers/obsidian");
	setLanguage("ru"); controls.length = 0; Notice.messages.length = 0;
	const plugin = new AiHelperPlugin({} as App, { id: "obsidian-ai-helper" } as PluginManifest);
	plugin.settings = { ...DEFAULT_SETTINGS };
	const tab = new AiHelperSettingsTab({} as App, plugin); tab.display();
	const previousModals = Modal.opened.length;
	await controls.find(control => control.name === t("index-storage-mode"))!.dropdown!.change("file");
	await controls.find(control => control.name === t("search-vault-index"))!.button!.click();
	expect(Modal.opened).toHaveLength(previousModals);
	expect(plugin.settings.indexStorageMode).toBe("local");
	expect(Notice.messages).toEqual(Array(2).fill(t("search-setup-required")));
	tab.hide();
});

it("инициализирует язык и суффикс перевода один раз и различает отсутствующий и пустой промпт", async () => {
	const plugin = new AiHelperPlugin({} as App, {} as PluginManifest);
	let stored: unknown = { language: "ru" };
	vi.spyOn(plugin, "loadData").mockImplementation(async () => stored);
	const save = vi.fn(async (value: unknown) => { stored = structuredClone(value); });
	Object.assign(plugin, { saveData: save });
	await plugin.loadSettings();
	expect(plugin.settings.translationLanguage).toBe("Русский");
	expect(plugin.settings.translationSuffix).toBe(" — ru");
	expect(plugin.settings.translationPrompt).toContain("You are a professional translator and editor.");
	expect(save).toHaveBeenCalled();
	stored = { ...plugin.settings, language: "en", translationPrompt: "" };
	await plugin.loadSettings();
	expect(plugin.settings.translationLanguage).toBe("Русский"); expect(plugin.settings.translationSuffix).toBe(" — ru");
	expect(plugin.settings.translationPrompt).toBe("");
});
it("сброс промпта сразу меняет поле и сохраняет встроенный текст, пустые пожелания допустимы", async () => {
	setLanguage("ru");
	const saveSettings = vi.fn(async () => {});
	const plugin = { settings: { ...DEFAULT_SETTINGS, translationPrompt: "Пользовательский стиль" }, modelStatus: "idle", t, saveSettings } as unknown as AiHelperPlugin;
	const tab = new AiHelperSettingsTab({} as App, plugin); tab.display();
	const setting = controls.find(control => control.name === "Промпт перевода")!;
	await setting.input!.change(""); expect(plugin.settings.translationPrompt).toBe("");
	await setting.button!.click();
	expect(plugin.settings.translationPrompt).toBe(DEFAULT_SETTINGS.translationPrompt);
	expect(setting.input!.value).toBe(DEFAULT_SETTINGS.translationPrompt);
	expect(saveSettings).toHaveBeenCalledTimes(2);
	await tab.setControlValue("translationLanguage", "Японский"); expect(plugin.settings.translationLanguage).toBe("Японский");
	await tab.setControlValue("translationLanguage", " "); expect(plugin.settings.translationLanguage).toBe("Японский");
	await tab.setControlValue("translationSuffix", " — ja"); expect(plugin.settings.translationSuffix).toBe(" — ja");
	await tab.setControlValue("translationOpenSideBySide", false); expect(plugin.settings.translationOpenSideBySide).toBe(false);
});

it("режим отладки перевода выключен по умолчанию и сохраняется переключателем", async () => {
	expect(DEFAULT_SETTINGS.translationDebugMode).toBe(false);
	setLanguage("ru");
	const saveSettings = vi.fn(async () => {});
	const plugin = { settings: { ...DEFAULT_SETTINGS }, modelStatus: "idle", t, saveSettings } as unknown as AiHelperPlugin;
	const tab = new AiHelperSettingsTab({} as App, plugin); tab.display();
	const setting = controls.find(control => control.name === "Режим отладки")!;
	expect(setting.toggle).toBeDefined();
	await setting.toggle!.change(true);
	expect(plugin.settings.translationDebugMode).toBe(true);
	expect(saveSettings).toHaveBeenCalledOnce();
});

it("настройки перевода сохраняют режим папки и отдельный путь, включая пустой", async () => {
	setLanguage("ru");
	const saveSettings = vi.fn(async () => {});
	const plugin = { settings: { ...DEFAULT_SETTINGS }, modelStatus: "idle", t, saveSettings } as unknown as AiHelperPlugin;
	const tab = new AiHelperSettingsTab({} as App, plugin); tab.display();
	expect(plugin.settings.translationFolderMode).toBe("original");
	expect(controls.find(control => control.name === "Сохранять перевод в")).toBeDefined();
	const folder = controls.find(control => control.name === "Папка перевода")!;
	expect(folder.input).toBeDefined();
	await tab.setControlValue("translationFolderMode", "custom");
	await folder.input!.change("Переводы/Статьи");
	expect(plugin.settings.translationFolderMode).toBe("custom");
	expect(plugin.settings.translationFolder).toBe("Переводы/Статьи");
	await folder.input!.change("");
	expect(plugin.settings.translationFolder).toBe("");
	expect(saveSettings).toHaveBeenCalledTimes(3);
});
