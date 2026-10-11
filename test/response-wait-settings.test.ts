import { afterEach, expect, it, vi } from "vitest";
import { FileSystemAdapter, type App, type PluginManifest } from "obsidian";
import { IDBFactory } from "fake-indexeddb";
import { AiHelperPlugin } from "../src/main";
import { createNoteSearch } from "../src/note-index";
import { createServerClient } from "../src/server-client";
import { AiHelperSettingsTab, DEFAULT_SETTINGS } from "../src/settings";
import { en, ru, setLanguage, t } from "../src/i18n";
import { deferred, TestElement } from "./helpers/obsidian";

const controls = vi.hoisted(() => [] as Array<{ name: string; description: string; picker?: { value: string; disabled: boolean; change: (value: string) => Promise<void> }; button?: { click: () => Promise<void> }; dropdown?: { value: string; options: Record<string, string>; change: (value: string) => Promise<void> }; input?: { value: string; inputEl: TestElement; change: (value: string) => Promise<void> } }>);
vi.mock("obsidian", async () => {
	const helper = await import("./helpers/obsidian");
	return { ...helper,
		PluginSettingTab: class { containerEl = new helper.TestElement(); },
		Setting: class {
			name = ""; get description() { return this.descEl.getText(); } controlEl = new helper.TestElement(); descEl = new helper.TestElement();
			input?: { value: string; inputEl: TestElement; change: (value: string) => Promise<void> };
			dropdown?: { value: string; options: Record<string, string>; change: (value: string) => Promise<void> };
			constructor() {
				controls.push(this);
				this.controlEl.empty = () => { this.input = undefined; this.dropdown = undefined; };
			}
			setClass() { return this; }
			setName(name: string) { this.name = name; return this; }
			setDesc(description: string) { this.descEl.setText(description); return this; }
			addToggle(callback: (toggle: unknown) => void) {
				callback({ setValue() { return this; }, onChange() { return this; } }); return this;
			}
			addText(callback: (text: unknown) => void) { return this.addTextArea(callback); }
			addTextArea(callback: (text: unknown) => void) {
				const input = { value: "", inputEl: new helper.TestElement(), change: async (_value: string) => {},
					setPlaceholder() { return this; }, setValue(value: string) { this.value = value; return this; },
					onChange(change: (value: string) => Promise<void>) { this.change = change; return this; } };
				this.input = input; callback(input); return this;
			}
			addDropdown(callback: (dropdown: unknown) => void) {
				const dropdown = { selectEl: new helper.TestElement(), value: "", options: {} as Record<string, string>, change: async (_value: string) => {},
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
	const handlers = new Map<string, (...args: any[]) => void>();
	const on = (event: string, callback: (...args: any[]) => void) => { handlers.set(event, callback); return {}; };
	const app = { vault: { adapter, on, getMarkdownFiles: () => [], getAbstractFileByPath: () => ({ path: "Secrets" }) }, workspace: { on, onLayoutReady: () => {}, detachLeavesOfType: () => {} } } as unknown as App;
	const plugin = new AiHelperPlugin(app, {} as PluginManifest);
	vi.spyOn(plugin, "loadData").mockResolvedValue({ ...DEFAULT_SETTINGS, excludedFolders: ["Private", "Private/Nested", "Private-public"] });
	const saving = vi.fn(async () => {}); Object.assign(plugin, { saveData: saving });
	const tabs = vi.spyOn(plugin, "addSettingTab"); await plugin.onload();
	const tab = tabs.mock.calls[0][0] as AiHelperSettingsTab; tab.display();
	const setting = controls.find(value => value.name === en["setting-excluded-folders"])!;
	handlers.get("rename")!({ path: "Secrets" }, "Private");
	try {
		expect(setting.input!.value).toBe("Secrets\nSecrets/Nested\nPrivate-public");
		expect(plugin.settings.excludedFolders).toEqual(["Secrets", "Secrets/Nested", "Private-public"]);
		await vi.waitFor(() => expect(saving).toHaveBeenCalledWith(expect.objectContaining({ excludedFolders: ["Secrets", "Secrets/Nested", "Private-public"] })));
	} finally { plugin.onunload(); }
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
