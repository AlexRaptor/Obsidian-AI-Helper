import { App, PluginSettingTab, Setting, ProgressBarComponent, type ColorComponent, type SliderComponent, type TextComponent, type SettingDefinition, type SettingDefinitionItem, type SettingDefinitionGroup, type SettingDefinitionList } from "obsidian";
import { IndexStorageModal } from "./index-storage-modal";
import type { IndexStorageMode } from "./note-index";
import type { AiHelperPlugin } from "./main";
import type { EmbeddingConnection } from "./note-search";
import { DEFAULT_SOURCE_BUDGET_BYTES, sourceBudgetBytes, DEFAULT_MIN_SOURCE_SIMILARITY, isValidMinimumSimilarity, DEFAULT_NOTE_UPDATE_DELAY_SECONDS, isValidNoteUpdateDelay } from "./note-index";
import { DEFAULT_FRAGMENT_OPTIONS, isValidFragmentOptions, type FragmentOptions } from "./note-fragments";
import { DEFAULT_SIMILARITY_APPEARANCE, SIMILARITY_COLORS, validSimilarityBoundaries, isSimilarityColor, type SimilarityAppearance } from "./similarity-appearance";
import { parseResponseWait } from "./response-wait";
import { effectiveContextWindow } from "./context-window";
import {
	LOCALE_NAMES,
	getLanguage,
	type LanguagePreference,
	type LocaleKey,
} from "./i18n";

export interface AiHelperSettings extends EmbeddingConnection, FragmentOptions {
	indexStorageMode: IndexStorageMode;
	indexStorageGeneration: string;
	noteSourceBudget: string;
	noteSearchMinSimilarity: number;
	excludedFolders: string[];
	autoUpdateNotes: boolean;
	noteUpdateDelaySeconds: number;
	similarityAppearance: SimilarityAppearance;
	serverUrl: string;
	apiKey: string;
	model: string;
	systemPrompt: string;
	temperature: string;
	maxTokens: string;
	topP: string;
	contextWindow: string;
	responseWait: string;
	language: LanguagePreference;
}

export const DEFAULT_SETTINGS: AiHelperSettings = {
	...DEFAULT_FRAGMENT_OPTIONS,
	indexStorageMode: "local",
	indexStorageGeneration: "",
	noteSourceBudget: String(DEFAULT_SOURCE_BUDGET_BYTES),
	noteSearchMinSimilarity: DEFAULT_MIN_SOURCE_SIMILARITY,
	excludedFolders: [],
	autoUpdateNotes: true,
	noteUpdateDelaySeconds: DEFAULT_NOTE_UPDATE_DELAY_SECONDS,
	similarityAppearance: DEFAULT_SIMILARITY_APPEARANCE,
	embeddingServerUrl: "",
	embeddingApiKey: "",
	embeddingModel: "",
	serverUrl: "",
	apiKey: "",
	model: "",
	systemPrompt: "",
	temperature: "",
	maxTokens: "",
	topP: "",
	contextWindow: "",
	responseWait: "",
	language: "auto",
};

export type ModelStatus = "idle" | "loaded" | "empty" | "error";

export class AiHelperSettingsTab extends PluginSettingTab {
	private modelSetting?: Setting;
	private embeddingModelSetting?: Setting;
	private updateModelStatus?: () => void;
	private updateEmbeddingStatus?: () => void;
	private folderDraft?: string;
	private updateFolderWarnings?: () => void;

	constructor(app: App, public plugin: AiHelperPlugin) { super(app, plugin); this.icon = "message-square"; }

	t(key: LocaleKey): string { return this.plugin.t(key); }

	private row(name: LocaleKey, desc: LocaleKey | undefined, render: (setting: Setting) => void | (() => void)): SettingDefinition {
		return { name: this.t(name), desc: desc ? this.t(desc) : undefined, render };
	}

