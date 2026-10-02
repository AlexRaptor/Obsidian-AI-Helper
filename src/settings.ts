import { App, PluginSettingTab, Setting } from "obsidian";
import type { AiHelperPlugin } from "./main";
import {
	setLanguage,
	LOCALES,
	LOCALE_NAMES,
	type Locale,
	type LocaleKey,
} from "./i18n";

export interface AiHelperSettings {
	serverUrl: string;
	apiKey: string;
	model: string;
	systemPrompt: string;
	temperature: string;
	maxTokens: string;
	topP: string;
	language: Locale;
}

export const DEFAULT_SETTINGS: AiHelperSettings = {
	serverUrl: "",
	apiKey: "",
	model: "",
	systemPrompt: "",
	temperature: "",
	maxTokens: "",
	topP: "",
	language: "en",
};

export type ModelStatus = "idle" | "loaded" | "empty" | "error";

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
						await this.plugin.refreshLocale();
						this.display();
					});
			});

		new Setting(containerEl)
			.setName(this.t("setting-server-url"))
			.setDesc(this.t("setting-server-url-desc"))
			.addText((text) => {
				text
					.setPlaceholder(this.t("setting-server-url-placeholder"))
					.setValue(this.plugin.settings.serverUrl)
					.onChange(async (value) => {
						this.plugin.settings.serverUrl = value.trim();
						await this.plugin.saveSettings();
						await this.refreshModels();
					});
			});

		new Setting(containerEl)
			.setName(this.t("setting-api-key"))
			.setDesc(this.t("setting-api-key-desc"))
			.addText((text) => {
				text
					.setPlaceholder(this.t("setting-api-key-placeholder"))
					.setValue(this.plugin.settings.apiKey)
					.onChange(async (value) => {
						this.plugin.settings.apiKey = value.trim();
						await this.plugin.saveSettings();
					});
			});

		const modelSetting = new Setting(containerEl)
			.setName(this.t("setting-model"))
			.setDesc(this.t("setting-model-desc"));
		this.renderModels(modelSetting);

		new Setting(containerEl)
			.setName(this.t("setting-refresh-models"))
			.setDesc(this.t("setting-refresh-models-desc"))
			.addButton((button) => {
				button
					.setButtonText(this.t("setting-refresh-models"))
					.onClick(async () => {
						await this.refreshModels();
					});
			});

		new Setting(containerEl)
			.setName(this.t("setting-system-prompt"))
			.setDesc(this.t("setting-system-prompt-desc"))
			.addTextArea((textarea) => {
				textarea
					.setPlaceholder(this.t("setting-system-prompt-placeholder"))
					.setValue(this.plugin.settings.systemPrompt)
					.onChange(async (value) => {
						this.plugin.settings.systemPrompt = value;
						await this.plugin.saveSettings();
					});
			});

		new Setting(containerEl)
			.setName(this.t("setting-generation"))
			.setDesc(this.t("setting-generation-desc"));

		new Setting(containerEl)
			.setName(this.t("setting-temperature"))
			.addText((text) => {
				text
					.setPlaceholder("0.7")
					.setValue(this.plugin.settings.temperature)
					.onChange(async (value) => {
						this.plugin.settings.temperature = value.trim();
						await this.plugin.saveSettings();
					});
			});

		new Setting(containerEl)
			.setName(this.t("setting-max-tokens"))
			.addText((text) => {
				text
					.setPlaceholder("1024")
					.setValue(this.plugin.settings.maxTokens)
					.onChange(async (value) => {
						this.plugin.settings.maxTokens = value.trim();
						await this.plugin.saveSettings();
					});
			});

		new Setting(containerEl)
			.setName(this.t("setting-top-p"))
			.addText((text) => {
				text
					.setPlaceholder("0.9")
					.setValue(this.plugin.settings.topP)
					.onChange(async (value) => {
						this.plugin.settings.topP = value.trim();
						await this.plugin.saveSettings();
					});
			});
	}

	private async refreshModels(): Promise<void> {
		await this.plugin.refreshModels();
		this.display();
	}

	private renderModels(modelSetting: Setting): void {
		modelSetting.controlEl.empty();

		const { models, modelStatus } = this.plugin;
		const selected = this.plugin.settings.model;

		if (modelStatus === "loaded") {
			modelSetting.addDropdown((dropdown) => {
				for (const id of models) {
					dropdown.addOption(id, id);
				}
				dropdown
					.setValue(selected)
					.onChange(async (value: string) => {
						this.plugin.settings.model = value;
						await this.plugin.saveSettings();
					});
			});
		} else {
			modelSetting.addText((text) => {
				text
					.setPlaceholder(this.t("setting-model-placeholder"))
					.setValue(selected)
					.onChange(async (value) => {
						this.plugin.settings.model = value.trim();
						await this.plugin.saveSettings();
					});
			});

			if (modelStatus === "empty" || modelStatus === "error") {
				const desc = this.t(
					modelStatus === "empty" ? "setting-models-empty" : "setting-models-load-error"
				);
				modelSetting.controlEl.createDiv({
					cls: `ai-helper-models-hint ai-helper-models-hint-${modelStatus}`,
					text: desc,
				});
			}
		}
	}
}
