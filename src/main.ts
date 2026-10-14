import { FileSystemAdapter, Plugin, MarkdownView, TFile, TFolder, type TAbstractFile, type Editor, parseYaml, getLanguage as getAppLanguage } from "obsidian";
import { showStatusNotice } from "./ui-status";
import {
	AiHelperSettings,
	DEFAULT_SETTINGS,
	AiHelperSettingsTab,
	type ModelStatus,
} from "./settings";
import { NoteReviewView, VIEW_TYPE_NOTE_REVIEW } from "./note-review-view";
import { ChatView, VIEW_TYPE_CHAT } from "./chat-view";
import { createServerClient, type ServerClient } from "./server-client";
import { setLanguage, resolveLanguage, t, type LocaleKey } from "./i18n";
import { createModelConnection } from "./model-connection";
import { DEFAULT_FRAGMENT_OPTIONS, isValidFragmentOptions } from "./note-fragments";
import { createNoteSearchConnection, isEmbeddingConfigured } from "./note-search";
import { createNoteSearch, sourceBudgetBytes, NoteSearchError, isValidMinimumSimilarity, isValidNoteUpdateDelay, type NoteSearch, type IndexStorageMode } from "./note-index";
import { normalizeSimilarityAppearance } from "./similarity-appearance";
import { StorageProbeModal } from "./storage-probe-modal";
import { createContextWindowConnection } from "./context-window";

import { FolderDescriptions, isValidFolderDescriptionName } from "./folder-descriptions";

export class AiHelperPlugin extends Plugin {
	currentNote: TFile | null = null;
	folderDescriptions = new FolderDescriptions(this.app, () => this.settings.folderDescriptionName, key => this.t(key));
	settings: AiHelperSettings = DEFAULT_SETTINGS;
	models: string[] = [];
	modelStatus: ModelStatus = "idle";
	private modelRequest: AbortController | null = null;
	embeddingModels: string[] = [];
	embeddingModelStatus: ModelStatus = "idle";
	private embeddingModelRequest: AbortController | null = null;
	private embeddingListUrl = "";
	private embeddingListKey = "";
	serverClient: ServerClient = createServerClient(
		(input, init) => globalThis.fetch(input, init)
	);

	noteSearch!: NoteSearch;
	private indexingNote = false;
	private changingIndexStorage = false;
	private indexStorageListeners = new Set<() => void>();
	private unloading = false;
	private indexRestore: Promise<void> = Promise.resolve();
	private settingsTab?: AiHelperSettingsTab;
	noteSearchConnection = createNoteSearchConnection(this.serverClient);
	modelConnection = createModelConnection(this.serverClient);
	contextWindowConnection = createContextWindowConnection(this.serverClient);

