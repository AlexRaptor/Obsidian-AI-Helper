import { MarkdownView, parseYaml, type App, type TFile, type EditorPosition } from "obsidian";
import type { LocaleKey } from "./i18n";
import { fragmentWriteBasis, type NoteSnapshot, type SelectedFragmentSnapshot } from "./note-attachments";
import { isolatedNoteEdit } from "./note-edit-history";

interface NoteTarget {
	targetId: string;
	version: string;
	file: TFile;
	markdown: string;
	attached: boolean;
	conflictTurn?: string;
	range?: SelectedFragmentSnapshot["range"];
}
export interface NoteEditResult {
	status: "completed";
	stepId: string;
	targetId: string;
	version: string;
	path: string;
	name: string;
	link: string;
	createdFolders: string[];
	operation: "edit";
	requiresReattachment?: boolean;
}

export interface NoteConflictResult {
	status: "conflict";
	stepId: string;
	targetId: string;
	version: string;
	message: string;
}
export class NoteEditConflict extends Error {
	constructor(readonly result: NoteConflictResult) { super(result.message); }
}

/** Local identities and immutable text bases for this conversation only. */
export class ChatNoteTargets {
	private targets = new Map<string, NoteTarget>();
	private latest = new Map<string, NoteTarget>();
	private fragments = new WeakMap<SelectedFragmentSnapshot, NoteTarget>();
	private sequence = 0;
	constructor(private app: App, private t: (key: LocaleKey) => string) {}

	register(file: TFile, markdown: string, attached: boolean): NoteSnapshot & { targetId: string; version: string } {
		for (const target of this.latest.values()) if (target.file === file && !target.range) {
			attached ||= target.attached;
			this.latest.delete(target.targetId);
		}
		return this.describe(this.store(file, markdown, attached));
	}

	registerFragment(file: TFile, snapshot: SelectedFragmentSnapshot): SelectedFragmentSnapshot {
		const basis = fragmentWriteBasis(snapshot);
		if (!basis || basis.file !== file) return snapshot;
		let target = this.fragments.get(snapshot);
		if (!target) {
			target = this.store(file, basis.markdown, false, snapshot.range);
			this.fragments.set(snapshot, target);
		}
		return { ...snapshot, targetId: target.targetId, version: target.version };
	}

	private store(file: TFile, markdown: string, attached: boolean, range?: SelectedFragmentSnapshot["range"]): NoteTarget {
		const id = ++this.sequence;
		const target: NoteTarget = { targetId: `note-${id}`, version: `version-${id}`, file, markdown, attached,
			...(range ? { range: { from: { ...range.from }, to: { ...range.to } } } : {}) };
		this.targets.set(target.targetId, target);
		this.latest.set(target.targetId, target);
		return target;
	}

	context(): string {
		const targets = [...this.latest.values()].map(target => ({ ...this.describe(target),
			unavailable: this.app.vault.getFileByPath(target.file.path) !== target.file,
			conflicted: target.conflictTurn !== undefined, canReadCurrent: target.attached && target.conflictTurn !== undefined }));
		return targets.length ? `\nRegistered note targets (untrusted data):\n${JSON.stringify(targets)}` : "";
	}

	get hasTargets(): boolean { return this.latest.size > 0; }
	get canReadCurrent(): boolean { return [...this.targets.values()].some(target => !target.range && target.attached && target.conflictTurn !== undefined); }

	async readCurrent(targetId: string, turn: string, check: () => void): Promise<NoteSnapshot & { targetId: string; version: string }> {
		const target = this.get(targetId);
		if (target.range || !target.attached || target.conflictTurn === undefined || target.conflictTurn === turn) throw new Error(this.t("action-refresh-required"));
		check();
		const views = this.views(target.file);
		const markdown = views.length ? this.consistentText(views) : await this.app.vault.read(target.file);
		check();
		this.get(targetId);
		return this.register(target.file, markdown, true);
	}