	private text(key: string, name: LocaleKey, desc: LocaleKey, placeholder?: LocaleKey, textarea = false): SettingDefinition {
		return { name: this.t(name), desc: this.t(desc), control: {
			type: textarea ? "textarea" : "text", key, placeholder: placeholder ? this.t(placeholder) : undefined,
		} };
	}

	private group(heading: LocaleKey, items: SettingDefinition[]): SettingDefinitionGroup {
		return { type: "group", heading: this.t(heading), cls: "ai-helper-settings-group", items };
	}

	getSettingDefinitions(): SettingDefinitionItem[] {
		// Definitions are also read for search indexing: no DOM, subscriptions or requests here.
		return [
			{ name: this.t("setting-language"), desc: this.t("setting-language-desc"), control: {
				type: "dropdown", key: "language", options: { auto: this.t("language-auto"), ...LOCALE_NAMES },
			} },
			{ type: "page", name: this.t("settings-page-conversation"), items: [
				this.group("settings-group-model", [
					this.text("serverUrl", "setting-server-url", "setting-server-url-desc", "setting-server-url-placeholder"),
					this.text("apiKey", "setting-api-key", "setting-api-key-desc", "setting-api-key-placeholder"),
					this.row("setting-model", "setting-model-desc", setting => {
						this.modelSetting = setting;
						this.renderModels(setting, () => this.updateModelStatus?.());
						return () => { if (this.modelSetting === setting) this.modelSetting = undefined; };
					}),
					this.row("model-check", "model-check-desc", setting => this.renderCheck(setting, false)),
					this.row("setting-context-window", "setting-context-window-desc", setting => this.renderContext(setting)),
				]),
				this.group("settings-group-generation", [
					this.text("systemPrompt", "setting-system-prompt", "setting-system-prompt-desc", "setting-system-prompt-placeholder", true),
					this.text("temperature", "setting-temperature", "setting-temperature-desc", "setting-temperature-placeholder"),
					{ ...this.row("setting-top-p", "setting-top-p-desc", setting => this.renderTopP(setting)), aliases: [this.t("use-server-top-p")] },
					this.text("maxTokens", "setting-max-tokens", "setting-max-tokens-desc", "setting-max-tokens-placeholder"),
					{ name: this.t("setting-response-wait"), desc: this.t("setting-response-wait-desc"), control: {
						type: "text", key: "responseWait", validate: value => { if (!parseResponseWait(value).valid) return this.t("setting-response-wait-invalid"); },
					} },
				]),
			] },
			{ type: "page", name: this.t("settings-page-search"), items: [
				this.group("settings-group-embedding", [
					this.text("embeddingServerUrl", "setting-embedding-server-url", "setting-embedding-server-url-desc"),
					this.row("setting-embedding-api-key", "setting-api-key-desc", setting => { setting.addText(text => {
						text.inputEl.type = "password";
						text.setValue(this.plugin.settings.embeddingApiKey).onChange(value => this.setControlValue("embeddingApiKey", value));
					}); }),
					this.row("setting-embedding-model", "setting-embedding-model-desc", setting => {
						this.embeddingModelSetting = setting;
						this.renderEmbeddingModel(setting, () => this.updateEmbeddingStatus?.());
						return () => { if (this.embeddingModelSetting === setting) this.embeddingModelSetting = undefined; };
					}),
					this.row("embedding-check", "embedding-check-desc", setting => this.renderCheck(setting, true)),
					this.row("index-storage-mode", "index-storage-desc", setting => this.renderStorage(setting)),
					this.row("search-vault-index", undefined, setting => this.renderIndex(setting)),
					this.row("search-vault-clear", "search-clear-desc", setting => { setting.setClass("ai-helper-index-control").addButton(button => button.setWarning().setButtonText(this.t("search-vault-clear")).onClick(() => this.plugin.manageNoteIndex("clear"))); }),
					this.row("setting-search-min-similarity", "setting-search-min-similarity-desc", setting => this.renderSimilarity(setting)),
				]),
				this.folderDefinitions(),
				{ ...this.row("search-missing-folder", undefined, setting => this.renderFolderWarnings(setting)), searchable: false, visible: () => this.missingFolders().length > 0 },
				this.group("settings-group-index-updates", [
					{ name: this.t("search-auto-update"), desc: this.t("search-auto-update-desc"), control: { type: "toggle", key: "autoUpdateNotes" } },
					this.row("search-update-delay", "search-update-delay-desc", setting => this.renderDelay(setting)),
					this.row("search-retry", undefined, setting => { setting.addButton(button => button.setButtonText(this.t("search-retry")).onClick(async () => { try { await this.plugin.noteSearch.resume(true); } catch { /* Status displays the error. */ } })); }),
				]),
			] },
			{ type: "page", name: this.t("settings-page-advanced"), items: [
				{ name: this.t("setting-source-budget"), desc: this.t("setting-source-budget-desc"), control: {
					type: "text", key: "noteSourceBudget", validate: value => { if (sourceBudgetBytes(value) === undefined) return this.t("setting-source-budget-invalid"); },
				} },
				this.group("settings-group-fragments", [
					this.row("setting-fragment-size", "setting-fragment-options-desc", setting => this.renderFragment(setting, "noteFragmentSize")),
					this.row("setting-fragment-overlap", "setting-fragment-options-desc", setting => this.renderFragment(setting, "noteFragmentOverlap")),
				]),
				this.group("settings-group-similarity", (["weak", "medium", "strong"] as const).map(level => this.row(`setting-similarity-${level}`, "setting-similarity-desc", setting => this.renderAppearance(setting, level)))),
			] },
		];
	}

