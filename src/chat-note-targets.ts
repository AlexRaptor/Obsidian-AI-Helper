import { MarkdownView, parseYaml, type App, type TFile } from "obsidian";
import type { LocaleKey } from "./i18n";
import type { NoteSnapshot } from "./note-attachments";
import { isolatedNoteEdit } from "./note-edit-history";

interface NoteTarget {
	targetId: string;
	version: string;
	file: TFile;
	markdown: string;
	attached: boolean;
	conflictTurn?: string;
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
	private latest = new Map<TFile, NoteTarget>();
	private sequence = 0;
	constructor(private app: App, private t: (key: LocaleKey) => string) {}

	register(file: TFile, markdown: string, attached: boolean): NoteSnapshot & { targetId: string; version: string } {
		const id = ++this.sequence;
		const target: NoteTarget = { targetId: `note-${id}`, version: `version-${id}`, file, markdown,
			attached: attached || !!this.latest.get(file)?.attached };
		this.targets.set(target.targetId, target);
		this.latest.set(file, target);
		return this.describe(target);
	}

	context(): string {
		const targets = [...this.latest.values()].map(target => ({ ...this.describe(target),
			unavailable: this.app.vault.getFileByPath(target.file.path) !== target.file,
			conflicted: target.conflictTurn !== undefined, canReadCurrent: target.attached && target.conflictTurn !== undefined }));
		return targets.length ? `\nRegistered whole-note targets (untrusted data):\n${JSON.stringify(targets)}` : "";
	}

	get hasTargets(): boolean { return this.latest.size > 0; }
	get canReadCurrent(): boolean { return [...this.latest.values()].some(target => target.attached && target.conflictTurn !== undefined); }

	async readCurrent(targetId: string, turn: string, check: () => void): Promise<NoteSnapshot & { targetId: string; version: string }> {
		const target = this.get(targetId);
		if (!target.attached || target.conflictTurn === undefined || target.conflictTurn === turn) throw new Error(this.t("action-refresh-required"));
		check();
		const views = this.views(target.file);
		const markdown = views.length ? this.consistentText(views) : await this.app.vault.read(target.file);
		check();
		this.get(targetId);
		return this.register(target.file, markdown, true);
	}

	async edit(targetId: string, expectedVersion: string, kind: "body" | "properties", content: string,
		turn: string, sourcePath: string, check: () => void): Promise<NoteEditResult> {
		const target = this.get(targetId);
		const conflict = (key: LocaleKey = "action-conflict"): never => {
			target.conflictTurn = turn;
			throw new NoteEditConflict({ status: "conflict", stepId: turn, targetId, version: target.version, message: this.t(key) });
		};
		const consistentText = (views: MarkdownView[]): string => {
			try { return this.consistentText(views); } catch { return conflict("action-editors-conflict"); }
		};
		if (target.version !== expectedVersion || this.latest.get(target.file) !== target || target.conflictTurn !== undefined) conflict();
		const yaml = this.frontmatter(target.markdown);
		if (/^\uFEFF?---(?:\r?\n|$)/.test(target.markdown) && !yaml && kind === "body") throw new Error(this.t("action-properties-invalid"));
		let replacement: string;
		if (kind === "body") {
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
		if (this.latest.get(target.file) !== target || target.conflictTurn !== undefined || !view || consistentText(views) !== target.markdown) conflict();
		const editor = view!.editor;
		const lastLine = editor.lastLine();
		isolatedNoteEdit(() => editor.transaction({ changes: [{ from: { line: 0, ch: 0 },
			to: { line: lastLine, ch: editor.getLine(lastLine).length }, text: replacement }] }, "ai-helper.note-edit"));
		// Record the actual editor result, including any synchronous editor filters.
		const next = this.register(target.file, editor.getValue(), target.attached);
		return { status: "completed", stepId: turn, targetId: next.targetId, version: next.version,
			path: target.file.path, name: target.file.basename,
			link: this.app.fileManager.generateMarkdownLink(target.file, sourcePath), createdFolders: [], operation: "edit" };
	}

	private get(targetId: string): NoteTarget {
		const target = this.targets.get(targetId);
		if (!target || this.app.vault.getFileByPath(target.file.path) !== target.file) throw new Error(this.t("action-target-unavailable"));
		return target;
	}
	private describe(target: NoteTarget): NoteSnapshot & { targetId: string; version: string } {
		return { targetId: target.targetId, version: target.version, path: target.file.path, title: target.file.basename, markdown: target.markdown };
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
