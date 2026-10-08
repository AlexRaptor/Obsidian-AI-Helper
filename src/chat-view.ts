import { Component, ItemView, MarkdownRenderer, WorkspaceLeaf } from "obsidian";
import type { AiHelperPlugin } from "./main";
import type { LocaleKey } from "./i18n";
import { Conversation, type Message, type Role } from "./conversation";
import type { ChatMessage } from "./server-client";

export const VIEW_TYPE_CHAT = "ai-helper-chat";

function formatNumber(value: number): string {
	return value.toLocaleString("en-US");
}

type DisplayMessage = { role: Role; content: string; kind: "text" | "thinking" | "error" };

export class ChatView extends ItemView {
	plugin: AiHelperPlugin;
	conversation = new Conversation();
	private messagesEl: HTMLElement | null = null;
	private headerTitleEl: HTMLElement | null = null;
	private contextBarEl: HTMLElement | null = null;
	private contextLabelEl: HTMLElement | null = null;
	private inputEl: HTMLTextAreaElement | null = null;
	private sendBtn: HTMLButtonElement | null = null;
	private clearBtn: HTMLButtonElement | null = null;
	private messages: DisplayMessage[] = [];
	private thinking: boolean = false;
	private markdownComponents: Component[] = [];
	private activeRequest: AbortController | null = null;
	private renderRevision = 0;

	constructor(leaf: WorkspaceLeaf, plugin: AiHelperPlugin) {
		super(leaf);
		this.plugin = plugin;
	}

	getViewType(): string {
		return VIEW_TYPE_CHAT;
	}

	getDisplayText(): string {
		return this.t("view-title");
	}

	t(key: LocaleKey): string {
		return this.plugin.t(key);
	}

	updateContextIndicators(): void {
		const used = this.conversation.getTokensUsed();
		const raw = this.plugin.settings.contextWindow;
		const limit = raw ? Number(raw) : NaN;

		if (this.contextLabelEl) {
			if (!Number.isFinite(limit) || limit <= 0) {
				this.contextLabelEl.setText(this.t("header-context-empty"));
			} else {
				const pct = Math.min(100, Math.round((used / limit) * 100));
				this.contextLabelEl.setText(
					`${pct}% - ${formatNumber(used)} / ${formatNumber(limit)}`
				);
			}
		}

		if (this.contextBarEl) {
			const fill =
				Number.isFinite(limit) && limit > 0
					? Math.min(100, (used / limit) * 100)
					: 0;
			this.contextBarEl.style.width = `${fill}%`;
		}
	}

	async onOpen(): Promise<void> {
		this.buildStructure();
		this.bindEvents();
		this.setThinking(this.thinking);
		this.updateContextIndicators();
		await this.renderMessages();
	}

	async refreshLocale(): Promise<void> {
		this.headerTitleEl?.setText(this.t("view-title"));
		this.clearBtn?.setText(this.t("clear-conversation"));
		this.inputEl?.setAttribute("placeholder", this.t("input-placeholder"));
		for (const message of this.messages) {
			if (message.kind === "thinking") message.content = this.t("thinking");
		}
		this.setThinking(this.thinking);
		this.updateContextIndicators();
		await this.renderMessages();
	}

	async onClose(): Promise<void> {
		this.cancelRequest();
		this.renderRevision++;
		this.detachMarkdown();
		this.messagesEl = null;
		this.inputEl = null;
		this.sendBtn = null;
		this.clearBtn = null;
		this.headerTitleEl = null;
		this.contextBarEl = null;
		this.contextLabelEl = null;
	}

	getMessages(): Message[] {
		return this.conversation.getMessages();
	}

	clearConversation(): void {
		this.cancelRequest();
		this.conversation.clear();
		this.messages = [];
		this.updateContextIndicators();
		void this.renderMessages();
	}

	private buildStructure(): void {
		const container = this.contentEl;
		container.empty();
		container.addClass("ai-helper");

		const header = container.createDiv({ cls: "ai-helper-header" });
		this.headerTitleEl = header.createSpan({
			cls: "ai-helper-header-title",
			text: this.t("view-title"),
		});
		const contextBar = header.createDiv({ cls: "ai-helper-context-bar" });
		this.contextBarEl = contextBar.createDiv({ cls: "ai-helper-context-bar-fill" });
		this.contextLabelEl = header.createSpan({ cls: "ai-helper-context-label" });
		this.clearBtn = header.createEl("button", {
			cls: "ai-helper-clear-btn",
			text: this.t("clear-conversation"),
		});

		this.messagesEl = container.createDiv({ cls: "ai-helper-messages" });

		const inputRow = container.createDiv({ cls: "ai-helper-input-row" });
		this.inputEl = inputRow.createEl("textarea", {
			cls: "ai-helper-input",
			attr: { rows: "2", placeholder: this.t("input-placeholder") },
		});
		this.sendBtn = inputRow.createEl("button", {
			cls: "ai-helper-send",
			text: this.t("send"),
		});
	}

