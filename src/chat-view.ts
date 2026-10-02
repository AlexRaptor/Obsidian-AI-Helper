import { Component, ItemView, MarkdownRenderer, WorkspaceLeaf } from "obsidian";
import type { AiHelperPlugin } from "./main";
import type { LocaleKey } from "./i18n";
import { Conversation, type Message, type Role } from "./conversation";
import type { ChatMessage } from "./server-client";

export const VIEW_TYPE_CHAT = "ai-helper-chat";

type DisplayMessage = { role: Role; content: string; kind: "text" | "thinking" | "error" };

export class ChatView extends ItemView {
	plugin: AiHelperPlugin;
	conversation = new Conversation();
	private messagesEl: HTMLElement | null = null;
	private inputEl: HTMLTextAreaElement | null = null;
	private sendBtn: HTMLButtonElement | null = null;
	private messages: DisplayMessage[] = [];
	private thinking: boolean = false;
	private markdownComponents: Component[] = [];

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

	async onOpen(): Promise<void> {
		const container = this.contentEl;
		container.empty();
		container.addClass("ai-helper");

		const header = container.createDiv({ cls: "ai-helper-header" });
		header.createSpan({ cls: "ai-helper-header-title", text: this.t("view-title") });

		const clearBtn = header.createEl("button", {
			cls: "ai-helper-clear-btn",
			text: this.t("clear-conversation"),
		});
		clearBtn.addEventListener("click", () => this.clearConversation());

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

		this.sendBtn.addEventListener("click", () => void this.handleSend());
		this.inputEl.addEventListener("keydown", (e) => {
			if (e.key === "Enter" && !e.shiftKey) {
				e.preventDefault();
				void this.handleSend();
			}
		});

		this.setThinking(false);
		await this.renderMessages();
	}

	async refreshLocale(): Promise<void> {
		await this.onOpen();
	}

	getMessages(): Message[] {
		return this.conversation.getMessages();
	}

	clearConversation(): void {
		this.conversation.clear();
		this.messages = [];
		void this.renderMessages();
	}

	private toRequestMessages(): ChatMessage[] {
		return this.conversation
			.getMessages()
			.map((m) => ({
				role: (m.role === "model" ? "assistant" : m.role) as ChatMessage["role"],
				content: m.content,
			}));
	}

	private async renderMessages(): Promise<void> {
		const el = this.messagesEl;
		if (!el) return;
		el.empty();
		const md = this.markdownComponents.splice(0);
		for (const child of md) {
			this.removeChild(child);
		}

		for (const message of this.messages) {
			const div = el.createEl("div", {
				cls: `ai-helper-message ai-helper-message-${message.role}${
					message.kind !== "text" ? ` ai-helper-message-${message.kind}` : ""
				}`,
			});

			if (message.kind === "error") {
				const prefix = div.createSpan({ cls: "ai-helper-error-prefix" });
				prefix.setText(this.t("chat-error-prefix"));
				const detail = div.createSpan({ cls: "ai-helper-error-detail" });
				detail.setText(message.content);
			} else if (message.role !== "model" || message.kind === "thinking") {
				div.createSpan({ text: message.content });
			} else {
				const body = div.createEl("div", { cls: "ai-helper-markdown" });
				const component = new Component();
				component.load();
				this.addChild(component);
				this.markdownComponents.push(component);
				try {
					await MarkdownRenderer.render(
						this.app,
						message.content,
						body,
						"",
						component
					);
				} catch {
					body.createEl("pre", { text: message.content });
				}
			}
		}
		el.scrollTop = el.scrollHeight;
	}

	private setThinking(thinking: boolean): void {
		this.thinking = thinking;
		if (this.sendBtn) {
			this.sendBtn.disabled = thinking;
			this.sendBtn.setText(this.t(thinking ? "thinking" : "send"));
		}
	}

	private async handleSend(): Promise<void> {
		if (this.thinking) return;
		const text = this.inputEl?.value.trim() ?? "";
		if (!text) return;

		this.inputEl!.value = "";
		this.conversation.addMessage({ role: "user", content: text });
		this.messages.push({ role: "user", content: text, kind: "text" });
		this.messages.push({ role: "model", content: this.t("thinking"), kind: "thinking" });

		this.setThinking(true);
		await this.renderMessages();

		const { settings, serverClient } = this.plugin;
		const thinkingIndex = this.messages.length - 1;

		const result = await serverClient.chat(
			settings.serverUrl.trim(),
			settings.model,
			this.toRequestMessages(),
			{
				apiKey: settings.apiKey,
				systemPrompt: settings.systemPrompt,
				temperature: settings.temperature,
				maxTokens: settings.maxTokens,
				topP: settings.topP,
			}
		);

		if (result.ok) {
			this.conversation.addMessage({ role: "model", content: result.value });
			this.messages[thinkingIndex] = {
				role: "model",
				content: result.value,
				kind: "text",
			};
		} else {
			this.messages[thinkingIndex] = {
				role: "model",
				content: result.error.message,
				kind: "error",
			};
			if (this.inputEl) {
				this.inputEl.value = text;
			}
		}

		this.setThinking(false);
		await this.renderMessages();
	}
}
