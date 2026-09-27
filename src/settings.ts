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
	language: Locale;
}

export const DEFAULT_SETTINGS: AiHelperSettings = {
	serverUrl: "",
	apiKey: "",
	model: "",
	language: "en",
};

export type ModelStatus = "idle" | "loaded" | "empty" | "error";

export class AiHelperSettingsTab extends PluginSettingTab {
	plugin: AiHelperPlugin;

	private modelsEl: HTMLDivElement | null = null;

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
		this.modelsEl = null;

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
		this.modelsEl = modelSetting.controlEl.createDiv({ cls: "ai-helper-models" });
		this.renderModels(modelSetting);

		new Setting(containerEl)
			.setName(this.t("setting-refresh-models"))
			.setDesc(this.t("setting-refresh-models-desc"))
			.addButton((button) => {
				button
					.setButtonText(this.t("setting-refresh-models"))
					.onClick(async () => {
						button.setDisabled(true);
						await this.plugin.refreshModels();
						button.setDisabled(false);
						this.renderModels(modelSetting);
					});
			});
	}

	private renderModels(modelSetting: Setting): void {
		if (!this.modelsEl) return;
		this.modelsEl.empty();
		modelSetting.controlEl.empty();
		this.modelsEl = modelSetting.controlEl.createDiv({ cls: "ai-helper-models" });

		const { models, modelStatus } = this.plugin;
		const selected = this.plugin.settings.model;

		if (modelStatus === "loaded") {
			modelSetting.addDropdown((dropdown) => {
				for (const id of models) {
					dropdown.addOption(id, id);
				}
				if (selected && !models.includes(selected)) {
					dropdown.addOption(selected, selected);
				}
				dropdown
					.setValue(selected)
					.onChange(async (value: string) => {
						await this.plugin.saveModel(value);
					});
			});
		} else {
			modelSetting.addText((text) => {
				text
					.setPlaceholder(this.t("setting-model-placeholder"))
					.setValue(selected)
					.onChange(async (value) => {
						await this.plugin.saveModel(value.trim());
					});
			});

			if (modelStatus === "empty" || modelStatus === "error") {
				const desc = this.t(
					modelStatus === "empty" ? "setting-models-empty" : "setting-models-load-error"
				);
				modelSetting.controlEl.createDiv({
					cls: "ai-helper-models-hint",
					text: desc,
				});
			}
		}
	}
}