	getControlValue(key: string): unknown {
		if (key === "excluded-folder:new") return this.folderDraft ?? "";
		if (key.startsWith("excluded-folder:")) return this.plugin.settings.excludedFolders[Number(key.split(":")[1])];
		return super.getControlValue(key);
	}

	async setControlValue(key: string, value: unknown): Promise<void> {
		if (key.startsWith("excluded-folder:")) {
			if (typeof value !== "string" || !value.trim()) return;
			const path = value.trim();
			const index = key === "excluded-folder:new" ? -1 : Number(key.split(":")[1]);
			if (this.plugin.settings.excludedFolders.some((folder, other) => folder === path && other !== index)) return;
			if (index === -1) { this.plugin.settings.excludedFolders.push(path); this.folderDraft = undefined; }
			else if (Number.isInteger(index) && index >= 0 && index < this.plugin.settings.excludedFolders.length) this.plugin.settings.excludedFolders[index] = path;
			else return;
			await this.plugin.saveSettings();
			if (index === -1) this.update();
			else { this.updateFolderWarnings?.(); this.refreshDomState(); }
			return;
		}
		if (!(key in this.plugin.settings)) return;
		if (key === "language") {
			if (value !== "auto" && value !== "en" && value !== "ru") return;
			this.plugin.settings.language = value;
		} else if (key === "autoUpdateNotes") {
			if (typeof value !== "boolean") return;
			this.plugin.settings.autoUpdateNotes = value;
		} else {
			if (typeof value !== "string" || typeof this.getControlValue(key) !== "string") return;
			let normalized = key === "systemPrompt" ? value : value.trim();
			if (key === "noteSourceBudget" && sourceBudgetBytes(value) === undefined) return;
			if (key === "responseWait") { const parsed = parseResponseWait(value); if (!parsed.valid) return; normalized = parsed.value; }
			Object.assign(this.plugin.settings, { [key]: normalized });
		}
		const saving = this.plugin.saveSettings();
		this.updateModelStatus?.(); this.updateEmbeddingStatus?.();
		if (key === "embeddingServerUrl" || key === "embeddingApiKey") {
			if (this.embeddingModelSetting) this.renderEmbeddingModel(this.embeddingModelSetting, () => this.updateEmbeddingStatus?.());
		}
		await saving;
		if (key === "language") { await this.plugin.refreshLocale(); this.update(); }
		if (key === "serverUrl") {
			await this.plugin.refreshModels();
			if (this.modelSetting) this.renderModels(this.modelSetting, () => this.updateModelStatus?.());
		}
	}