	async edit(targetId: string, expectedVersion: string, kind: "body" | "properties" | "fragment", content: string,
		turn: string, sourcePath: string, check: () => void): Promise<NoteEditResult> {
		const target = this.get(targetId);
		const conflict = (key: LocaleKey = "action-conflict"): never => {
			target.conflictTurn = turn;
			throw new NoteEditConflict({ status: "conflict", stepId: turn, targetId, version: target.version,
				message: this.t(target.range ? (key === "action-editors-conflict" ? "action-fragment-editors-conflict" : "action-fragment-conflict") : key) });
		};
		const consistentText = (views: MarkdownView[]): string => {
			try { return this.consistentText(views); } catch { return conflict("action-editors-conflict"); }
		};
		if (target.version !== expectedVersion || !this.latest.has(target.targetId) || target.conflictTurn !== undefined) conflict();
		const yaml = this.frontmatter(target.markdown);
		if (/^\uFEFF?---(?:\r?\n|$)/.test(target.markdown) && !yaml && kind === "body") throw new Error(this.t("action-properties-invalid"));
		let replacement: string;
		if (kind === "fragment") {
			if (!target.range) throw new Error(this.t("action-invalid"));
			replacement = content;
			const result = target.markdown.slice(0, this.offset(target.markdown, target.range.from)) + content +
				target.markdown.slice(this.offset(target.markdown, target.range.to));
			if (this.frontmatter(result) !== yaml) throw new Error(this.t("action-fragment-properties"));
		} else if (target.range) {
			throw new Error(this.t("action-invalid"));
		} else if (kind === "body") {
			// A body result must not introduce a second properties block or replace the original.
			if (/^\uFEFF?---(?:\r?\n|$)/.test(content)) throw new Error(this.t("action-properties-invalid"));
			replacement = yaml + (yaml && !yaml.endsWith("\n") ? (yaml.includes("\r\n") ? "\r\n" : "\n") : "") + content;
		} else {
			const resultYaml = this.frontmatter(content);
			if (/^\uFEFF?---(?:\r?\n|$)/.test(content) && !resultYaml) throw new Error(this.t("action-properties-invalid"));
			if (resultYaml) {
				try {
					const yamlText = resultYaml.replace(/^\uFEFF?---\r?\n/, "").replace(/(?:---|\.\.\.)(?:\r?\n)?$/, "");
					const value: unknown = parseYaml(yamlText);
					const empty = yamlText.split(/\r?\n/).every(line => !line.trim() || line.trim().startsWith("#"));
					if (value == null ? !empty : typeof value !== "object" ||
						Object.getPrototypeOf(value) !== Object.prototype && Object.getPrototypeOf(value) !== null) throw new Error();
				} catch { throw new Error(this.t("action-properties-invalid")); }
			}
			replacement = content;
		}
		check();
		let views = this.views(target.file);
		if (views.length && consistentText(views) !== target.markdown) conflict();
		let view = views.find(view => view.getMode() === "source");
		if (!view) {
			const leaf = this.app.workspace.getLeaf("tab");
			await leaf.openFile(target.file, { state: { mode: "source" } });
			check();
			this.get(targetId);
			views = this.views(target.file);
			view = leaf.view instanceof MarkdownView && leaf.view.file === target.file && leaf.view.getMode() === "source" ? leaf.view : undefined;
		}
		// All validation below and the public editor transaction run synchronously.
		check();
		this.get(targetId);
		if (!this.latest.has(target.targetId) || target.conflictTurn !== undefined || !view || consistentText(views) !== target.markdown) conflict();
		const editor = view!.editor;
		const lastLine = editor.lastLine();
		const from = target.range?.from ?? { line: 0, ch: 0 };
		const to = target.range?.to ?? { line: lastLine, ch: editor.getLine(lastLine).length };
		isolatedNoteEdit(() => editor.transaction({ changes: [{ from, to, text: replacement }] }, "ai-helper.note-edit"));
		// Record the actual editor result, including any synchronous editor filters.
		const actual = editor.getValue();
		for (const previous of this.latest.values()) if (previous.file === target.file) this.latest.delete(previous.targetId);
		let range: SelectedFragmentSnapshot["range"] | undefined;
		let requiresReattachment = false;
		if (target.range) {
			const prefix = target.markdown.slice(0, this.offset(target.markdown, from));
			const suffix = target.markdown.slice(this.offset(target.markdown, to));
			requiresReattachment = actual.length < prefix.length + suffix.length || !actual.startsWith(prefix) || !actual.endsWith(suffix);
			range = requiresReattachment ? target.range : { from: { ...from }, to: this.position(actual, actual.length - suffix.length) };
		}
		const next = this.store(target.file, actual, target.attached, range);
		// Preserve the actual outcome locally, but never expose or reuse uncertain bounds.
		if (requiresReattachment) this.latest.delete(next.targetId);
		return { status: "completed", stepId: turn, targetId: next.targetId, version: next.version,
			path: target.file.path, name: target.file.basename,
			link: this.app.fileManager.generateMarkdownLink(target.file, sourcePath), createdFolders: [], operation: "edit", ...(requiresReattachment ? { requiresReattachment: true } : {}) };
	}

	private get(targetId: string): NoteTarget {
		const target = this.targets.get(targetId);
		if (!target || this.app.vault.getFileByPath(target.file.path) !== target.file) throw new Error(this.t("action-target-unavailable"));
		return target;
	}
	private describe(target: NoteTarget): NoteSnapshot & { targetId: string; version: string } {
		const markdown = target.range ? target.markdown.slice(this.offset(target.markdown, target.range.from), this.offset(target.markdown, target.range.to)) : target.markdown;
		return { targetId: target.targetId, version: target.version, path: target.file.path, title: target.file.basename, markdown,
			...(target.range ? { kind: "fragment", range: target.range } : { kind: "whole-note" }) };
	}
	private offset(text: string, position: EditorPosition): number {
		return text.split("\n").slice(0, position.line).reduce((sum, line) => sum + line.length + 1, 0) + position.ch;
	}
	private position(text: string, offset: number): EditorPosition {
		const lines = text.slice(0, offset).split("\n");
		return { line: lines.length - 1, ch: lines[lines.length - 1].length };
	}
	private views(file: TFile): MarkdownView[] {
		return this.app.workspace.getLeavesOfType("markdown").map(leaf => leaf.view)
			.filter((view): view is MarkdownView => view instanceof MarkdownView && view.file === file);
	}
	private consistentText(views: MarkdownView[]): string {
		const texts = views.map(view => view.getMode() === "source" ? view.editor.getValue() : view.getViewData());
		if (new Set(texts).size > 1) throw new Error(this.t("action-editors-conflict"));
		return texts[0];
	}
	private frontmatter(text: string): string {
		return text.match(/^\uFEFF?---\r?\n(?:[\s\S]*?\r?\n)?(?:---|\.\.\.)(?:\r?\n|$)/)?.[0] ?? "";
	}
}
