import { App, PluginSettingTab, Setting, SettingGroup, type ColorComponent, type SearchComponent } from "obsidian";
import { FolderSuggest } from "./folder-suggest";
import type { AiHelperPlugin } from "./main";
import type { EmbeddingConnection } from "./note-search";
import { DEFAULT_MIN_SOURCE_SIMILARITY, isValidMinimumSimilarity, DEFAULT_NOTE_UPDATE_DELAY_SECONDS, isValidNoteUpdateDelay } from "./note-index";
import { DEFAULT_FRAGMENT_OPTIONS, isValidFragmentOptions, type FragmentOptions } from "./note-fragments";
import { DEFAULT_SIMILARITY_APPEARANCE, SIMILARITY_COLORS, validSimilarityBoundaries, isSimilarityColor, type SimilarityAppearance } from "./similarity-appearance";
import { parseResponseWait } from "./response-wait";
import { effectiveContextWindow } from "./context-window";
import {
	LOCALES,
	LOCALE_NAMES,
	type LanguagePreference,
	type LocaleKey,
} from "./i18n";

export interface AiHelperSettings extends EmbeddingConnection, FragmentOptions {
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
	plugin: AiHelperPlugin;
	private displayVersion = 0;
	private unsubscribeIndex: (() => void) | undefined;
	private unsubscribeContext: (() => void) | undefined;
	private excludedFoldersInputs: SearchComponent[] = [];
	private folderSuggests: FolderSuggest[] = [];
	private updateExcludedFoldersWarning?: () => void;

	constructor(app: App, plugin: AiHelperPlugin) {
		super(app, plugin);
		this.plugin = plugin;
	}

	t(key: LocaleKey): string {
		return this.plugin.t(key);
	}