	private folderDefinitions(): SettingDefinitionList {
		const paths = [...this.plugin.settings.excludedFolders];
		if (this.folderDraft !== undefined) paths.push(this.folderDraft);
		return {
			type: "list", heading: this.t("setting-excluded-folders"), cls: "ai-helper-settings-group ai-helper-excluded-folders",
			addItem: { name: this.t("folder-add"), action: () => { this.folderDraft = ""; this.update(); } },
			onDelete: index => {
				if (index === this.plugin.settings.excludedFolders.length) { this.folderDraft = undefined; this.update(); return; }
				this.plugin.settings.excludedFolders.splice(index, 1);
				void this.plugin.saveSettings().then(() => this.update());
			},
			items: paths.map((path, index) => ({
				name: this.t("setting-excluded-folders"),
				desc: this.t("setting-excluded-folders-desc"),
				control: { type: "folder", key: index === this.plugin.settings.excludedFolders.length ? "excluded-folder:new" : `excluded-folder:${index}`, includeRoot: true,
					validate: value => { if (!value.trim() || this.plugin.settings.excludedFolders.some((folder, other) => other !== index && folder === value.trim())) return this.t("folder-invalid"); },
				},
			})),
		};
	}

	private missingFolders(): string[] {
		return this.plugin.settings.excludedFolders.filter(path => path !== "/" && !this.app?.vault?.getFolderByPath?.(path));
	}

	private renderFolderWarnings(setting: Setting): () => void {
		setting.descEl.setAttribute("aria-live", "polite");
		const update = () => setting.setDesc(this.missingFolders().join(", "));
		this.updateFolderWarnings = update; update();
		return () => { if (this.updateFolderWarnings === update) this.updateFolderWarnings = undefined; };
	}

	refreshExcludedFolders(): void { this.update(); }

	hide(): void {
		this.folderDraft = undefined;
		this.plugin.noteSearchConnection?.cancel(); this.plugin.modelConnection?.cancel();
		super.hide();
	}

	private renderCheck(setting: Setting, embedding: boolean): () => void {
		setting.setClass("ai-helper-connection-check");
		const destination = embedding ? setting.descEl.createDiv({ cls: "ai-helper-embedding-destination" }) : undefined;
		const statusEl = setting.descEl.createDiv({ cls: "ai-helper-connection-status", attr: { "aria-live": "polite" } });
		let active = true;
		const connection = embedding ? this.plugin.noteSearchConnection : this.plugin.modelConnection;
		if (connection?.status.state === "checking") connection.cancel();
		const update = () => {
			if (!active) return;
			const url = this.plugin.settings.embeddingServerUrl;
			destination?.setText(url ? `${this.t("embedding-destination")} ${url}` : this.t("embedding-destination-empty"));
			const status = connection?.status ?? { state: "idle" };
			const message = status.state === "error" ? this.t(status.code)
				: embedding ? status.state === "verified" && "dimensions" in status ? `${this.t("embedding-verified")} ${status.dimensions}` : this.t(status.state === "checking" ? "embedding-checking" : "embedding-idle")
				: this.t(status.state === "verified" ? "model-verified" : status.state === "checking" ? "model-checking" : "model-idle");
			statusEl.setText(message); statusEl.setAttribute("data-state", status.state);
		};
		if (embedding) this.updateEmbeddingStatus = update; else this.updateModelStatus = update;
		setting.addButton(button => button.setButtonText(this.t(embedding ? "embedding-check" : "model-check")).onClick(async () => {
			connection.configure(this.plugin.settings);
			const checking = connection.verify(); update(); await checking; update();
			if (!embedding && active) await this.plugin.contextWindowConnection?.refresh();
		}));
		update();
		return () => {
			active = false; connection?.cancel();
			if (embedding && this.updateEmbeddingStatus === update) this.updateEmbeddingStatus = undefined;
			if (!embedding && this.updateModelStatus === update) this.updateModelStatus = undefined;
		};
	}

