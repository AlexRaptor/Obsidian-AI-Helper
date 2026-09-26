import { ItemView, WorkspaceLeaf, MarkdownRenderer, Component } from "obsidian";
import type { AiHelperPlugin } from "./main";
import type { LocaleKey } from "./i18n";

export const VIEW_TYPE_CHAT = "ai-helper-chat";

export class ChatView extends ItemView {
	plugin: AiHelperPlugin;
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
		header.createSpan({ text: this.t("view-title") });

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

		const submit = () => this.handleSend();
		sendBtn.addEventListener("click", submit);
		input.addEventListener("keydown", (e) => {
			if (e.key === "Enter" && !e.shiftKey) {
				e.preventDefault();
				submit();
			}
		});
	}

	private clearConversation(): void {
		this.contentEl.querySelector(".ai-helper-messages")?.empty();
	}

	private async handleSend(): Promise<void> {
		const text = this.inputEl?.value.trim() ?? "";
		if (!text) return;

		const messagesEl = this.contentEl.querySelector(".ai-helper-messages");
		if (!messagesEl) return;

		messagesEl.createEl("div", {
			cls: "ai-helper-message ai-helper-message-user",
			text,
		});

		this.inputEl!.value = "";

		const thinking = messagesEl.createEl("div", {
			cls: "ai-helper-message ai-helper-message-model",
		});
		thinking.createSpan({ cls: "ai-helper-thinking", text: this.t("thinking") });
	}
}