	display(): void {
		this.closeFolderSuggests();
		this.unsubscribeIndex?.();
		this.unsubscribeContext?.();
		if (this.plugin.noteSearchConnection?.status.state === "checking") this.plugin.noteSearchConnection.cancel();
		if (this.plugin.modelConnection?.status.state === "checking") this.plugin.modelConnection.cancel();
		const version = ++this.displayVersion;
		const { containerEl } = this;
		containerEl.empty();

		const title = containerEl.createEl("h2", { text: this.t("settings-title") });
		title.addClass("ai-helper-settings-title");

		const general = this.createGroup(containerEl, "settings-group-general");
		const model = this.createGroup(containerEl, "settings-group-model");
		const generation = this.createGroup(containerEl, "settings-group-generation");
		const embedding = this.createGroup(containerEl, "settings-group-embedding");
		this.renderEmbeddingConnection(embedding, version);
		this.renderExcludedFolders(embedding);
		const updates = this.createGroup(containerEl, "settings-group-index-updates");
		new Setting(updates).setName(this.t("search-auto-update")).setDesc(this.t("search-auto-update-desc"))
			.addToggle(toggle => toggle.setValue(this.plugin.settings.autoUpdateNotes).onChange(async value => {
				this.plugin.settings.autoUpdateNotes = value; await this.plugin.saveSettings();
			}));
		const updateDelay = new Setting(updates).setName(this.t("search-update-delay")).setDesc(this.t("search-update-delay-desc"));
		updateDelay.addText(text => {
			text.setValue(String(this.plugin.settings.noteUpdateDelaySeconds)).onChange(async raw => {
				const normalized = raw.trim().replace(",", ".");
				const seconds = Number(normalized);
				const valid = /^(?:\d+(?:\.\d*)?|\.\d+)$/.test(normalized) && isValidNoteUpdateDelay(seconds);
				text.inputEl.setAttribute("aria-invalid", String(!valid));
				updateDelay.setDesc(this.t("search-update-delay-desc") + (valid ? "" : ` ${this.t("search-update-delay-invalid")}`));
				if (!valid) return;
				this.plugin.settings.noteUpdateDelaySeconds = seconds;
				await this.plugin.saveSettings();
			});
			text.inputEl.setAttribute("inputmode", "decimal");
		});
		new Setting(updates).setName(this.t("search-retry")).addButton(button => button.setButtonText(this.t("search-retry")).onClick(async () => {
			try { await this.plugin.noteSearch.resume(true); } catch { /* The index status displays the error. */ }
		}));
		const index = new Setting(embedding).setClass("ai-helper-index-control").setName(this.t("search-vault-index"));
		const disclosure = index.descEl.createDiv();
		const status = index.descEl.createDiv({ attr: { "aria-live": "polite" } });
		const updateIndex = () => {
			if (version !== this.displayVersion) return;
			disclosure.setText(this.plugin.noteIndexDisclosure?.() ?? "");
			const progress = this.plugin.noteSearch?.progress;
			if (progress) status.setText(`${this.t(`search-state-${progress.state}`)}: ${progress.completed}/${progress.total}${progress.error ? ` — ${this.t(progress.error)}` : ""}`);
		};
		index.addButton((button) => button.setButtonText(this.t("search-vault-index")).onClick(async () => {
			await this.plugin.manageNoteIndex("index");
			updateIndex();
		}));
		new Setting(embedding).setClass("ai-helper-index-control").setName(this.t("search-vault-clear")).setDesc(this.t("search-clear-desc"))
			.addButton(button => {
				button.setWarning().setButtonText(this.t("search-vault-clear")).onClick(async () => {
					await this.plugin.manageNoteIndex("clear");
					updateIndex();
				});
			});
		this.unsubscribeIndex = this.plugin.noteSearch?.subscribe(updateIndex);
		updateIndex();

		const similarity = new Setting(embedding)
			.setName(this.t("setting-search-min-similarity"))
			.setDesc(this.t("setting-search-min-similarity-desc"));
		similarity.addText((text) => {
			text.setValue(String(this.plugin.settings.noteSearchMinSimilarity)).onChange(async (value) => {
				const normalized = value.trim().replace(",", ".");
				const threshold = Number(normalized);
				if (!/^(?:\d+(?:\.\d*)?|\.\d+)$/.test(normalized) || !isValidMinimumSimilarity(threshold)) {
					similarity.setDesc(`${this.t("setting-search-min-similarity-desc")} ${this.t("setting-search-min-similarity-invalid")}`);
					text.inputEl.setAttribute("aria-invalid", "true");
					return;
				}
				text.inputEl.setAttribute("aria-invalid", "false");
				similarity.setDesc(this.t("setting-search-min-similarity-desc"));
				this.plugin.settings.noteSearchMinSimilarity = threshold;
				await this.plugin.saveSettings();
			});
			text.inputEl.setAttribute("inputmode", "decimal");
		});

		const appearance = this.createGroup(containerEl, "settings-group-similarity");
		appearance.createEl("p", { text: this.t("setting-similarity-desc") });
		for (const level of ["weak", "medium", "strong"] as const) {
			const setting = new Setting(appearance).setName(this.t(`setting-similarity-${level}`));
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

		const advanced = this.createGroup(containerEl, "settings-group-fragments");
		for (const [key, name] of [["noteFragmentSize", "setting-fragment-size"], ["noteFragmentOverlap", "setting-fragment-overlap"]] as const) {
			const setting = new Setting(advanced).setName(this.t(name)).setDesc(this.t("setting-fragment-options-desc"));
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

		new Setting(general)
			.setName(this.t("setting-language"))
			.setDesc(this.t("setting-language-desc"))
			.addDropdown((dropdown) => {
				dropdown.addOption("auto", this.t("language-auto"));
				for (const code of LOCALES) {
					dropdown.addOption(code, LOCALE_NAMES[code]);
				}
				dropdown
					.setValue(this.plugin.settings.language)
					.onChange(async (value: string) => {
						this.plugin.settings.language = value as LanguagePreference;
						await this.plugin.saveSettings();
						await this.plugin.refreshLocale();
						this.display();
					});
			});

		new Setting(model)
			.setName(this.t("setting-server-url"))
			.setDesc(this.t("setting-server-url-desc"))
			.addText((text) => {
				text
					.setPlaceholder(this.t("setting-server-url-placeholder"))
					.setValue(this.plugin.settings.serverUrl)
					.onChange(async (value) => {
						this.plugin.settings.serverUrl = value.trim();
						const save = this.plugin.saveSettings();
						updateModelCheck();
						await save;
						await this.refreshModels();
					});
			});

		new Setting(model)
			.setName(this.t("setting-api-key"))
			.setDesc(this.t("setting-api-key-desc"))
			.addText((text) => {
				text
					.setPlaceholder(this.t("setting-api-key-placeholder"))
					.setValue(this.plugin.settings.apiKey)
					.onChange(async (value) => {
						this.plugin.settings.apiKey = value.trim();
						const save = this.plugin.saveSettings();
						updateModelCheck();
						await save;
					});
			});

		const modelSetting = new Setting(model)
			.setName(this.t("setting-model"))
			.setDesc(this.t("setting-model-desc"));
		const updateModelCheck = this.renderModelCheck(model, version);
		this.renderModels(modelSetting, updateModelCheck);

		const contextSetting = new Setting(model)
			.setName(this.t("setting-context-window"))
			.setDesc(this.t("setting-context-window-desc"));
		const contextStatus = contextSetting.descEl.createDiv({ attr: { "aria-live": "polite" } });
		const updateContext = () => {
			if (version !== this.displayVersion) return;
			const connection = this.plugin.contextWindowConnection;
			const manual = this.plugin.settings.contextWindow;
			const tokens = effectiveContextWindow(manual, connection?.value);
			contextStatus.setText(manual ? (tokens ? `${this.t("context-manual")}: ${tokens}` : this.t("context-invalid"))
				: connection?.checking ? this.t("context-checking")
				: tokens ? `${this.t("context-auto")}: ${tokens} (${connection?.value?.source})` : this.t("context-unknown"));
		};
		this.unsubscribeContext = this.plugin.contextWindowConnection?.subscribe(updateContext);
		contextSetting
			.addText((text) => {
				text
					.setPlaceholder(this.t("setting-context-window-placeholder"))
					.setValue(this.plugin.settings.contextWindow)
					.onChange(async (value) => {
						const valid = !value.trim() || effectiveContextWindow(value) !== undefined;
						text.inputEl.setAttribute("aria-invalid", String(!valid));
						if (!valid) { contextStatus.setText(this.t("context-invalid")); return; }
						this.plugin.settings.contextWindow = value.trim();
						await this.plugin.saveSettings();
						updateContext();
					});
			})
			.addButton((button) => button.setIcon("refresh-cw").setTooltip(this.t("context-refresh")).onClick(async () => {
				await this.plugin.contextWindowConnection.refresh();
			}));
		updateContext();

		new Setting(generation)
			.setClass("ai-helper-settings-textarea")
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

		new Setting(generation)
			.setName(this.t("setting-temperature"))
			.setDesc(this.t("setting-temperature-desc"))
			.addText((text) => {
				text
					.setPlaceholder(this.t("setting-temperature-placeholder"))
					.setValue(this.plugin.settings.temperature)
					.onChange(async (value) => {
						this.plugin.settings.temperature = value.trim();
						await this.plugin.saveSettings();
					});
			});

		new Setting(generation)
			.setName(this.t("setting-top-p"))
			.setDesc(this.t("setting-top-p-desc"))
			.addText((text) => {
				text
					.setPlaceholder(this.t("setting-top-p-placeholder"))
					.setValue(this.plugin.settings.topP)
					.onChange(async (value) => {
						this.plugin.settings.topP = value.trim();
						await this.plugin.saveSettings();
					});
			});

		new Setting(generation)
			.setName(this.t("setting-max-tokens"))
			.setDesc(this.t("setting-max-tokens-desc"))
			.addText((text) => {
				text
					.setPlaceholder(this.t("setting-max-tokens-placeholder"))
					.setValue(this.plugin.settings.maxTokens)
					.onChange(async (value) => {
						this.plugin.settings.maxTokens = value.trim();
						await this.plugin.saveSettings();
					});
			});

		const responseWait = new Setting(generation)
			.setName(this.t("setting-response-wait"))
			.setDesc(this.t("setting-response-wait-desc"));
		responseWait.addText((text) => {
			text.setValue(this.plugin.settings.responseWait).onChange(async (raw) => {
				const parsed = parseResponseWait(raw);
				const valid = parsed.valid;
				text.inputEl.setAttribute("aria-invalid", String(!valid));
				responseWait.setDesc(this.t("setting-response-wait-desc") + (valid ? "" : ` ${this.t("setting-response-wait-invalid")}`));
				if (!parsed.valid) return;
				this.plugin.settings.responseWait = parsed.value;
				await this.plugin.saveSettings();
			});
		});
	}

	private renderEmbeddingConnection(parent: HTMLElement, version: number): void {
		const destination = parent.createDiv({ cls: "ai-helper-embedding-destination", attr: { "aria-live": "polite" } });
		const update = () => {
			if (version !== this.displayVersion) return;
			const url = this.plugin.settings.embeddingServerUrl;
			destination.setText(url ? `${this.t("embedding-destination")} ${url}` : this.t("embedding-destination-empty"));
			const status = this.plugin.noteSearchConnection?.status ?? { state: "idle" };
			const message = status.state === "verified" ? `${this.t("embedding-verified")} ${status.dimensions}`
				: status.state === "error" ? this.t(status.code)
				: this.t(status.state === "checking" ? "embedding-checking" : "embedding-idle");
			this.updateConnectionStatus(statusEl, status.state, message);
		};
		const fields: Array<{ key: keyof EmbeddingConnection; name: LocaleKey; description: LocaleKey }> = [
			{ key: "embeddingServerUrl", name: "setting-embedding-server-url", description: "setting-embedding-server-url-desc" },
			{ key: "embeddingApiKey", name: "setting-embedding-api-key", description: "setting-api-key-desc" },
		];
		for (const field of fields) {
			new Setting(parent).setName(this.t(field.name)).setDesc(this.t(field.description)).addText((text) => {
				text.setValue(this.plugin.settings[field.key]).onChange(async (value) => {
					this.plugin.settings[field.key] = value.trim();
					const save = this.plugin.saveSettings();
					this.renderEmbeddingModel(modelSetting, update, version);
					update();
					await save;
				});
				if (field.key === "embeddingApiKey") text.inputEl.type = "password";
			});
		}
		const modelSetting = new Setting(parent).setName(this.t("setting-embedding-model")).setDesc(this.t("setting-embedding-model-desc"));
		this.renderEmbeddingModel(modelSetting, update, version);
		const check = new Setting(parent).setName(this.t("embedding-check")).setDesc(this.t("embedding-check-desc")).setClass("ai-helper-connection-check");
		const statusEl = check.descEl.createDiv({ cls: "ai-helper-connection-status", attr: { "aria-live": "polite" } });
		check.addButton((button) => button.setButtonText(this.t("embedding-check")).onClick(async () => {
			this.plugin.noteSearchConnection.configure(this.plugin.settings);
			const checking = this.plugin.noteSearchConnection.verify();
			update();
			await checking;
			update();
		}));
		update();
	}

	private updateConnectionStatus(el: HTMLElement, state: "idle" | "checking" | "verified" | "error", message: string): void {
		el.setText(message);
		el.setAttribute("data-state", state);
	}

	private renderModelCheck(parent: HTMLElement, version: number): () => void {
		const check = new Setting(parent).setName(this.t("model-check")).setDesc(this.t("model-check-desc")).setClass("ai-helper-connection-check");
		const statusEl = check.descEl.createDiv({ cls: "ai-helper-connection-status", attr: { "aria-live": "polite" } });
		const update = () => {
			if (version !== this.displayVersion) return;
			const status = this.plugin.modelConnection?.status ?? { state: "idle" };
			const message = status.state === "error" ? this.t(status.code)
				: this.t(status.state === "verified" ? "model-verified" : status.state === "checking" ? "model-checking" : "model-idle");
			this.updateConnectionStatus(statusEl, status.state, message);
		};
		check.addButton((button) => button.setButtonText(this.t("model-check")).onClick(async () => {
			this.plugin.modelConnection.configure(this.plugin.settings);
			const checking = this.plugin.modelConnection.verify();
			update();
			await checking;
			update();
			await this.plugin.contextWindowConnection?.refresh();
			update();
		}));
		update();
		return update;
	}

	private renderEmbeddingModel(setting: Setting, onChange: () => void, version: number, manual?: boolean): void {
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
					this.renderEmbeddingModel(setting, onChange, version, !value);
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
				if (version === this.displayVersion) this.display();
			});
			button.buttonEl.setAttribute("aria-label", this.t("setting-refresh-models"));
		});
		setting.setDesc(this.t("setting-embedding-model-desc") + (loaded ? ` ${this.t("setting-embedding-models-hint")}`
			: this.plugin.embeddingModelStatus === "empty" ? ` ${this.t("setting-models-empty")}`
			: this.plugin.embeddingModelStatus === "error" ? ` ${this.t("setting-models-load-error")}` : ""));
	}

	private closeFolderSuggests(): void {
		for (const suggest of this.folderSuggests) suggest.close();
		this.folderSuggests = [];
		this.excludedFoldersInputs = [];
	}

	private renderExcludedFolders(parent: HTMLElement): void {
		const list = parent.createDiv();
		const render = () => {
			this.closeFolderSuggests();
			list.empty();
			const warning = list.createDiv({ attr: { "aria-live": "polite" } });
			const updateWarnings = () => {
				const missing = this.plugin.settings.excludedFolders.filter(path => path !== "/" && !this.app?.vault?.getFolderByPath?.(path));
				warning.setText(missing.length ? `${this.t("search-missing-folder")}: ${missing.join(", ")}` : "");
			};
			this.updateExcludedFoldersWarning = updateWarnings;
			for (const [index, path] of this.plugin.settings.excludedFolders.entries()) {
				const setting = new Setting(list).setName(this.t("setting-excluded-folders"));
				setting.addSearch(input => {
					const change = async (raw: string) => {
						const value = raw.trim();
						const valid = !!value && !this.plugin.settings.excludedFolders.some((folder, other) => other !== index && folder === value);
						input.inputEl.setAttribute("aria-invalid", String(!valid));
						if (!valid) return;
						this.plugin.settings.excludedFolders[index] = value;
						await this.plugin.saveSettings(); updateWarnings();
					};
					input.setValue(path).onChange(change);
					this.excludedFoldersInputs.push(input);
					this.folderSuggests.push(new FolderSuggest(this.app, input, value => { void change(value); }));
				}).addButton(button => button.setIcon("trash-2").setTooltip(this.t("folder-remove")).onClick(async () => {
					this.plugin.settings.excludedFolders.splice(index, 1);
					await this.plugin.saveSettings(); render();
				}));
			}
			let candidate: SearchComponent;
			new Setting(list).setName(this.t("folder-add")).setDesc(this.t("setting-excluded-folders-desc"))
				.addSearch(input => {
					candidate = input;
					this.folderSuggests.push(new FolderSuggest(this.app, input, value => { input.setValue(value); }));
				}).addButton(button => button.setIcon("plus").setTooltip(this.t("folder-add")).onClick(async () => {
					const path = candidate.getValue().trim();
					if (!path || this.plugin.settings.excludedFolders.includes(path)) return;
					this.plugin.settings.excludedFolders.push(path);
					await this.plugin.saveSettings(); render();
				}));
			updateWarnings();
		};
		render();
	}

	refreshExcludedFolders(): void {
		this.excludedFoldersInputs.forEach((input, index) => input.setValue(this.plugin.settings.excludedFolders[index] ?? ""));
		this.updateExcludedFoldersWarning?.();
	}

	hide(): void {
		this.closeFolderSuggests();
		this.updateExcludedFoldersWarning = undefined;
		this.unsubscribeIndex?.();
		this.unsubscribeContext?.();
		this.unsubscribeContext = undefined;
		this.displayVersion++;
		this.plugin.noteSearchConnection.cancel();
		this.plugin.modelConnection?.cancel();
	}

	private createGroup(parent: HTMLElement, headingKey: LocaleKey): HTMLElement {
		return new SettingGroup(parent).setHeading(this.t(headingKey)).addClass("ai-helper-settings-group").listEl;
	}

	private async refreshModels(): Promise<void> {
		await this.plugin.refreshModels();
		this.display();
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
				.onClick(async () => { await this.refreshModels(); });
			button.buttonEl.setAttribute("aria-label", this.t("setting-refresh-models"));
		});
	}
}