	private renderContext(setting: Setting): () => void {
		const status = setting.descEl.createDiv({ attr: { "aria-live": "polite" } });
		let active = true;
		const update = () => {
			if (!active) return;
			const connection = this.plugin.contextWindowConnection;
			const manual = this.plugin.settings.contextWindow;
			const tokens = effectiveContextWindow(manual, connection?.value);
			status.setText(manual ? (tokens ? `${this.t("context-manual")}: ${tokens}` : this.t("context-invalid"))
				: connection?.checking ? this.t("context-checking") : tokens ? `${this.t("context-auto")}: ${tokens} (${connection?.value?.source})` : this.t("context-unknown"));
		};
		const unsubscribe = this.plugin.contextWindowConnection?.subscribe(update);
		setting.addText(text => text.setPlaceholder(this.t("setting-context-window-placeholder")).setValue(this.plugin.settings.contextWindow).onChange(async value => {
			const valid = !value.trim() || effectiveContextWindow(value) !== undefined;
			text.inputEl.setAttribute("aria-invalid", String(!valid));
			if (!valid) { status.setText(this.t("context-invalid")); return; }
			this.plugin.settings.contextWindow = value.trim(); await this.plugin.saveSettings(); update();
		})).addButton(button => button.setIcon("refresh-cw").setTooltip(this.t("context-refresh")).onClick(() => this.plugin.contextWindowConnection.refresh()));
		update(); return () => { active = false; unsubscribe?.(); };
	}

	private renderStorage(setting: Setting): void {
		const directory = this.plugin.noteIndexDirectory?.() ?? ".obsidian/plugins/obsidian-ai-helper/note-index";
		const rule = `/${directory}/`;
		setting.setDesc(`${this.t("index-storage-desc")} ${directory}/. ${this.t("index-storage-git")} ${rule}`);
		setting.addDropdown(dropdown => {
			dropdown.addOption("local", this.t("index-storage-local")).addOption("file", this.t("index-storage-file"))
				.setValue(this.plugin.settings.indexStorageMode).onChange(value => {
					dropdown.setValue(this.plugin.settings.indexStorageMode);
					if ((value !== "local" && value !== "file") || value === this.plugin.settings.indexStorageMode) return;
					new IndexStorageModal(this.plugin, value, () => dropdown.setValue(this.plugin.settings.indexStorageMode)).open();
				});
		});
	}

	private renderIndex(setting: Setting): () => void {
		setting.setClass("ai-helper-index-control");
		const disclosure = setting.descEl.createDiv();
		const status = setting.descEl.createDiv({ attr: { "aria-live": "polite" } });
		const progressBar = new ProgressBarComponent(setting.descEl);
		let active = true;
		const update = () => {
			if (!active) return;
			disclosure.setText(this.plugin.noteIndexDisclosure?.() ?? "");
			const progress = this.plugin.noteSearch?.progress;
			if (progress) {
				status.setText(`${this.t(`search-state-${progress.state}`)}: ${progress.completed.toLocaleString(getLanguage())}/${progress.total.toLocaleString(getLanguage())}${progress.error ? ` — ${this.t(progress.error)}` : ""}`);
				progressBar.setValue(progress.total ? Math.min(100, progress.completed / progress.total * 100) : progress.state === "complete" ? 100 : 0);
			}
		};
		const unsubscribe = this.plugin.noteSearch?.subscribe(update);
		setting.addButton(button => button.setButtonText(this.t("search-vault-index")).onClick(async () => { await this.plugin.manageNoteIndex("index"); update(); }));
		update(); return () => { active = false; unsubscribe?.(); };
	}

