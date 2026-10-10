import { FileSystemAdapter, Notice, Plugin, parseYaml } from "obsidian";
import {
	AiHelperSettings,
	DEFAULT_SETTINGS,
	AiHelperSettingsTab,
	type ModelStatus,
} from "./settings";
import { ChatView, VIEW_TYPE_CHAT } from "./chat-view";
import { createServerClient, type ServerClient } from "./server-client";
import { setLanguage, t, type LocaleKey } from "./i18n";
import { createModelConnection } from "./model-connection";
import { DEFAULT_FRAGMENT_OPTIONS, isValidFragmentOptions } from "./note-fragments";
import { createNoteSearchConnection } from "./note-search";
import { createNoteSearch, NoteSearchError, isValidMinimumSimilarity, type NoteSearch } from "./note-index";
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
	noteSearchConnection = createNoteSearchConnection(this.serverClient);
	modelConnection = createModelConnection(this.serverClient);
	contextWindowConnection = createContextWindowConnection(this.serverClient);

	async onload(): Promise<void> {
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
			metadata: (_path, raw) => {
				const yaml = raw.match(/^\uFEFF?---\r?\n([\s\S]*?)\r?\n(?:---|\.\.\.)(?:\r?\n|$)/);
				const value: unknown = yaml ? parseYaml(yaml[1]) : {};
				return value && typeof value === "object" ? value as Record<string, unknown> : {};
			},
			open: (path, heading) => this.app.workspace.openLinkText(heading ? `${path}#${heading}` : path, "", false),
		});
		this.noteSearch.configure(this.settings);

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
		this.addSettingTab(new AiHelperSettingsTab(this.app, this));
		this.addCommand({
			id: "local-storage-probe",
			name: this.t("probe-title"),
			callback: () => new StorageProbeModal(this.app).open(),
		});
		this.addCommand({
			id: "index-active-note", name: this.t("search-index"),
			callback: () => { void this.indexActiveNote(); },
		});
		void this.refreshModels();
		void this.refreshEmbeddingModels();
	}

	onunload(): void {
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
		if (!isValidFragmentOptions(this.settings)) Object.assign(this.settings, DEFAULT_FRAGMENT_OPTIONS);
		if (!isValidMinimumSimilarity(this.settings.noteSearchMinSimilarity)) this.settings.noteSearchMinSimilarity = DEFAULT_SETTINGS.noteSearchMinSimilarity;
		this.noteSearchConnection.configure(this.settings);
		this.modelConnection.configure(this.settings);
		this.contextWindowConnection.configure(this.settings);
	}

	async indexActiveNote(): Promise<void> {
		if (this.indexingNote) return;
		const file = this.app.workspace.getActiveFile();
		if (!file || file.extension !== "md") { new Notice(this.t("search-note")); return; }
		this.indexingNote = true;
		new Notice(this.t("search-indexing"));
		try { await this.noteSearch.index(file.path); new Notice(this.t("search-indexed")); }
		catch (error) { new Notice(this.t(error instanceof NoteSearchError ? error.code : "search-failed")); }
		finally { this.indexingNote = false; }
	}

	async saveSettings(): Promise<void> {
		this.noteSearch?.configure(this.settings);
		this.noteSearchConnection.configure(this.settings);
		this.modelConnection.configure(this.settings);
		if (this.contextWindowConnection.configure(this.settings)) void this.contextWindowConnection.refresh();
		this.updateContextIndicators();
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
		setLanguage(this.settings.language);
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
