import { ItemView, WorkspaceLeaf } from "obsidian";
import type { AiHelperPlugin } from "./main";
import type { LocaleKey } from "./i18n";
import { Conversation, type Message, type Role } from "./conversation";

export const VIEW_TYPE_CHAT = "ai-helper-chat";

export class ChatView extends ItemView {
	plugin: AiHelperPlugin;
	conversation = new Conversation();
	private inputEl: HTMLTextAreaElement | null = null;

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

		const header = container.createDiv({
			cls: "ai-helper-header",
			attr: { style: "display:flex;justify-content:space-between;align-items:center;" },
		});
		header.createSpan({ cls: "ai-helper-header-title", text: this.t("view-title") });

		const clearBtn = header.createEl("button", {
			cls: "ai-helper-clear-btn",
			text: this.t("clear-conversation"),
		});
		clearBtn.addEventListener("click", () => this.clearConversation());

		container.createDiv({ cls: "ai-helper-messages" });

		const inputRow = container.createDiv({ cls: "ai-helper-input-row" });
		const input = inputRow.createEl("textarea", {
			cls: "ai-helper-input",
			attr: { rows: "2", placeholder: this.t("input-placeholder") },
		});
		const sendBtn = inputRow.createEl("button", {
			cls: "ai-helper-send",
			text: this.t("send"),
		});

		this.inputEl = input;
		sendBtn.addEventListener("click", () => this.handleSend());
		input.addEventListener("keydown", (e) => {
			if (e.key === "Enter" && !e.shiftKey) {
				e.preventDefault();
				this.handleSend();
			}
		});

		this.renderMessages();
	}

	async refreshLocale(): Promise<void> {
		await this.onOpen();
	}

	getMessages(): Message[] {
		return this.conversation.getMessages();
	}

	clearConversation(): void {
		this.conversation.clear();
		this.renderMessages();
	}

	private renderMessages(): void {
		const messagesEl = this.contentEl.querySelector(".ai-helper-messages");
		if (!messagesEl) return;
		messagesEl.empty();
		for (const message of this.conversation.getMessages()) {
			messagesEl.createEl("div", {
				cls: `ai-helper-message ai-helper-message-${message.role}`,
				text: message.content,
			});
		}
	}

	private async handleSend(): Promise<void> {
		const text = this.inputEl?.value.trim() ?? "";
		if (!text) return;
		this.inputEl!.value = "";

		this.conversation.addMessage({ role: "user", content: text });
		this.conversation.addMessage({ role: "model", content: this.t("thinking") });
		this.renderMessages();
	}
}
