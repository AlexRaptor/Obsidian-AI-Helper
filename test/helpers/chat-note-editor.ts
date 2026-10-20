import { EditorState, type Extension } from "@codemirror/state";
import { history, undo, redo } from "@codemirror/commands";
import { MarkdownView, type TFile, type WorkspaceLeaf, type EditorPosition } from "obsidian";
import { vi } from "vitest";
import { noteEditHistory } from "../../src/note-edit-history";
import type { setup } from "./chat-note-actions";

type Setup = Awaited<ReturnType<typeof setup>>;
export function editor(s: Setup, file: TFile, initial = s.texts.get(file.path)!, extensions: Extension[] = []) {
	// Host adapter: run the plugin's registered extension in a real CodeMirror history.
	// Obsidian's view integration still requires the prepared manual check.
	let state = EditorState.create({ doc: initial, extensions: [history(), noteEditHistory, EditorState.lineSeparator.of(initial.includes("\r\n") ? "\r\n" : "\n"), ...extensions] });
	const dispatch = (transaction: import("@codemirror/state").Transaction) => { state = transaction.state; s.texts.set(file.path, state.sliceDoc()); };
	let selection = { anchor: { line: 0, ch: 0 }, head: { line: 0, ch: 0 } };
	const offset = (position: EditorPosition) => state.doc.line(position.line + 1).from + position.ch;
	const transaction = vi.fn((tx: any, origin: string) => dispatch(state.update({
		changes: tx.changes.map((change: any) => ({ from: state.doc.line(change.from.line + 1).from + change.from.ch,
			to: state.doc.line(change.to.line + 1).from + change.to.ch, insert: change.text })), userEvent: origin,
	})));
	const view = Object.assign(new MarkdownView({} as WorkspaceLeaf), { file, getMode: () => "source", getViewData: () => state.sliceDoc(),
		editor: { listSelections: () => [selection], getRange: (from: EditorPosition, to: EditorPosition) => state.sliceDoc(offset(from), offset(to)), getValue: () => state.sliceDoc(), lastLine: () => state.doc.lines - 1, getLine: (line: number) => state.doc.line(line + 1).text, transaction,
			undo: () => undo({ state, dispatch }), redo: () => redo({ state, dispatch }) } });
	return { view, transaction, select(from: EditorPosition, to: EditorPosition) { selection = { anchor: from, head: to }; }, get text() { return state.sliceDoc(); }, change(value: string) { dispatch(state.update({ changes: { from: 0, to: state.doc.length, insert: value }, userEvent: "input.type" })); } };
}
