import { setIcon, setTooltip, type TFile } from "obsidian";
import type { LocaleKey } from "./i18n";
import { fragmentLabel, type SelectedFragmentSnapshot, type SelectedFragmentResult } from "./note-attachments";

let inputSequence = 0;

/** Positions of the most compact ordered match, or null when absent. */
function matchToken(path: string, token: string): number[] | null {
	const letters = Array.from(token);
	const exact = path.indexOf(token);
	if (exact >= 0) {
		const start = Array.from(path.slice(0, exact)).length;
		return letters.map((_, index) => start + index);
	}
	const characters = Array.from(path);
	const starts = new Array<number>(letters.length).fill(-1);
	let best = Infinity;
	let bestStart = -1;
	for (const [position, letter] of characters.entries()) {
		// Walk backwards so a path character cannot satisfy two token characters.
		for (let index = letters.length - 1; index >= 0; index--) {
			if (letter !== letters[index]) continue;
			if (index === 0) starts[index] = position;
			else if (starts[index - 1] >= 0) starts[index] = starts[index - 1];
			else continue;
			if (index === letters.length - 1 && position - starts[index] < best) {
				best = position - starts[index];
				bestStart = starts[index];
			}
		}
	}
	if (bestStart < 0) return null;
	const positions: number[] = [];
	for (let position = bestStart; positions.length < letters.length; position++) {
		if (characters[position] === letters[positions.length]) positions.push(position);
	}
	return positions;
}

function renderMatchedText(container: HTMLElement, text: string, positions: Set<number>, offset = 0): void {
	const characters = Array.from(text);
	let start = 0;
	while (start < characters.length) {
		const matched = positions.has(start + offset);
		let end = start + 1;
		while (end < characters.length && positions.has(end + offset) === matched) end++;
		container.createSpan({ cls: matched ? "ai-helper-mention-match" : undefined, text: characters.slice(start, end).join("") });
		start = end;
	}
}

type Mention = { file: TFile; fragment?: SelectedFragmentSnapshot };
export type DraftPart = string | Mention;
function mentionLabel(part: { file: Pick<TFile, "basename">; fragment?: SelectedFragmentSnapshot }): string {
	return part.fragment ? fragmentLabel(part.fragment) : `@${part.file.basename}`;
}
export interface MessageDraft { parts: DraftPart[]; }

export function draftText(draft: MessageDraft): string {
	return draft.parts.map(part => typeof part === "string" ? part : mentionLabel(part)).join("");
}
export type DisplayDraft = { parts: (string | { file: Pick<TFile, "basename" | "path">; fragment?: SelectedFragmentSnapshot })[] };

export function renderDraft(container: HTMLElement, draft: DisplayDraft): void {
	for (const part of draft.parts) {
		if (typeof part === "string") container.createSpan({ text: part });
		else {
			const path = part.fragment?.path ?? part.file.path;
			const chip = container.createSpan({ cls: "ai-helper-mention", text: mentionLabel(part), attr: { contenteditable: "false", title: path, "aria-label": `${mentionLabel(part)}: ${path}` } });
			setTooltip(chip, path);
		}
	}
}

/** Owns the message field and its draft for one chat view's lifetime. */
export class MessageInput {
	private inputEl: HTMLElement | null = null;
	private readonly suggestionId = `ai-helper-mentions-${++inputSequence}`;
	private sendBtn: HTMLButtonElement | null = null;
	private draft: MessageDraft = { parts: [] };
	private bindings = new Map<string, Mention>();
	private mentionSequence = 0;
	private suggestion: HTMLElement | null = null;
	private candidates: TFile[] = [];
	private fragment: SelectedFragmentSnapshot | null = null;
	private fragmentMode = false;
	private multipleSelections = false;
	private matchedPositions = new Map<TFile, Set<number>>();
	private selectedIndex = 0;
	private suggestionOpen = false;
	private mentionStart = 0;
	private mentionEnd = 0;
	private thinking = false;
	private searchEnabled = false;

	constructor(
		private t: (key: LocaleKey) => string,
		private onSend: () => void,
		private onStop: () => void,
		private currentNote: () => TFile | null = () => null,
		private markdownFiles: () => TFile[] = () => [],
		private selectedFragment: () => SelectedFragmentResult = () => null,
	) {}

	private handleClick = (): void => {
		if (this.thinking) this.onStop();
		else this.onSend();
	};

