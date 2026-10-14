import { setIcon, setTooltip, type TFile } from "obsidian";
import type { LocaleKey } from "./i18n";

let inputSequence = 0;

export type DraftPart = string | { file: TFile };
export interface MessageDraft { parts: DraftPart[]; }

export function draftText(draft: MessageDraft): string {
	return draft.parts.map(part => typeof part === "string" ? part : `@${part.file.basename}`).join("");
}
export function renderDraft(container: HTMLElement, draft: MessageDraft): void {
	for (const part of draft.parts) {
		if (typeof part === "string") container.createSpan({ text: part });
		else {
			const chip = container.createSpan({ cls: "ai-helper-mention", text: `@${part.file.basename}`, attr: { contenteditable: "false", title: part.file.path, "aria-label": `${part.file.basename}: ${part.file.path}` } });
			setTooltip(chip, part.file.path);
		}
	}
}

/** Owns the message field and its draft for one chat view's lifetime. */
export class MessageInput {
	private inputEl: HTMLElement | null = null;
	private readonly suggestionId = `ai-helper-mentions-${++inputSequence}`;
	private sendBtn: HTMLButtonElement | null = null;
	private draft: MessageDraft = { parts: [] };
	private bindings = new Map<string, TFile>();
	private mentionSequence = 0;
	private suggestion: HTMLElement | null = null;
	private candidate: TFile | null = null;
	private mentionStart = 0;
	private mentionEnd = 0;
	private thinking = false;
	private searchEnabled = false;

	constructor(
		private t: (key: LocaleKey) => string,
		private onSend: () => void,
		private onStop: () => void,
		private currentNote: () => TFile | null = () => null,
	) {}

	private handleClick = (): void => {
		if (this.thinking) this.onStop();
		else this.onSend();
	};

	private closeSuggestion(): void {
		this.suggestion?.empty();
		if (this.suggestion) this.suggestion.style.display = "none";
		this.candidate = null;
		this.inputEl?.setAttribute("aria-expanded", "false");
		this.inputEl?.removeAttribute("aria-activedescendant");
	}

	private caretOffset(): number {
		const selection = this.inputEl?.ownerDocument?.getSelection();
		if (!selection?.rangeCount || !this.inputEl?.contains(selection.anchorNode)) return draftText(this.getDraft()).length;
		const range = selection.getRangeAt(0).cloneRange();
		range.selectNodeContents(this.inputEl); range.setEnd(selection.anchorNode!, selection.anchorOffset);
		return draftText(this.readParts(range.cloneContents())).length;
	}

