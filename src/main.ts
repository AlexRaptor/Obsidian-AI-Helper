import { Plugin } from "obsidian";
import {
	AiHelperSettings,
	DEFAULT_SETTINGS,
	AiHelperSettingsTab,
	type ModelStatus,
} from "./settings";
import { ChatView, VIEW_TYPE_CHAT } from "./chat-view";
import { createServerClient, type ServerClient } from "./server-client";
import { setLanguage, t, type LocaleKey } from "./i18n";

export class AiHelperPlugin extends Plugin {
	settings: AiHelperSettings = DEFAULT_SETTINGS;
	models: string[] = [];
	modelStatus: ModelStatus = "idle";
	private modelRequest: AbortController | null = null;
	serverClient: ServerClient = createServerClient(
		(input, init) => globalThis.fetch(input, init)
	);

	async onload(): Promise<void> {
		await this.loadSettings();
		this.applyLanguage();

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
		void this.refreshModels();
	}

	onunload(): void {
		this.modelRequest?.abort();
		this.modelRequest = null;
		this.app.workspace.detachLeavesOfType(VIEW_TYPE_CHAT);
	}

	async loadSettings(): Promise<void> {
		this.settings = Object.assign({}, DEFAULT_SETTINGS, await this.loadData());
	}

	async saveSettings(): Promise<void> {
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
			await workspace.revealLeaf(existing);
			return;
		}
		await workspace.ensureSideLeaf(VIEW_TYPE_CHAT, "right", { active: true, reveal: true });
	}
}

export default AiHelperPlugin;