	private bindEvents(): void {
		this.clearBtn?.addEventListener("click", () => this.clearConversation());
		this.sendBtn?.addEventListener("click", () => void this.handleSend());
		this.inputEl?.addEventListener("keydown", (e) => {
			if (e.key === "Enter" && !e.shiftKey) {
				e.preventDefault();
				void this.handleSend();
			}
		});
	}

	private toRequestMessages(): ChatMessage[] {
		return this.conversation
			.getMessages()
			.map((m) => ({
				role: (m.role === "model" ? "assistant" : m.role) as ChatMessage["role"],
				content: m.content,
			}));
	}

	private detachMarkdown(): void {
		for (const child of this.markdownComponents.splice(0)) {
			this.removeChild(child);
		}
	}

	async renderMessages(): Promise<void> {
		const revision = ++this.renderRevision;
		const el = this.messagesEl;
		if (!el) return;
		this.detachMarkdown();
		el.empty();

		for (const message of [...this.messages]) {
			if (revision !== this.renderRevision) return;
			const div = el.createEl("div", {
				cls: `ai-helper-message ai-helper-message-${message.role}`,
			});
			div.addClass(`ai-helper-message-kind-${message.kind}`);

			const branch = div.createEl("div", { cls: "ai-helper-message-branch" });
			const body = div.createEl("div", { cls: "ai-helper-message-body" });

			if (message.kind === "error") {
				branch.addClass("ai-helper-branch-error");
				const prefix = body.createSpan({ cls: "ai-helper-error-prefix" });
				prefix.setText(this.t("chat-error-prefix"));
				body.createSpan({ text: ` ${message.content}` });
			} else if (message.role !== "model" || message.kind === "thinking") {
				if (message.kind === "thinking") {
					branch.addClass("ai-helper-branch-thinking");
					body.createSpan({ cls: "ai-helper-thinking", text: message.content });
				} else {
					body.createSpan({ text: message.content });
				}
			} else {
				const markdown = body.createEl("div", { cls: "ai-helper-markdown" });
				const component = new Component();
				component.load();
				this.addChild(component);
				this.markdownComponents.push(component);
				try {
					await MarkdownRenderer.render(
						this.app,
						message.content,
						markdown,
						"",
						component
					);
				} catch {
					if (revision !== this.renderRevision) return;
					markdown.createEl("pre", { text: message.content });
				}
			}
		}
		if (revision === this.renderRevision) el.scrollTop = el.scrollHeight;
	}

	private setThinking(thinking: boolean): void {
		this.thinking = thinking;
		if (this.sendBtn) {
			this.sendBtn.disabled = thinking;
			this.sendBtn.setText(this.t(thinking ? "thinking" : "send"));
		}
	}

	private cancelRequest(): void {
		const request = this.activeRequest;
		this.activeRequest = null;
		request?.abort();
		this.messages = this.messages.filter((message) => message.kind !== "thinking");
		this.setThinking(false);
	}

	private async handleSend(): Promise<void> {
		if (this.thinking) return;
		const text = this.inputEl?.value.trim() ?? "";
		if (!text) return;

		this.inputEl!.value = "";
		this.messages.push({ role: "user", content: text, kind: "text" });
		const pending: DisplayMessage = { role: "model", content: this.t("thinking"), kind: "thinking" };
		this.messages.push(pending);
		const request = new AbortController();
		this.activeRequest = request;
		const { settings, serverClient } = this.plugin;
		const requestMessages: ChatMessage[] = [
			...this.toRequestMessages(), { role: "user", content: text },
		];
		const params = {
			apiKey: settings.apiKey,
			systemPrompt: settings.systemPrompt,
			temperature: settings.temperature,
			maxTokens: settings.maxTokens,
			topP: settings.topP,
			signal: request.signal,
		};
		const serverUrl = settings.serverUrl.trim();
		const model = settings.model;

		this.setThinking(true);
		try {
			await this.renderMessages();
			if (this.activeRequest !== request) return;
			const result = await serverClient.chat(serverUrl, model, requestMessages, params);
			if (this.activeRequest !== request) return;

			if (result.ok) {
				const { content, usage } = result.value;
				// Commit the turn together so failed attempts never enter request history.
				this.conversation.addMessage({ role: "user", content: text });
				this.conversation.addMessage({ role: "model", content });
				if (usage) this.conversation.recordUsage(usage);
				pending.content = content;
				pending.kind = "text";
			} else {
				pending.content = result.error.message;
				pending.kind = "error";
				if (this.inputEl && !this.inputEl.value) this.inputEl.value = text;
			}
		} catch (error) {
			if (this.activeRequest !== request) return;
			pending.content = error instanceof Error ? error.message : String(error);
			pending.kind = "error";
			if (this.inputEl && !this.inputEl.value) this.inputEl.value = text;
		} finally {
			if (this.activeRequest === request) {
				this.activeRequest = null;
				this.setThinking(false);
				this.updateContextIndicators();
				await this.renderMessages();
			}
		}
	}
}
