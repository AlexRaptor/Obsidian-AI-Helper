import { setIcon, setTooltip } from "obsidian";
import type { LocaleKey } from "./i18n";

/** Owns the message field and its draft for one chat view's lifetime. */
export class MessageInput {
	private inputEl: HTMLTextAreaElement | null = null;
	private sendBtn: HTMLButtonElement | null = null;
	private draft = "";
	private thinking = false;
	private searchEnabled = false;

	constructor(
		private t: (key: LocaleKey) => string,
		private onSend: () => void,
		private onStop: () => void,
	) {}

	private handleClick = (): void => {
		if (this.thinking) this.onStop();
		else this.onSend();
	};

	private handleKeydown = (event: KeyboardEvent): void => {
		if (event.key === "Enter" && !event.shiftKey) {
			event.preventDefault();
			this.onSend();
		}
	};

	mount(container: HTMLElement): void {
		this.unmount();
		const row = container.createDiv({ cls: "ai-helper-input-row" });
		this.inputEl = row.createEl("textarea", {
			cls: "ai-helper-input",
			attr: { rows: "2", placeholder: this.t("input-placeholder") },
		});
		this.inputEl.value = this.draft;
		this.sendBtn = row.createEl("button", {
			cls: "ai-helper-send mod-cta",
			attr: { type: "button" },
		});
		this.inputEl.addEventListener("keydown", this.handleKeydown);
		this.sendBtn.addEventListener("click", this.handleClick);
		this.refreshLocale();
	}

	unmount(): void {
		this.draft = this.getDraft();
		this.inputEl?.removeEventListener("keydown", this.handleKeydown);
		this.sendBtn?.removeEventListener("click", this.handleClick);
		this.inputEl = null;
		this.sendBtn = null;
	}

	getDraft(): string { return this.inputEl?.value ?? this.draft; }

	clear(): void {
		this.draft = "";
		if (this.inputEl) this.inputEl.value = "";
	}

	restoreIfEmpty(text: string): void {
		if (this.inputEl && !this.getDraft()) this.inputEl.value = text;
	}

	setAction(thinking: boolean, searchEnabled: boolean): void {
		this.thinking = thinking;
		this.searchEnabled = searchEnabled;
		if (!this.sendBtn) return;
		this.sendBtn.disabled = false;
		this.sendBtn.className = `ai-helper-send${thinking ? " ai-helper-stop" : " mod-cta"}`;
		const label = this.t(thinking ? "stop" : "send");
		this.sendBtn.setAttribute("aria-label", label);
		setTooltip(this.sendBtn, label);
		setIcon(this.sendBtn, thinking ? "square" : searchEnabled ? "search" : "play");
	}

	refreshLocale(): void {
		this.inputEl?.setAttribute("placeholder", this.t("input-placeholder"));
		this.setAction(this.thinking, this.searchEnabled);
	}
}
