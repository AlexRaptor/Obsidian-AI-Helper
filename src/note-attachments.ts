import { MarkdownView, type App, type EditorPosition, type TFile } from "obsidian";

export interface NoteSnapshot { title: string; path: string; markdown: string; targetId?: string; version?: string; }
export interface SelectedFragmentSnapshot extends NoteSnapshot {
	range: { from: EditorPosition; to: EditorPosition };
}

const fragmentBases = new WeakMap<SelectedFragmentSnapshot, { file: TFile; markdown: string }>();

/** The complete validation base stays local and is never a snapshot property. */
export function fragmentWriteBasis(snapshot: SelectedFragmentSnapshot): { file: TFile; markdown: string } | undefined {
	return fragmentBases.get(snapshot);
}

export function fragmentLabel(snapshot: SelectedFragmentSnapshot): string {
	const { from, to } = snapshot.range;
	const first = from.line + 1;
	const last = to.line + (to.ch === 0 ? 0 : 1);
	return `${snapshot.title}[${first}${last > first ? `-${last}` : ""}]`;
}

export type SelectedFragmentResult = SelectedFragmentSnapshot | "multiple-selections" | null;

/** Read only the last used, still-open Markdown editor; never search other tabs. */
export function readSelectedFragment(app: App, remembered?: MarkdownView | null): SelectedFragmentResult {
	const view = app.workspace.getActiveViewOfType(MarkdownView) ?? remembered;
	if (!view || !app.workspace.getLeavesOfType("markdown").some(leaf => leaf.view === view)
		|| view.getMode() !== "source" || view.file?.extension !== "md"
		|| app.vault.getFileByPath(view.file.path) !== view.file) return null;
	const selections = view.editor.listSelections?.();
	if (selections && selections.length > 1) return "multiple-selections";
	if (selections?.length !== 1) return null;
	const { anchor, head } = selections[0];
	const ordered = anchor.line < head.line || (anchor.line === head.line && anchor.ch <= head.ch);
	const from = ordered ? anchor : head;
	const to = ordered ? head : anchor;
	const markdown = view.editor.getRange(from, to);
	if (!markdown.trim()) return null;
	const snapshot: SelectedFragmentSnapshot = { title: view.file.basename, path: view.file.path, markdown, range: { from: { ...from }, to: { ...to } } };
	fragmentBases.set(snapshot, { file: view.file, markdown: view.editor.getValue() });
	return snapshot;
}

/** Read the bound file, preferring its live editor over the saved vault text. */
export async function readNoteSnapshot(app: App, file: TFile): Promise<NoteSnapshot> {
	if (app.vault.getFileByPath(file.path) !== file) throw new Error("unavailable");
	const active = app.workspace.getActiveViewOfType(MarkdownView);
	const views = [active, ...app.workspace.getLeavesOfType("markdown").map(leaf => leaf.view)];
	const boundViews = views.filter((view): view is MarkdownView => view instanceof MarkdownView && view.file === file);
	const view = boundViews.find(view => view.getMode() === "source") ?? boundViews[0];
	const markdown = view ? (view.getMode() === "source" ? view.editor.getValue() : view.getViewData()) : await app.vault.read(file);
	return { title: file.basename, path: file.path, markdown };
}

export function snapshotMessage(text: string, snapshots?: NoteSnapshot[]): string {
	return snapshots?.length ? `${text}\n\nNote attachments (context data):\n${JSON.stringify(snapshots)}` : text;
}