	async onload(): Promise<void> {
		this.unloading = false;
		const rememberNote = () => {
			const file = this.app.workspace.getActiveViewOfType?.(MarkdownView)?.file;
			if (file?.extension === "md") this.currentNote = file;
		};
		rememberNote();
		if (this.app.workspace.on) {
			this.registerEvent(this.app.workspace.on("active-leaf-change", rememberNote));
			this.registerEvent(this.app.workspace.on("file-open", file => {
				if (file?.extension === "md") this.currentNote = file;
			}));
		}
		await this.loadSettings();
		this.register(this.contextWindowConnection.subscribe(() => this.updateContextIndicators()));
		this.applyLanguage();
		const adapter = this.app.vault?.adapter;
		this.noteSearch = createNoteSearch({
			vaultPath: adapter instanceof FileSystemAdapter ? adapter.getBasePath() : "",
			factory: globalThis.indexedDB,
			storageMode: this.settings.indexStorageMode,
			fileStorage: { adapter, directory: this.noteIndexDirectory() },
			client: this.serverClient,
			read: async (path) => {
				const file = this.app.vault.getFileByPath(path);
				return file?.extension === "md" ? this.app.vault.read(file) : null;
			},
			list: () => this.app.vault.getMarkdownFiles().map((file) => file.path),
			metadata: (_path, raw) => {
				const yaml = raw.match(/^\uFEFF?---\r?\n([\s\S]*?)\r?\n(?:---|\.\.\.)(?:\r?\n|$)/);
				const value: unknown = yaml ? parseYaml(yaml[1]) : {};
				return value && typeof value === "object" ? value as Record<string, unknown> : {};
			},
			open: (path, heading, newLeaf = false) => this.app.workspace.openLinkText(heading ? `${path}#${heading}` : path, "", newLeaf),
		});
		this.noteSearch.configure(this.settings);
		let vaultReady = !this.app.workspace.onLayoutReady;
		const updateError = (error: unknown) => { if (!(error instanceof NoteSearchError && error.code === "search-rebuild")) showStatusNotice(this.t(error instanceof NoteSearchError ? error.code : "search-failed"), "error"); };
		const indexDirectory = this.noteIndexDirectory();
		const isIndexPath = (path: string) => path === indexDirectory || path.startsWith(`${indexDirectory}/`);
		if (this.app.vault?.on) {
			const changed = (file: TAbstractFile) => {
				// Initial file discovery also emits create/modify events. Restoration
				// reconciles their final contents once the complete vault is available.
				if (!vaultReady || isIndexPath(file.path)) return;
				if (file instanceof TFile && file.extension === "md") void this.noteSearch.changed(file.path).catch(updateError);
			};
			this.registerEvent(this.app.vault.on("create", changed));
			this.registerEvent(this.app.vault.on("modify", changed));
			this.registerEvent(this.app.vault.on("delete", file => {
				if (!vaultReady || isIndexPath(file.path) || (file instanceof TFile && file.extension !== "md")) return;
				void this.noteSearch.removed(file.path).catch(updateError);
			}));
			this.registerEvent(this.app.vault.on("rename", (file, oldPath) => {
				if (isIndexPath(file.path) || isIndexPath(oldPath)) return;
				if (file instanceof TFile && file.extension !== "md" && !/\.md$/i.test(oldPath)) return;
				const updating = this.noteSearch.renamed(file.path, oldPath);
				this.settings.excludedFolders = this.noteSearch.excludedFolders;
				this.settingsTab?.refreshExcludedFolders();
				void this.saveSettings().catch(updateError);
				void updating.catch(updateError);
			}));
			this.registerEvent(this.app.workspace.on("file-menu", (menu, file) => {
				if (file instanceof TFile && file.extension === "md") menu.addItem(item => item.setTitle(this.t("search-index")).setIcon("refresh-cw").onClick(() => { void this.indexNote(file.path); }));
				if (file instanceof TFolder) {
					menu.addItem(item => item.setTitle(this.t("review-folder")).setIcon("folder-search").onClick(() => {
						if (!this.unloading) void this.reviewFolder(file).catch(() => showStatusNotice(this.t("review-error"), "error"));
					}));
					menu.addItem(item => item.setTitle(this.t("folder-description-create")).setIcon("file-plus").onClick(() => {
						if (!this.unloading) void this.folderDescriptions.createAndOpen(file).catch(() => showStatusNotice(this.t("folder-description-error"), "error"));
					}));
					const normalize = (path: string) => path.trim().replace(/\\/g, "/").replace(/^\/+|\/+$/g, "").replace(/\/+/g, "/");
					const path = normalize(file.path);
					const excluded = this.settings.excludedFolders.some(folder => normalize(folder) === path);
					menu.addItem(item => item.setTitle(this.t(excluded ? "folder-menu-include" : "folder-menu-exclude"))
						.setIcon(excluded ? "folder-plus" : "folder-minus").onClick(() => {
							if (this.unloading) return;
							const currentPath = normalize(file.path);
							this.settings.excludedFolders = this.settings.excludedFolders.filter(folder => normalize(folder) !== currentPath);
							if (!excluded) this.settings.excludedFolders.push(currentPath || "/");
							void this.saveSettings().catch(updateError);
							this.settingsTab?.refreshExcludedFolders();
						}));
				}
			}));
		}
		const restoreIndex = () => {
			if (this.unloading) return;
			vaultReady = true;
			// The file list is incomplete while Obsidian loads the vault. Never
			// reconcile it then, and never block plugin loading on derived data.
			const restoring = this.noteSearch.restore();
			this.indexRestore = restoring.catch(() => {});
			void restoring.then(() => {
				if (!this.unloading && !this.indexingNote && isEmbeddingConfigured(this.settings)) return this.noteSearch.resume();
			}).catch(error => { if (!this.unloading) updateError(error); });
		};
		if (this.app.workspace.onLayoutReady) this.app.workspace.onLayoutReady(restoreIndex);

		this.registerHoverLinkSource(VIEW_TYPE_CHAT, { display: this.manifest.name, defaultMod: true });
		this.registerView(VIEW_TYPE_CHAT, (leaf) => new ChatView(leaf, this));
		this.registerView(VIEW_TYPE_NOTE_REVIEW, leaf => new NoteReviewView(leaf, this));
		this.registerHoverLinkSource(VIEW_TYPE_NOTE_REVIEW, { display: this.t("review-title"), defaultMod: true });
		this.addCommand({ id: "suggest-note-folder", name: this.t("review-command"), callback: () => {
			const view = this.app.workspace.getActiveViewOfType(MarkdownView);
			if (!view?.file || view.file.extension !== "md") { showStatusNotice(this.t("search-note"), "warning"); return; }
			const file = view.file;
			const text = { save: async () => {
				if (view.file !== file) throw new Error("The editor is showing another note");
				await view.save();
			}, getValue: () => {
				if (view.file !== file) throw new Error("The editor is showing another note");
				return view.getMode() === "source" ? view.editor.getValue() : view.getViewData();
			} };
			void this.suggestNoteFolder(file, text).catch(() => showStatusNotice(this.t("review-error"), "error"));
		} });
		this.addRibbonIcon(
			"message-square",
			this.t("ribbon"),
			() => this.toggleView()
		);
		this.addCommand({
			id: "toggle-view",
			name: this.t("command"),
			callback: () => this.toggleView(),
		});
		this.addCommand({ id: "new-conversation", name: this.t("command-new-conversation"), callback: () => { void this.newConversation(); } });
		this.addCommand({ id: "stop-generation", name: this.t("command-stop-generation"), checkCallback: checking => {
			const view = this.getChatView();
			if (!view?.isGenerating()) return false;
			if (!checking) view.stopGeneration();
			return true;
		} });
		this.addCommand({ id: "toggle-note-search", name: this.t("search-toggle"), checkCallback: checking => {
			const view = this.getChatView();
			if (!view) return false;
			if (!checking) view.toggleSearch();
			return true;
		} });
		this.settingsTab = new AiHelperSettingsTab(this.app, this);
		this.addSettingTab(this.settingsTab);
		this.addCommand({ id: "retry-note-updates", name: this.t("search-retry"), callback: () => { void this.resumeNoteIndex(); } });
		this.addCommand({
			id: "local-storage-probe",
			name: this.t("probe-title"),
			callback: () => new StorageProbeModal(this.app).open(),
		});
		this.addCommand({
			id: "index-active-note", name: this.t("search-index"),
			callback: () => { void this.indexActiveNote(); },
		});
		for (const [id, key, action] of [
			["index-vault", "search-vault-index", "index"],
			["clear-note-index", "search-vault-clear", "clear"],
		] as const) {
			this.addCommand({ id, name: this.t(key), callback: () => { void this.manageNoteIndex(action); } });
		}
		void this.refreshModels();
		void this.refreshEmbeddingModels();
	}

