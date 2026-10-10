import { afterEach, expect, it, vi } from "vitest";
import type { App, PluginManifest } from "obsidian";
import { AiHelperPlugin } from "../src/main";
import { AiHelperSettingsTab, DEFAULT_SETTINGS } from "../src/settings";
import { en, ru, setLanguage, t } from "../src/i18n";
import { TestElement } from "./helpers/obsidian";

const controls = vi.hoisted(() => [] as Array<{ name: string; description: string; input?: { value: string; inputEl: TestElement; change: (value: string) => Promise<void> } }>);
vi.mock("obsidian", async () => {
	const helper = await import("./helpers/obsidian");
	return { ...helper,
		PluginSettingTab: class { containerEl = new helper.TestElement(); },
		Setting: class {
			name = ""; description = ""; controlEl = new helper.TestElement();
			input?: { value: string; inputEl: TestElement; change: (value: string) => Promise<void> };
			constructor() { controls.push(this); }
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
			addButton(callback: (button: unknown) => void) { callback({ setButtonText() { return this; }, onClick() { return this; } }); return this; }
		},
	};
});
afterEach(() => { controls.length = 0; setLanguage("en"); });

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