	private renderSimilarity(setting: Setting): void {
		let similarityInput: TextComponent;
		let similaritySlider: SliderComponent;
		setting.addText((text) => {
			similarityInput = text;
			text.inputEl.setAttribute("aria-label", this.t("setting-search-min-similarity"));
			text.setValue(String(this.plugin.settings.noteSearchMinSimilarity)).onChange(async (value) => {
				const normalized = value.trim().replace(",", ".");
				const threshold = Number(normalized);
				if (!/^(?:\d+(?:\.\d*)?|\.\d+)$/.test(normalized) || !isValidMinimumSimilarity(threshold)) {
					setting.setDesc(`${this.t("setting-search-min-similarity-desc")} ${this.t("setting-search-min-similarity-invalid")}`);
					text.inputEl.setAttribute("aria-invalid", "true");
					return;
				}
				text.inputEl.setAttribute("aria-invalid", "false");
				setting.setDesc(this.t("setting-search-min-similarity-desc"));
				this.plugin.settings.noteSearchMinSimilarity = threshold;
				similaritySlider.setValue(threshold);
				await this.plugin.saveSettings();
			});
			text.inputEl.setAttribute("inputmode", "decimal");
		});

		setting.addSlider(slider => {
			similaritySlider = slider;
			slider.sliderEl.setAttribute("aria-label", this.t("setting-search-min-similarity"));
			slider.setLimits(0, 1, 0.01).setValue(this.plugin.settings.noteSearchMinSimilarity).setDisplayFormat(value => value.toLocaleString(getLanguage(), { maximumFractionDigits: 2 }))
				.onChange(async value => {
					this.plugin.settings.noteSearchMinSimilarity = value;
					similarityInput.setValue(String(value));
					similarityInput.inputEl.setAttribute("aria-invalid", "false");
					setting.setDesc(this.t("setting-search-min-similarity-desc"));
					await this.plugin.saveSettings();
				});
		});

	}

	private renderAppearance(setting: Setting, level: "weak" | "medium" | "strong"): void {
		const description = this.t(level === "strong" ? "setting-similarity-strong-desc" : "setting-similarity-upper-desc");
		setting.setDesc(description);
		if (level !== "strong") {
			const key = level === "weak" ? "weakUpper" : "mediumUpper";
			setting.addText((text) => {
				text.setValue(String(this.plugin.settings.similarityAppearance[key])).onChange(async (raw) => {
					const normalized = raw.trim().replace(",", ".");
					const next = { ...this.plugin.settings.similarityAppearance, [key]: Number(normalized) };
					const valid = /^(?:\d+(?:\.\d*)?|\.\d+)$/.test(normalized) && validSimilarityBoundaries(next.weakUpper, next.mediumUpper);
					text.inputEl.setAttribute("aria-invalid", String(!valid));
					setting.setDesc(description + (valid ? "" : ` ${this.t("setting-similarity-invalid")}`));
					if (!valid) return;
					this.plugin.settings.similarityAppearance = next;
					await this.plugin.saveSettings();
				});
				text.inputEl.setAttribute("inputmode", "decimal");
				text.inputEl.setAttribute("aria-label", this.t("setting-similarity-upper-desc"));
			});
		}
		const colorKey = `${level}Color` as const;
		const selected = this.plugin.settings.similarityAppearance[colorKey];
		let customColor = selected.startsWith("#") ? selected : level === "weak" ? "#e93147" : level === "medium" ? "#ec7500" : "#08b94e";
		let picker: ColorComponent;
		setting.addDropdown((dropdown) => {
			for (const color of SIMILARITY_COLORS) dropdown.addOption(color, this.t(`similarity-color-${color}`));
			dropdown.addOption("custom", this.t("similarity-color-custom"));
			dropdown.setValue(selected.startsWith("#") ? "custom" : selected).onChange(async (value) => {
				const color = value === "custom" ? customColor : value;
				if (!isSimilarityColor(color)) return;
				picker.setDisabled(value !== "custom");
				this.plugin.settings.similarityAppearance = { ...this.plugin.settings.similarityAppearance, [colorKey]: color };
				await this.plugin.saveSettings();
			});
			dropdown.selectEl.setAttribute("aria-label", this.t("setting-similarity-color"));
		});
		setting.addColorPicker((color) => {
			picker = color;
			color.setValue(customColor).setDisabled(!selected.startsWith("#")).onChange(async (value) => {
				if (!isSimilarityColor(value)) return;
				customColor = value;
				this.plugin.settings.similarityAppearance = { ...this.plugin.settings.similarityAppearance, [colorKey]: value };
				await this.plugin.saveSettings();
			});
		});
	}