	onunload(): void {
		this.unloading = true;
		this.indexStorageListeners.clear();
		this.noteSearch?.dispose();
		this.noteSearchConnection.cancel();
		this.modelConnection.cancel();
		this.contextWindowConnection.cancel();
		this.embeddingModelRequest?.abort();
		this.embeddingModelRequest = null;
		this.modelRequest?.abort();
		this.modelRequest = null;
		this.app.workspace.detachLeavesOfType(VIEW_TYPE_CHAT);
		this.app.workspace.detachLeavesOfType(VIEW_TYPE_NOTE_REVIEW);
	}

	async loadSettings(): Promise<void> {
		this.settings = Object.assign({}, DEFAULT_SETTINGS, await this.loadData());
		if (!isValidFolderDescriptionName(this.settings.folderDescriptionName)) this.settings.folderDescriptionName = DEFAULT_SETTINGS.folderDescriptionName;
		if (!["local", "file"].includes(this.settings.indexStorageMode)) this.settings.indexStorageMode = "local";
		if (typeof this.settings.indexStorageGeneration !== "string") this.settings.indexStorageGeneration = "";
		if (!["auto", "en", "ru"].includes(this.settings.language)) this.settings.language = "auto";
		if (sourceBudgetBytes(this.settings.noteSourceBudget) === undefined) this.settings.noteSourceBudget = DEFAULT_SETTINGS.noteSourceBudget;
		this.settings.similarityAppearance = normalizeSimilarityAppearance(this.settings.similarityAppearance);
		if (!isValidFragmentOptions(this.settings)) Object.assign(this.settings, DEFAULT_FRAGMENT_OPTIONS);
		if (!isValidNoteUpdateDelay(this.settings.noteUpdateDelaySeconds)) this.settings.noteUpdateDelaySeconds = DEFAULT_SETTINGS.noteUpdateDelaySeconds;
		if (!isValidMinimumSimilarity(this.settings.noteSearchMinSimilarity)) this.settings.noteSearchMinSimilarity = DEFAULT_SETTINGS.noteSearchMinSimilarity;
		this.settings.excludedFolders = Array.isArray(this.settings.excludedFolders) ? this.settings.excludedFolders.filter((folder) => typeof folder === "string") : [];
		this.noteSearchConnection.configure(this.settings);
		this.modelConnection.configure(this.settings);
		this.contextWindowConnection.configure(this.settings);
	}

