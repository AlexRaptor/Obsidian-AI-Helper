import { FileSystemAdapter, Notice, Plugin } from "obsidian";
import {
	AiHelperSettings,
	DEFAULT_SETTINGS,
	AiHelperSettingsTab,
	type ModelStatus,
} from "./settings";
import { ChatView, VIEW_TYPE_CHAT } from "./chat-view";
import { createServerClient, type ServerClient } from "./server-client";
import { setLanguage, t, type LocaleKey } from "./i18n";
import { createNoteSearchConnection } from "./note-search";
import { createNoteSearch, NoteSearchError, type NoteSearch } from "./note-index";
import { StorageProbeModal } from "./storage-probe-modal";

export class AiHelperPlugin extends Plugin {
	settings: AiHelperSettings = DEFAULT_SETTINGS;
	models: string[] = [];
	modelStatus: ModelStatus = "idle";
	private modelRequest: AbortController | null = null;
	serverClient: ServerClient = createServerClient(
		(input, init) => globalThis.fetch(input, init)
	);

	noteSearch!: NoteSearch;
	private indexingNote = false;
	noteSearchConnection = createNoteSearchConnection(this.serverClient);

	async onload(): Promise<void> {
		await this.loadSettings();
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
			open: (path) => this.app.workspace.openLinkText(path, "", false),
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
	}

	onunload(): void {
		this.noteSearch?.dispose();
		this.noteSearchConnection.cancel();
		this.modelRequest?.abort();
		this.modelRequest = null;
		this.app.workspace.detachLeavesOfType(VIEW_TYPE_CHAT);
	}

	async loadSettings(): Promise<void> {
		this.settings = Object.assign({}, DEFAULT_SETTINGS, await this.loadData());
		this.noteSearchConnection.configure(this.settings);
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
		await this.saveData(this.settings);
	}

	async refreshModels(): Promise<void> {
		this.modelRequest?.abort();
		const request = new AbortController();
		this.modelRequest = request;
		const url = this.settings.serverUrl.trim();
		const apiKey = this.settings.apiKey;
		if (!url) {
			this.modelRequest = null;
			this.models = [];
			this.modelStatus = "idle";
			return;
		}

		try {
			const result = await this.serverClient.listModels(url, apiKey, request.signal);
			if (this.modelRequest !== request || url !== this.settings.serverUrl.trim() || apiKey !== this.settings.apiKey) {
				return;
			}
			if (result.ok) {
				this.models = result.value;
				this.modelStatus = result.value.length > 0 ? "loaded" : "empty";
			} else {
				this.models = [];
				this.modelStatus = "error";
			}
		} catch {
			if (this.modelRequest === request) {
				this.models = [];
				this.modelStatus = "error";
			}
		} finally {
			if (this.modelRequest === request) this.modelRequest = null;
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