	private closeSuggestion(): void {
		this.suggestion?.empty();
		if (this.suggestion) this.suggestion.style.display = "none";
		this.fragment = null;
		this.candidates = [];
		this.matchedPositions.clear();
		this.selectedIndex = 0;
		this.suggestionOpen = false;
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
		const editingFilter = this.suggestionOpen && (input.inputType === "deleteContentBackward" || input.inputType === "deleteContentForward");
		this.closeSuggestion();
		if ((input.inputType !== "insertText" && !editingFilter) || input.isComposing) return;
		this.updateSuggestion();
	};

	private updateSuggestion(): void {
		this.closeSuggestion();
		const draft = this.getDraft();
		const text = draftText(draft).slice(0, this.caretOffset());
		const match = /(?:^|\s)(@@|@)([^\n@]*)$/.exec(text);
		if (!match) return;
		const start = text.length - match[2].length - match[1].length;
		// A confirmed mention is an atomic attachment, never a new filter trigger.
		let offset = 0;
		for (const part of draft.parts) {
			const length = typeof part === "string" ? part.length : mentionLabel(part).length;
			if (typeof part !== "string" && offset < text.length && offset + length > start) return;
			offset += length;
		}
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
		this.fragmentMode = match[1] === "@@";
		if (this.fragmentMode) {
			const selection = match[2] ? null : this.selectedFragment();
			this.multipleSelections = selection === "multiple-selections";
			this.fragment = selection === "multiple-selections" ? null : selection;
			this.mentionStart = start; this.mentionEnd = text.length;
			this.suggestionOpen = true;
			this.renderSuggestion();
			return;
		}
		const current = this.currentNote();
		this.candidates = this.markdownFiles().slice().sort((a, b) => a.path.localeCompare(b.path));
		const tokens = match[2].toLocaleLowerCase().trim().split(/\s+/).filter(Boolean);
		if (current?.extension === "md" && this.candidates.includes(current) && !tokens.length) {
			this.candidates = [current, ...this.candidates.filter(file => file.path !== current.path)];
		}
		if (tokens.length) {
			this.candidates = this.candidates.map(file => {
				const path = file.path.toLocaleLowerCase();
				const matches = tokens.map(token => matchToken(path, token));
				const gaps = matches.map(positions => positions ? positions[positions.length - 1] - positions[0] + 1 - positions.length : Infinity);
				// Case conversion can expand a character (e.g. İ); highlight the original positions.
				const originalPositions = Array.from(file.path).flatMap((letter, index) => Array.from(letter.toLocaleLowerCase(), () => index));
				this.matchedPositions.set(file, new Set(matches.flatMap(positions => positions?.map(position => originalPositions[position]) ?? [])));
				return { file, fuzzyTokens: gaps.filter(gap => gap > 0).length, gaps: gaps.reduce((sum, gap) => sum + gap, 0) };
			}).filter(match => Number.isFinite(match.gaps))
				.sort((a, b) => a.fuzzyTokens - b.fuzzyTokens || a.gaps - b.gaps || a.file.path.localeCompare(b.file.path))
				.map(match => match.file);
		}
		this.mentionStart = start; this.mentionEnd = text.length;
		this.suggestionOpen = true;
		this.renderSuggestion();
	}

	private renderSuggestion(): void {
		if (!this.suggestion) return;
		this.suggestion.empty();
		this.suggestion.style.display = "";
		this.inputEl?.setAttribute("aria-expanded", "true");
		this.inputEl?.removeAttribute("aria-activedescendant");
		if (this.fragmentMode) {
			if (!this.fragment) {
				this.suggestion.createDiv({ cls: "suggestion-item", text: this.t(this.multipleSelections ? "mention-multiple-selections" : "mention-no-selection"), attr: { role: "status" } });
				return;
			}
			const option = this.suggestion.createEl("button", { cls: "suggestion-item is-selected", text: `${fragmentLabel(this.fragment)} — ${this.fragment.markdown.slice(0, 120)}`, attr: { type: "button", role: "option", "aria-selected": "true", id: `${this.suggestionId}-fragment` } });
			this.inputEl?.setAttribute("aria-activedescendant", `${this.suggestionId}-fragment`);
			option.addEventListener("mousedown", event => event.preventDefault());
			option.addEventListener("click", () => this.confirmMention());
			return;
		}
		if (!this.candidates.length) {
			this.suggestion.createDiv({ cls: "suggestion-item", text: this.t("mention-no-results"), attr: { role: "status" } });
			return;
		}
		this.candidates.forEach((file, index) => {
			const selected = index === this.selectedIndex;
			const id = `${this.suggestionId}-${index}`;
			const option = this.suggestion!.createEl("button", { cls: `suggestion-item${selected ? " is-selected" : ""}`, attr: { type: "button", id, role: "option", "aria-selected": String(selected) } });
			const positions = this.matchedPositions.get(file) ?? new Set<number>();
			const name = option.createSpan({ cls: "ai-helper-mention-suggest-name" });
			renderMatchedText(name, file.basename, positions, Array.from(file.path.slice(0, file.path.lastIndexOf("/") + 1)).length);
			const path = option.createSpan();
			path.createSpan({ text: " — " });
			renderMatchedText(path, file.path, positions);
			option.addEventListener("mousedown", event => event.preventDefault());
			option.addEventListener("click", () => { this.selectedIndex = index; this.confirmMention(); });
			if (selected) this.inputEl?.setAttribute("aria-activedescendant", id);
		});
		(this.suggestion.children[this.selectedIndex] as HTMLElement)?.scrollIntoView?.({ block: "nearest" });
	}