	async indexActiveNote(): Promise<void> {
		if (this.indexingNote || this.changingIndexStorage) return;
		const file = this.app.workspace.getActiveFile();
		if (!file || file.extension !== "md") { showStatusNotice(this.t("search-note"), "warning"); return; }
		await this.indexNote(file.path);
	}

	async indexNote(path: string): Promise<void> {
		if (!this.requireEmbeddingConfiguration()) return;
		if (this.indexingNote || this.changingIndexStorage) return;
		this.indexingNote = true;
		showStatusNotice(`${this.t("search-indexing")}\n${this.noteIndexDisclosure()}`, "info");
		try { await this.indexRestore; if (this.unloading) return; await this.noteSearch.index(path); showStatusNotice(this.t("search-indexed"), "success"); }
		catch (error) {
			if (!(error instanceof NoteSearchError && error.code === "search-rebuild")) showStatusNotice(this.t(error instanceof NoteSearchError ? error.code : "search-failed"), "error");
		}
		finally { this.indexingNote = false; }
	}

	/** Keep unavailable actions discoverable and explain the required configuration. */
	requireEmbeddingConfiguration(): boolean {
		if (isEmbeddingConfigured(this.settings)) return true;
		showStatusNotice(this.t("search-setup-required"), "warning");
		return false;
	}

	async resumeNoteIndex(): Promise<void> {
		if (!this.requireEmbeddingConfiguration()) return;
		try { await this.indexRestore; if (!this.unloading) await this.noteSearch.resume(true); }
		catch (error) { showStatusNotice(this.t(error instanceof NoteSearchError ? error.code : "search-failed"), "error"); }
	}

	noteIndexDirectory(): string {
		return `${this.app.vault?.configDir ?? ".obsidian"}/plugins/${this.manifest.id}/note-index`;
	}

	get isChangingIndexStorage(): boolean { return this.changingIndexStorage; }
	subscribeIndexStorage(listener: () => void): () => void {
		this.indexStorageListeners.add(listener);
		return () => { this.indexStorageListeners.delete(listener); };
	}

