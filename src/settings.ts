import { PluginSettingTab, App, Setting } from "obsidian";
import type { AiHelperPlugin } from "./main";
import { setLanguage, LOCALES, LOCALE_NAMES, type Locale, type LocaleKey } from "./i18n";

export interface AiHelperSettings {
	serverUrl: string;
	apiKey: string;
	model: string;
	language: Locale;
}

export const DEFAULT_SETTINGS: AiHelperSettings = {
	serverUrl: "",
	apiKey: "",
	model: "",
	language: "en",
};

export class AiHelperSettingsTab extends PluginSettingTab {
	plugin: AiHelperPlugin;

	constructor(app: App, plugin: AiHelperPlugin) {
		super(app, plugin);
		this.plugin = plugin;
	}

	t(key: LocaleKey): string {
		return this.plugin.t(key);
	}

	display(): void {
		const { containerEl } = this;
		containerEl.empty();

		const title = containerEl.createEl("h2", { text: this.t("settings-title") });
		title.addClass("ai-helper-settings-title");

		new Setting(containerEl)
			.setName(this.t("setting-language"))
			.setDesc(this.t("setting-language-desc"))
			.addDropdown((dropdown) => {
				for (const code of LOCALES) {
					dropdown.addOption(code, LOCALE_NAMES[code]);
				}
				dropdown
					.setValue(this.plugin.settings.language)
					.onChange(async (value: string) => {
						this.plugin.settings.language = value as Locale;
						setLanguage(value as Locale);
						await this.plugin.saveSettings();
						this.plugin.refreshLocale();
						this.display();
					});
			});

		new Setting(containerEl)
			.setName(this.t("setting-server-url"))
			.setDesc(this.t("setting-server-url-desc"))
			.addText((text) => {
				text
					.setPlaceholder("http://localhost:1234/v1")
					.setValue(this.plugin.settings.serverUrl)
					.onChange(async (value) => {
						this.plugin.settings.serverUrl = value.trim();
						await this.plugin.saveSettings();
					});
			});

		new Setting(containerEl)
			.setName(this.t("setting-api-key"))
			.setDesc(this.t("setting-api-key-desc"))
			.addText((text) => {
				text
					.setPlaceholder("sk-...")
					.setValue(this.plugin.settings.apiKey)
					.onChange(async (value) => {
						this.plugin.settings.apiKey = value.trim();
						await this.plugin.saveSettings();
					});
			});

		new Setting(containerEl)
			.setName(this.t("setting-model"))
			.setDesc(this.t("setting-model-desc"))
			.addText((text) => {
				text
					.setPlaceholder(this.t("setting-model-placeholder"))
					.setValue(this.plugin.settings.model)
					.onChange(async (value) => {
						this.plugin.settings.model = value.trim();
						await this.plugin.saveSettings();
					});
			});
	}
}
