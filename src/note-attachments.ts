import { MarkdownView, type App, type TFile } from "obsidian";

export interface NoteSnapshot { title: string; path: string; markdown: string; }

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