	async changeIndexStorage(mode: IndexStorageMode): Promise<void> {
		if (!this.requireEmbeddingConfiguration()) return;
		if (this.changingIndexStorage || mode === this.settings.indexStorageMode || this.unloading) return;
		this.changingIndexStorage = true;
		try {
			// Persist the explicit selection even if that storage later fails. No fallback.
			const previousMode = this.settings.indexStorageMode;
			const previousGeneration = this.settings.indexStorageGeneration;
			this.settings.indexStorageMode = mode;
			this.settings.indexStorageGeneration = globalThis.crypto.randomUUID();
			this.indexStorageListeners.forEach(listener => listener());
			try { await this.saveData(this.settings); }
			catch (error) {
				this.settings.indexStorageMode = previousMode;
				this.settings.indexStorageGeneration = previousGeneration;
				throw error;
			}
			// A persisted generation prevents old destination data from being accepted
			// even if clearing fails or the app stops immediately after saving the mode.
			this.noteSearch.configure(this.settings);
			await this.noteSearch.switchStorage(mode);
			if (this.unloading) return;
			showStatusNotice(this.noteIndexDisclosure(), "info");
			await this.noteSearch.indexVault();
			showStatusNotice(this.t("search-state-complete"), "success");
		} catch (error) {
			if (!(error instanceof NoteSearchError && error.code === "search-rebuild")) showStatusNotice(this.t(error instanceof NoteSearchError ? error.code : "search-storage"), "error");
		} finally {
			this.changingIndexStorage = false;
			this.indexStorageListeners.forEach(listener => listener());
		}
	}

	noteIndexDisclosure(): string {
		return `${this.t("search-disclosure-embedding")}: ${this.settings.embeddingServerUrl || this.t("search-server-unset")}.\n${this.t("search-disclosure-conversation")}: ${this.settings.serverUrl || this.t("search-server-unset")}.`;
	}

	async manageNoteIndex(action: "index" | "clear"): Promise<void> {
		if (action !== "clear" && !this.requireEmbeddingConfiguration()) return;
		if (this.changingIndexStorage || (action !== "clear" && this.indexingNote)) return;
		if (action !== "clear") { this.indexingNote = true; showStatusNotice(this.noteIndexDisclosure(), "info"); }
		try {
			if (action === "clear") await this.noteSearch.clear();
			else { await this.indexRestore; if (this.unloading) return; await this.noteSearch.rebuild(); }
			showStatusNotice(this.t(action === "clear" ? "search-cleared" : "search-state-complete"), "success");
		} catch (error) {
			if (!(error instanceof NoteSearchError && error.code === "search-rebuild")) showStatusNotice(this.t(error instanceof NoteSearchError ? error.code : "search-failed"), "error");
		}
		finally { if (action !== "clear") this.indexingNote = false; }
	}

	async saveSettings(): Promise<void> {
		this.noteSearch?.configure(this.settings);
		this.noteSearchConnection.configure(this.settings);
		this.modelConnection.configure(this.settings);
		if (this.contextWindowConnection.configure(this.settings)) void this.contextWindowConnection.refresh();
		this.updateContextIndicators();
		for (const leaf of this.app.workspace.getLeavesOfType(VIEW_TYPE_CHAT)) {
			if (leaf.view instanceof ChatView) { leaf.view.refreshSearchConfiguration(); await leaf.view.refreshSimilarityAppearance(); }
		}
		if (this.embeddingListUrl !== this.settings.embeddingServerUrl.trim() || this.embeddingListKey !== this.settings.embeddingApiKey) {
			this.embeddingModelRequest?.abort();
			this.embeddingModelRequest = null;
			this.embeddingModels = [];
			this.embeddingModelStatus = "idle";
		}
		await this.saveData(this.settings);
	}

	async refreshModels(): Promise<void> {
		this.contextWindowConnection.configure(this.settings);
		await Promise.all([this.loadModels(false), this.contextWindowConnection.refresh()]);
	}

	private updateContextIndicators(): void {
		for (const leaf of this.app.workspace.getLeavesOfType(VIEW_TYPE_CHAT)) {
			if (leaf.view instanceof ChatView) leaf.view.updateContextIndicators();
		}
	}

	async refreshEmbeddingModels(): Promise<void> {
		await this.loadModels(true);
	}

