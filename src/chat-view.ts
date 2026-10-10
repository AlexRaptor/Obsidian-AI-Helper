import { Component, ItemView, MarkdownRenderer, WorkspaceLeaf } from "obsidian";
import type { AiHelperPlugin } from "./main";
import type { LocaleKey } from "./i18n";
import { Conversation, type Message, type Role } from "./conversation";
import type { ChatMessage } from "./server-client";

export const VIEW_TYPE_CHAT = "ai-helper-chat";

function formatNumber(value: number): string {
	return value.toLocaleString("en-US");
}

type DisplayMessage = { role: Role; content: string; kind: "text" | "thinking" | "error"; error?: string; stopped?: boolean };

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
	private rendered = new Map<DisplayMessage, { div: HTMLElement; branch: HTMLElement; body: HTMLElement; revision: number; signature: string; component?: Component }>();
	private updateTimer: ReturnType<typeof setTimeout> | null = null;
	private activeRequest: AbortController | null = null;
	private renderRevision = 0;
	private activeMessage: DisplayMessage | null = null;
	private draft = "";
	private followingMessages = true;
	private messageResizeObserver: ResizeObserver | null = null;

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
			if (used === undefined) {
				this.contextLabelEl.setText(this.t("header-context-unavailable"));
			} else if (!Number.isFinite(limit) || limit <= 0) {
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
				used !== undefined && Number.isFinite(limit) && limit > 0
					? Math.min(100, (used / limit) * 100)
					: 0;
			this.contextBarEl.style.width = `${fill}%`;
		}
	}

	async onOpen(): Promise<void> {
		this.detachScrollObserver();
		this.detachMarkdown();
		this.followingMessages = true;
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
		this.draft = this.inputEl?.value ?? this.draft;
		this.cancelRequest();
		this.renderRevision++;
		this.detachScrollObserver();
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
		this.cancelRequest(false);
		this.conversation.clear();
		this.messages = [];
		this.followingMessages = true;
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
		this.inputEl.value = this.draft;
		this.sendBtn = inputRow.createEl("button", {
			cls: "ai-helper-send",
			text: this.t("send"),
		});
	}

	private detachScrollObserver(): void {
		this.messageResizeObserver?.disconnect();
		this.messageResizeObserver = null;
	}

	private followMessages(): void {
		if (this.followingMessages && this.messagesEl) {
			this.messagesEl.scrollTop = Math.max(0, this.messagesEl.scrollHeight - this.messagesEl.clientHeight);
		}
	}

	private bindEvents(): void {
		const messages = this.messagesEl;
		if (messages) {
			messages.addEventListener("scroll", () => {
				if (this.messagesEl !== messages) return;
				this.followingMessages = messages.scrollHeight - messages.clientHeight - messages.scrollTop <= 32;
			});
			// Markdown embeds and code blocks can change height after render() resolves.
			if (typeof ResizeObserver !== "undefined") {
				this.messageResizeObserver = new ResizeObserver(() => {
					if (this.messagesEl === messages) this.followMessages();
				});
				this.messageResizeObserver.observe(messages);
			}
		}
		this.clearBtn?.addEventListener("click", () => this.clearConversation());
		this.sendBtn?.addEventListener("click", () => {
			if (this.thinking) { this.cancelRequest(); void this.renderMessages(); }
			else void this.handleSend();
		});
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
		for (const row of this.rendered.values()) {
			row.revision++;
			if (row.component) this.removeChild(row.component);
		}
		this.rendered.clear();
	}

	async renderMessages(): Promise<void> {
		const revision = this.renderRevision;
		const el = this.messagesEl;
		if (!el) return;
		for (const [message, row] of this.rendered) {
			if (!this.messages.includes(message)) {
				row.revision++;
				if (row.component) this.removeChild(row.component);
				this.messageResizeObserver?.unobserve(row.div);
				row.div.remove();
				this.rendered.delete(message);
			}
		}
		const updates: Promise<void>[] = [];
		for (const message of this.messages) {
			let row = this.rendered.get(message);
			if (!row) {
				const div = el.createDiv({ cls: `ai-helper-message ai-helper-message-${message.role}` });
				const branch = div.createDiv({ cls: "ai-helper-message-branch" });
				row = { div, branch, body: div.createDiv({ cls: "ai-helper-message-body" }), revision: 0, signature: "" };
				this.rendered.set(message, row);
				this.messageResizeObserver?.observe(div);
			}
			const signature = `${message.kind}\0${message.content}\0${message.error ?? ""}\0${message.stopped ? this.t("chat-stopped") : ""}\0${this.t("chat-error-prefix")}`;
			if (row.signature === signature) continue;
			row.signature = signature;
			const current = row;
			const rowRevision = ++current.revision;
			if (current.component) { this.removeChild(current.component); current.component = undefined; }
			current.branch.className = `ai-helper-message-branch${message.kind === "thinking" ? " ai-helper-branch-thinking" : message.kind === "error" || message.error ? " ai-helper-branch-error" : ""}`;
			current.div.className = `ai-helper-message ai-helper-message-${message.role} ai-helper-message-kind-${message.kind}`;
			// Render off-tree. A slow renderer cannot replace a newer update or resurrect a cleared row.
			const staging = current.body.createDiv({ cls: "ai-helper-markdown" });
			staging.remove();
			const content = message.content;
			const error = message.error;
			const kind = message.kind;
			const stopped = message.stopped;
			const component = new Component();
			component.load();
			this.addChild(component);
			current.component = component;
			updates.push((async () => {
				if (message.role === "model" && kind === "text") {
					try { await MarkdownRenderer.render(this.app, content, staging, "", component); }
					catch { staging.empty(); staging.createEl("pre", { text: content }); }
				} else if (kind === "error") {
					staging.createSpan({ cls: "ai-helper-error-prefix", text: this.t("chat-error-prefix") });
					staging.createSpan({ text: ` ${content}` });
				} else staging.createSpan({ cls: kind === "thinking" ? "ai-helper-thinking" : "", text: content });
				if (stopped) staging.createDiv({ cls: "ai-helper-stopped", text: this.t("chat-stopped") });
				if (error) staging.createDiv({ cls: "ai-helper-error-prefix", text: `${this.t("chat-error-prefix")}: ${error}` });
				if (revision !== this.renderRevision || current.revision !== rowRevision || this.messagesEl !== el) return;
				current.body.empty();
				current.body.appendChild(staging);
				this.followMessages();
			})());
		}
		await Promise.all(updates);
	}

	private clearUpdateTimer(): void {
		if (this.updateTimer !== null) clearTimeout(this.updateTimer);
		this.updateTimer = null;
	}

	private setThinking(thinking: boolean): void {
		this.thinking = thinking;
		if (this.sendBtn) {
			this.sendBtn.disabled = false;
			this.sendBtn.className = `ai-helper-send${thinking ? " ai-helper-stop" : ""}`;
			this.sendBtn.setText(this.t(thinking ? "stop" : "send"));
		}
	}

	private cancelRequest(preservePartial = true): void {
		const request = this.activeRequest;
		this.activeRequest = null;
		if (preservePartial && this.activeMessage) {
			if (this.activeMessage.kind === "thinking") this.activeMessage.content = "";
			this.activeMessage.kind = "text";
			this.activeMessage.stopped = true;
			// Flush received text synchronously; Markdown may finish after the stop action.
			const row = this.rendered.get(this.activeMessage);
			if (row) {
				row.revision++;
				row.signature = "";
				row.body.empty();
				row.body.createSpan({ text: this.activeMessage.content });
				row.body.createDiv({ cls: "ai-helper-stopped", text: this.t("chat-stopped") });
			}
		}
		this.activeMessage = null;
		this.clearUpdateTimer();
		request?.abort();
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
		this.activeMessage = pending;
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
			responseWait: settings.responseWait,
			signal: request.signal,
			onText: (content: string) => {
				if (this.activeRequest !== request) return;
				const first = pending.kind === "thinking";
				pending.kind = "text";
				pending.content = content;
				if (first) void this.renderMessages();
				else if (this.updateTimer === null) this.updateTimer = setTimeout(() => {
					this.updateTimer = null;
					if (this.activeRequest === request) void this.renderMessages();
				}, 100);
			},
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
				this.conversation.recordUsage(usage);
				pending.content = content;
				pending.kind = "text";
			} else {
				const message = result.error.code === "empty" ? this.t("chat-empty-response")
					: result.error.code === "incomplete" ? this.t("chat-incomplete-response")
					: result.error.code === "timeout" ? this.t("chat-response-timeout") : result.error.message;
				if (pending.kind === "text") pending.error = message;
				else { pending.content = message; pending.kind = "error"; }
				if (this.inputEl && !this.inputEl.value) this.inputEl.value = text;
			}
		} catch (error) {
			if (this.activeRequest !== request) return;
			const message = error instanceof Error ? error.message : String(error);
			if (pending.kind === "text") pending.error = message;
			else { pending.content = message; pending.kind = "error"; }
			if (this.inputEl && !this.inputEl.value) this.inputEl.value = text;
		} finally {
			if (this.activeRequest === request) {
				this.activeRequest = null;
				this.activeMessage = null;
				this.clearUpdateTimer();
				this.setThinking(false);
				this.updateContextIndicators();
				await this.renderMessages();
			}
		}
	}
}