	private renderFragment(setting: Setting, key: "noteFragmentSize" | "noteFragmentOverlap"): void {
		setting.addText((text) => {
			text.setValue(String(this.plugin.settings[key])).onChange(async (raw) => {
				const next = { ...this.plugin.settings, [key]: Number(raw.trim()) };
				const valid = /^\d+$/.test(raw.trim()) && isValidFragmentOptions(next);
				text.inputEl.setAttribute("aria-invalid", String(!valid));
				setting.setDesc(this.t("setting-fragment-options-desc") + (valid ? "" : ` ${this.t("search-fragment-settings")}`));
				if (!valid) return;
				this.plugin.settings[key] = next[key];
				await this.plugin.saveSettings();
			});
			text.inputEl.setAttribute("inputmode", "numeric");
		});
	}

	private renderDelay(setting: Setting): void {
		setting.addText(text => {
			text.setValue(String(this.plugin.settings.noteUpdateDelaySeconds)).onChange(async raw => {
				const normalized = raw.trim().replace(",", ".");
				const seconds = Number(normalized);
				const valid = /^(?:\d+(?:\.\d*)?|\.\d+)$/.test(normalized) && isValidNoteUpdateDelay(seconds);
				text.inputEl.setAttribute("aria-invalid", String(!valid));
				setting.setDesc(this.t("search-update-delay-desc") + (valid ? "" : ` ${this.t("search-update-delay-invalid")}`));
				if (!valid) return;
				this.plugin.settings.noteUpdateDelaySeconds = seconds;
				await this.plugin.saveSettings();
			});
			text.inputEl.setAttribute("inputmode", "decimal");
		});
	}

	private renderTopP(setting: Setting): void {
		let input: TextComponent;
		let slider: SliderComponent;
		let lastManual = this.plugin.settings.topP || "1";
		const disabled = () => {
			const useServer = this.plugin.settings.topP === "";
			input.setDisabled(useServer); slider.setDisabled(useServer);
		};
		setting.addText(text => {
			input = text;
			text.inputEl.setAttribute("aria-label", this.t("setting-top-p"));
			text.setValue(this.plugin.settings.topP).onChange(async raw => {
				const value = raw.trim().replace(",", ".");
				const valid = /^(?:\d+(?:\.\d*)?|\.\d+)$/.test(value) && Number(value) >= 0 && Number(value) <= 1;
				text.inputEl.setAttribute("aria-invalid", String(!valid));
				setting.setDesc(this.t("setting-top-p-desc") + (valid ? "" : ` ${this.t("unit-interval-invalid")}`));
				if (!valid) return;
				this.plugin.settings.topP = lastManual = value;
				slider.setValue(Number(value)); await this.plugin.saveSettings();
			});
			text.inputEl.setAttribute("inputmode", "decimal");
		});
		setting.addSlider(control => {
			slider = control;
			control.sliderEl.setAttribute("aria-label", this.t("setting-top-p"));
			control.setLimits(0, 1, 0.01).setValue(Number(lastManual)).setDisplayFormat(value => value.toLocaleString(getLanguage(), { maximumFractionDigits: 2 })).onChange(async value => {
				this.plugin.settings.topP = lastManual = String(value);
				input.setValue(lastManual); input.inputEl.setAttribute("aria-invalid", "false");
				setting.setDesc(this.t("setting-top-p-desc")); await this.plugin.saveSettings();
			});
		});
		const serverControl = setting.controlEl.createDiv({ cls: "ai-helper-top-p-server" });
		serverControl.createSpan({ cls: "setting-item-description", text: this.t("use-server-top-p") });
		setting.addToggle(toggle => {
			serverControl.appendChild(toggle.toggleEl);
			toggle.toggleEl.setAttribute("aria-label", this.t("use-server-top-p"));
			toggle.setTooltip(this.t("use-server-top-p")).setValue(!this.plugin.settings.topP).onChange(async useServer => {
			this.plugin.settings.topP = useServer ? "" : lastManual;
			input.setValue(this.plugin.settings.topP); input.inputEl.setAttribute("aria-invalid", "false");
			setting.setDesc(this.t("setting-top-p-desc")); disabled(); await this.plugin.saveSettings();
			});
		});
		disabled();
	}