	private async loadModels(embedding: boolean): Promise<void> {
		const requestKey = embedding ? "embeddingModelRequest" : "modelRequest";
		const modelsKey = embedding ? "embeddingModels" : "models";
		const statusKey = embedding ? "embeddingModelStatus" : "modelStatus";
		const urlKey = embedding ? "embeddingServerUrl" : "serverUrl";
		const apiKeyField = embedding ? "embeddingApiKey" : "apiKey";
		this[requestKey]?.abort();
		const request = new AbortController();
		this[requestKey] = request;
		const url = this.settings[urlKey].trim().replace(/\/+$/, "");
		const apiKey = this.settings[apiKeyField];
		if (embedding) {
			this.embeddingListUrl = this.settings.embeddingServerUrl.trim();
			this.embeddingListKey = apiKey;
		}
		if (!url) {
			this[requestKey] = null;
			this[modelsKey] = [];
			this[statusKey] = "idle";
			return;
		}
		const current = () => this[requestKey] === request && url === this.settings[urlKey].trim().replace(/\/+$/, "") && apiKey === this.settings[apiKeyField];
		try {
			const result = await this.serverClient.listModels(url, apiKey, request.signal);
			if (!current()) return;
			this[modelsKey] = result.ok ? result.value : [];
			this[statusKey] = result.ok ? (result.value.length ? "loaded" : "empty") : "error";
		} catch {
			if (current()) { this[modelsKey] = []; this[statusKey] = "error"; }
		} finally {
			if (this[requestKey] === request) this[requestKey] = null;
		}
	}

	t(key: LocaleKey): string {
		return t(key);
	}

	async refreshLocale(): Promise<void> {
		this.applyLanguage();
		for (const leaf of this.app.workspace.getLeavesOfType(VIEW_TYPE_CHAT)) {
			if (leaf.view instanceof ChatView) {
				await leaf.view.refreshLocale();
			}
		}
		for (const leaf of this.app.workspace.getLeavesOfType(VIEW_TYPE_NOTE_REVIEW)) {
			if (leaf.view instanceof NoteReviewView) leaf.view.refreshLanguage();
		}
	}

	applyLanguage(): void {
		setLanguage(resolveLanguage(this.settings.language, getAppLanguage()));
	}

	private getChatView(): ChatView | undefined {
		const active = this.app.workspace.getActiveViewOfType?.(ChatView);
		if (active) return active;
		const leaf = this.app.workspace.getLeavesOfType(VIEW_TYPE_CHAT).find(leaf => leaf.view instanceof ChatView);
		return leaf?.view instanceof ChatView ? leaf.view : undefined;
	}

	async newConversation(): Promise<void> {
		let view = this.getChatView();
		if (view) await this.app.workspace.revealLeaf(view.leaf);
		else {
			const leaf = await this.app.workspace.ensureSideLeaf(VIEW_TYPE_CHAT, "right", { active: true, reveal: true });
			if (leaf.view instanceof ChatView) view = leaf.view;
		}
		view?.clearConversation();
	}

	async reviewFolder(folder: TFolder): Promise<void> {
		const leaf = await this.app.workspace.ensureSideLeaf(VIEW_TYPE_NOTE_REVIEW, "right", { active: true, reveal: true });
		if (!this.unloading && leaf.view instanceof NoteReviewView) leaf.view.prepareFolder(folder);
	}

	async suggestNoteFolder(file: TFile, editor: Pick<Editor, "getValue"> & { save?: () => Promise<void> }): Promise<void> {
		const leaf = await this.app.workspace.ensureSideLeaf(VIEW_TYPE_NOTE_REVIEW, "right", { active: true, reveal: true });
		if (!this.unloading && leaf.view instanceof NoteReviewView) await leaf.view.analyze(file, editor);
	}

	async toggleView(): Promise<void> {
		const { workspace } = this.app;
		const existing = workspace.getLeavesOfType(VIEW_TYPE_CHAT)[0];
		if (existing) {
			existing.detach();
			return;
		}
		await workspace.ensureSideLeaf(VIEW_TYPE_CHAT, "right", { active: true, reveal: true });
	}
}

export default AiHelperPlugin;