	private handleInput = (event: Event): void => {
		const input = event as InputEvent;
		this.closeSuggestion();
		if (input.inputType !== "insertText" || input.isComposing) return;
		const text = draftText(this.getDraft()).slice(0, this.caretOffset());
		const match = /(?:^|[ \t\n])@([^\s@]*)$/.exec(text);
		if (!match) return;
		const start = text.length - match[1].length - 1;
		const before = text.slice(0, start);
		let fence = "";
		let inline = 0;
		let indented = false;
		for (const line of before.split("\n")) {
			const delimiter = /^ {0,3}(`{3,}|~{3,})(.*)$/.exec(line);
			if (fence) {
				if (delimiter && delimiter[1][0] === fence[0] && delimiter[1].length >= fence.length && !delimiter[2].trim()) fence = "";
				continue;
			}
			if (delimiter) { fence = delimiter[1]; inline = 0; continue; }
			indented = /^(?: {4}|\t)/.test(line);
			for (const run of line.match(/\\.|`+/g) ?? []) {
				if (run[0] !== "`") continue;
				if (!inline) inline = run.length;
				else if (inline === run.length) inline = 0;
			}
		}
		if (fence || inline || indented) return;
		const file = this.currentNote();
		if (!file || (match[1] && !`${file.basename} ${file.path}`.toLocaleLowerCase().includes(match[1].toLocaleLowerCase()))) return;
		this.candidate = file; this.mentionStart = start; this.mentionEnd = text.length;
		if (!this.suggestion) return;
		this.suggestion.style.display = "";
		const option = this.suggestion.createEl("button", { cls: "suggestion-item is-selected", text: `${file.basename} — ${file.path}`, attr: { type: "button", id: `${this.suggestionId}-current`, role: "option", "aria-selected": "true" } });
		option.addEventListener("mousedown", event => event.preventDefault());
		option.addEventListener("click", () => this.confirmMention());
		this.inputEl?.setAttribute("aria-expanded", "true");
		this.inputEl?.setAttribute("aria-activedescendant", `${this.suggestionId}-current`);
	};

	private confirmMention(): void {
		if (!this.candidate) return;
		const file = this.candidate;
		const draft = this.getDraft();
		const parts: DraftPart[] = [];
		let offset = 0;
		let selectedPart = 0;
		for (const part of draft.parts) {
			const length = typeof part === "string" ? part.length : `@${part.file.basename}`.length;
			if (typeof part === "string" && offset <= this.mentionStart && offset + length >= this.mentionEnd) {
				selectedPart = parts.length + 1;
				parts.push(part.slice(0, this.mentionStart - offset), { file }, part.slice(this.mentionEnd - offset));
			} else parts.push(part);
			offset += length;
		}
		this.setDraft({ parts });
		this.closeSuggestion();
		this.inputEl?.focus();
		const selection = this.inputEl?.ownerDocument?.getSelection();
		const chip = this.inputEl?.childNodes[selectedPart];
		if (selection && chip) {
			const range = this.inputEl!.ownerDocument.createRange();
			range.setStartAfter(chip); range.collapse(true);
			selection.removeAllRanges(); selection.addRange(range);
		}
	}

	private handleKeydown = (event: KeyboardEvent): void => {
		if (event.isComposing) return;
		if (this.candidate) {
			if (event.key === "Escape") { event.preventDefault(); this.closeSuggestion(); return; }
			if (event.key === "ArrowDown" || event.key === "ArrowUp") { event.preventDefault(); return; }
			if (event.key === "Tab" || (event.key === "Enter" && !event.shiftKey)) {
				event.preventDefault(); this.confirmMention(); return;
			}
		}
		if (event.key === "Enter" && !event.shiftKey) {
			event.preventDefault(); this.closeSuggestion(); this.onSend();
		}
	};

	// The plaintext-only editor handles paste natively, preserving its undo history.
	private handlePaste = (): void => { this.closeSuggestion(); };

	mount(container: HTMLElement): void {
		this.unmount();
		const row = container.createDiv({ cls: "ai-helper-input-row" });
		this.inputEl = row.createEl("div", {
			cls: "ai-helper-input",
			attr: { contenteditable: "plaintext-only", role: "textbox", "aria-autocomplete": "list", "aria-controls": this.suggestionId, "aria-multiline": "true", "aria-label": this.t("input-placeholder"), "data-placeholder": this.t("input-placeholder") },
		});
		this.setDraft(this.draft);
		this.suggestion = row.createDiv({ cls: "ai-helper-mention-suggest suggestion-container", attr: { id: this.suggestionId, role: "listbox", "aria-label": this.t("mention-current") } });
		this.closeSuggestion();
		this.inputEl.addEventListener("input", this.handleInput);
		this.inputEl.addEventListener("paste", this.handlePaste);
		this.inputEl.addEventListener("blur", this.closeOnBlur);
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
		this.inputEl?.removeEventListener("input", this.handleInput);
		this.inputEl?.removeEventListener("paste", this.handlePaste);
		this.inputEl?.removeEventListener("blur", this.closeOnBlur);
		this.closeSuggestion(); this.suggestion = null;
		this.sendBtn?.removeEventListener("click", this.handleClick);
		this.inputEl = null;
		this.sendBtn = null;
	}

	private closeOnBlur = (): void => { this.closeSuggestion(); };

	getDraft(): MessageDraft {
		return this.inputEl ? this.readParts(this.inputEl) : this.draft;
	}

	private readParts(container: Node): MessageDraft {
		const parts: DraftPart[] = [];
		const append = (text: string) => {
			if (typeof parts[parts.length - 1] === "string") parts[parts.length - 1] += text;
			else if (text) parts.push(text);
		};
		const visit = (node: Node) => {
			const id = (node as HTMLElement).getAttribute?.("data-ai-mention");
			const file = id ? this.bindings.get(id) : undefined;
			if (file) { parts.push({ file }); return; }
			if (node.nodeType === 3) { append(node.textContent ?? ""); return; }
			const tag = (node as HTMLElement).tagName;
			if (tag === "BR") { append("\n"); return; }
			if ((tag === "DIV" || tag === "P") && parts.length) append("\n");
			const children = Array.from(node.childNodes);
			// Browsers put a sole BR into an empty paragraph as a caret placeholder.
			if ((tag === "DIV" || tag === "P") && children.length === 1 && (children[0] as HTMLElement).tagName === "BR") return;
			for (const child of children) visit(child);
		};
		for (const child of Array.from(container.childNodes)) visit(child);
		return { parts };
	}

	private setDraft(draft: MessageDraft): void {
		this.draft = draft;
		if (!this.inputEl) return;
		this.inputEl.empty();
		for (const part of draft.parts) {
			renderDraft(this.inputEl, { parts: [part] });
			if (typeof part !== "string") {
				// Browser undo may restore a cloned node; its id retains the selected file.
				const id = String(++this.mentionSequence);
				(this.inputEl.lastChild as HTMLElement).setAttribute("data-ai-mention", id);
				this.bindings.set(id, part.file);
			}
		}
	}

	clear(): void { this.bindings.clear(); this.setDraft({ parts: [] }); this.closeSuggestion(); }

	restoreIfEmpty(draft: MessageDraft): void {
		if (this.inputEl && !draftText(this.getDraft())) this.setDraft(draft);
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
		this.inputEl?.setAttribute("data-placeholder", this.t("input-placeholder"));
		this.inputEl?.setAttribute("aria-label", this.t("input-placeholder"));
		this.suggestion?.setAttribute("aria-label", this.t("mention-current"));
		this.setAction(this.thinking, this.searchEnabled);
	}
}