	private renderEmbeddingModel(setting: Setting, onChange: () => void, manual?: boolean): void {
		setting.controlEl.empty();
		setting.controlEl.addClass("ai-helper-model-controls");
		const models = this.plugin.embeddingModels ?? [];
		const loaded = this.plugin.embeddingModelStatus === "loaded";
		const selected = this.plugin.settings.embeddingModel;
		const useManual = manual ?? !models.includes(selected);
		if (loaded) {
			setting.addDropdown((dropdown) => {
				dropdown.addOption("", this.t("setting-model-manual"));
				for (const id of models) dropdown.addOption(id, id);
				dropdown.setValue(useManual ? "" : selected).onChange(async (value) => {
					let save: Promise<void> | undefined;
					if (value) {
						this.plugin.settings.embeddingModel = value;
						save = this.plugin.saveSettings();
						onChange();
					}
					this.renderEmbeddingModel(setting, onChange, !value);
					await save;
				});
			});
		}
		if (!loaded || useManual) {
			setting.addText((text) => {
				text.setValue(selected).onChange(async (value) => {
					this.plugin.settings.embeddingModel = value.trim();
					const save = this.plugin.saveSettings();
					onChange();
					await save;
				});
				if (loaded) text.inputEl.addClass("ai-helper-model-manual");
			});
		}
		setting.addButton((button) => {
			button.setIcon("refresh-cw").setTooltip(this.t("setting-refresh-models")).onClick(async () => {
				await this.plugin.refreshEmbeddingModels();
				if (this.embeddingModelSetting === setting) this.renderEmbeddingModel(setting, onChange);
			});
			button.buttonEl.setAttribute("aria-label", this.t("setting-refresh-models"));
		});
		setting.setDesc(this.t("setting-embedding-model-desc") + (loaded ? ` ${this.t("setting-embedding-models-hint")}`
			: this.plugin.embeddingModelStatus === "empty" ? ` ${this.t("setting-models-empty")}`
			: this.plugin.embeddingModelStatus === "error" ? ` ${this.t("setting-models-load-error")}` : ""));
	}

	private renderModels(modelSetting: Setting, onChange: () => void): void {
		modelSetting.controlEl.empty();
		modelSetting.controlEl.addClass("ai-helper-model-controls");

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
						const save = this.plugin.saveSettings();
						onChange();
						await save;
					});
			});
		} else {
			modelSetting.addText((text) => {
				text
					.setPlaceholder(this.t("setting-model-placeholder"))
					.setValue(selected)
					.onChange(async (value) => {
						this.plugin.settings.model = value.trim();
						const save = this.plugin.saveSettings();
						onChange();
						await save;
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
		modelSetting.addButton((button) => {
			button
				.setIcon("refresh-cw")
				.setTooltip(this.t("setting-refresh-models"))
				.onClick(async () => { await this.plugin.refreshModels(); if (this.modelSetting === modelSetting) this.renderModels(modelSetting, onChange); });
			button.buttonEl.setAttribute("aria-label", this.t("setting-refresh-models"));
		});
	}
}