	private confirmMention(): void {
		if (this.fragmentMode && !this.fragment) return;
		const fragment = this.fragmentMode ? this.fragment : null;
		// Confirm exactly the proposal the user saw; changed selection requires a new @@.
		if (fragment) {
			const current = this.selectedFragment();
			if (!current || current === "multiple-selections" || current.path !== fragment.path
				|| current.title !== fragment.title || current.markdown !== fragment.markdown
				|| current.range.from.line !== fragment.range.from.line || current.range.from.ch !== fragment.range.from.ch
				|| current.range.to.line !== fragment.range.to.line || current.range.to.ch !== fragment.range.to.ch) {
				this.closeSuggestion();
				return;
			}
		}
		const file = this.fragmentMode ? this.markdownFiles().find(file => file.path === fragment?.path) : this.candidates[this.selectedIndex];
		if (!file || (this.fragmentMode && !fragment)) return;
		const draft = this.getDraft();
		const parts: DraftPart[] = [];
		let offset = 0;
		let selectedPart = 0;
		for (const part of draft.parts) {
			const length = typeof part === "string" ? part.length : mentionLabel(part).length;
			if (typeof part === "string" && offset <= this.mentionStart && offset + length >= this.mentionEnd) {
				selectedPart = parts.length + 1;
				parts.push(part.slice(0, this.mentionStart - offset), { file, ...(fragment ? { fragment } : {}) }, part.slice(this.mentionEnd - offset));
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
		if (this.suggestionOpen) {
			if (event.key === "Escape") { event.preventDefault(); this.closeSuggestion(); return; }
			if (event.key === "ArrowDown" || event.key === "ArrowUp") {
				event.preventDefault();
				if (this.candidates.length) {
					this.selectedIndex = (this.selectedIndex + (event.key === "ArrowDown" ? 1 : -1) + this.candidates.length) % this.candidates.length;
					this.renderSuggestion();
				}
				return;
			}
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
		this.suggestion = row.createDiv({ cls: "ai-helper-mention-suggest suggestion-container", attr: { id: this.suggestionId, role: "listbox", "aria-label": this.t("mention-notes") } });
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

	/** Refresh chips in place so vault changes preserve the editor selection. */
	refreshFiles(): void {
		const visit = (node: Node) => {
			if (node.nodeType !== 1) return;
			const chip = node as HTMLElement;
			const id = chip.getAttribute?.("data-ai-mention");
			const mention = id ? this.bindings.get(id) : undefined;
			const file = mention?.file;
			if (file && !mention?.fragment) {
				chip.setText(`@${file.basename}`);
				chip.setAttribute("title", file.path);
				chip.setAttribute("aria-label", `${file.basename}: ${file.path}`);
				setTooltip(chip, file.path);
			} else for (const child of Array.from(node.childNodes)) visit(child);
		};
		if (this.inputEl) visit(this.inputEl);
		if (this.suggestionOpen && this.fragmentMode) {
			this.closeSuggestion();
		} else if (this.suggestionOpen) {
			const selected = this.candidates[this.selectedIndex];
			this.updateSuggestion();
			const index = this.candidates.indexOf(selected);
			if (index >= 0) { this.selectedIndex = index; this.renderSuggestion(); }
		}
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
			const mention = id ? this.bindings.get(id) : undefined;
			if (mention) { parts.push(mention); return; }
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
				this.bindings.set(id, part);
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
		this.suggestion?.setAttribute("aria-label", this.t("mention-notes"));
		if (this.suggestionOpen) this.renderSuggestion();
		this.setAction(this.thinking, this.searchEnabled);
	}
}
