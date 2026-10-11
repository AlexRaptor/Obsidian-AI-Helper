import { FileSystemAdapter, Notice, Plugin, TFile, type TAbstractFile, parseYaml, getLanguage as getAppLanguage } from "obsidian";
import {
	AiHelperSettings,
	DEFAULT_SETTINGS,
	AiHelperSettingsTab,
	type ModelStatus,
} from "./settings";
import { ChatView, VIEW_TYPE_CHAT } from "./chat-view";
import { createServerClient, type ServerClient } from "./server-client";
import { setLanguage, resolveLanguage, t, type LocaleKey } from "./i18n";
import { createModelConnection } from "./model-connection";
import { DEFAULT_FRAGMENT_OPTIONS, isValidFragmentOptions } from "./note-fragments";
import { createNoteSearchConnection } from "./note-search";
import { createNoteSearch, NoteSearchError, isValidMinimumSimilarity, isValidNoteUpdateDelay, type NoteSearch } from "./note-index";
import { normalizeSimilarityAppearance } from "./similarity-appearance";
import { StorageProbeModal } from "./storage-probe-modal";
import { createContextWindowConnection } from "./context-window";

export class AiHelperPlugin extends Plugin {
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
	private unloading = false;
	private indexRestore: Promise<void> = Promise.resolve();
	private settingsTab?: AiHelperSettingsTab;
	noteSearchConnection = createNoteSearchConnection(this.serverClient);
	modelConnection = createModelConnection(this.serverClient);
	contextWindowConnection = createContextWindowConnection(this.serverClient);

	async onload(): Promise<void> {
		this.unloading = false;
		await this.loadSettings();
		this.register(this.contextWindowConnection.subscribe(() => this.updateContextIndicators()));
		this.applyLanguage();
		const adapter = this.app.vault?.adapter;
		this.noteSearch = createNoteSearch({
			vaultPath: adapter instanceof FileSystemAdapter ? adapter.getBasePath() : "",
			factory: globalThis.indexedDB,
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
		const updateError = (error: unknown) => { if (!(error instanceof NoteSearchError && error.code === "search-rebuild")) new Notice(this.t(error instanceof NoteSearchError ? error.code : "search-failed")); };
		if (this.app.vault?.on) {
			const changed = (file: TAbstractFile) => {
				if (file instanceof TFile && file.extension === "md") void this.noteSearch.changed(file.path).catch(updateError);
			};
			this.registerEvent(this.app.vault.on("create", changed));
			this.registerEvent(this.app.vault.on("modify", changed));
			this.registerEvent(this.app.vault.on("delete", file => { void this.noteSearch.removed(file.path).catch(updateError); }));
			this.registerEvent(this.app.vault.on("rename", (file, oldPath) => {
				const updating = this.noteSearch.renamed(file.path, oldPath);
				this.settings.excludedFolders = this.noteSearch.excludedFolders;
				this.settingsTab?.refreshExcludedFolders();
				void this.saveSettings().catch(updateError);
				void updating.catch(updateError);
			}));
			this.registerEvent(this.app.workspace.on("file-menu", (menu, file) => {
				if (file instanceof TFile && file.extension === "md") menu.addItem(item => item.setTitle(this.t("search-index")).setIcon("refresh-cw").onClick(() => { void this.indexNote(file.path); }));
			}));
		}
		const restoreIndex = () => {
			if (this.unloading) return;
			// The file list is incomplete while Obsidian loads the vault. Never
			// reconcile it then, and never block plugin loading on derived data.
			const restoring = this.noteSearch.restore();
			this.indexRestore = restoring.catch(() => {});
			void restoring.then(() => {
				if (!this.unloading && !this.indexingNote) return this.noteSearch.resume();
			}).catch(error => { if (!this.unloading) updateError(error); });
		};
		if (this.app.workspace.onLayoutReady) this.app.workspace.onLayoutReady(restoreIndex);

		this.registerHoverLinkSource(VIEW_TYPE_CHAT, { display: this.manifest.name, defaultMod: true });
		this.registerView(VIEW_TYPE_CHAT, (leaf) => new ChatView(leaf, this));
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
		this.addCommand({ id: "retry-note-updates", name: this.t("search-retry"), callback: () => { void this.indexRestore.then(() => this.noteSearch.resume(true)).catch(updateError); } });
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
		this.noteSearch?.dispose();
		this.noteSearchConnection.cancel();
		this.modelConnection.cancel();
		this.contextWindowConnection.cancel();
		this.embeddingModelRequest?.abort();
		this.embeddingModelRequest = null;
		this.modelRequest?.abort();
		this.modelRequest = null;
		this.app.workspace.detachLeavesOfType(VIEW_TYPE_CHAT);
	}

	async loadSettings(): Promise<void> {
		this.settings = Object.assign({}, DEFAULT_SETTINGS, await this.loadData());
		if (!["auto", "en", "ru"].includes(this.settings.language)) this.settings.language = "auto";
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
		if (this.indexingNote) return;
		const file = this.app.workspace.getActiveFile();
		if (!file || file.extension !== "md") { new Notice(this.t("search-note")); return; }
		await this.indexNote(file.path);
	}

	async indexNote(path: string): Promise<void> {
		if (this.indexingNote) return;
		this.indexingNote = true;
		new Notice(`${this.t("search-indexing")}\n${this.noteIndexDisclosure()}`);
		try { await this.indexRestore; if (this.unloading) return; await this.noteSearch.index(path); new Notice(this.t("search-indexed")); }
		catch (error) {
			if (!(error instanceof NoteSearchError && error.code === "search-rebuild")) new Notice(this.t(error instanceof NoteSearchError ? error.code : "search-failed"));
		}
		finally { this.indexingNote = false; }
	}

	noteIndexDisclosure(): string {
		return `${this.t("search-disclosure-embedding")}: ${this.settings.embeddingServerUrl || this.t("search-server-unset")}.\n${this.t("search-disclosure-conversation")}: ${this.settings.serverUrl || this.t("search-server-unset")}.`;
	}

	async manageNoteIndex(action: "index" | "clear"): Promise<void> {
		if (action !== "clear" && this.indexingNote) return;
		if (action !== "clear") { this.indexingNote = true; new Notice(this.noteIndexDisclosure()); }
		try {
			if (action === "clear") await this.noteSearch.clear();
			else { await this.indexRestore; if (this.unloading) return; await this.noteSearch.rebuild(); }
			new Notice(this.t(action === "clear" ? "search-cleared" : "search-state-complete"));
		} catch (error) {
			if (!(error instanceof NoteSearchError && error.code === "search-rebuild")) new Notice(this.t(error instanceof NoteSearchError ? error.code : "search-failed"));
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
			if (leaf.view instanceof ChatView) await leaf.view.refreshSimilarityAppearance();
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
