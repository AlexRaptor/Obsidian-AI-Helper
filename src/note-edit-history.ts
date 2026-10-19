import { EditorState } from "@codemirror/state";
import { isolateHistory } from "@codemirror/commands";

let applyingNoteEdit = false;

/** Annotate only the synchronous public Editor.transaction, without accessing private cm internals. */
export const noteEditHistory = EditorState.transactionExtender.of(transaction =>
	applyingNoteEdit && transaction.docChanged ? { annotations: isolateHistory.of("full") } : null);

export function isolatedNoteEdit(apply: () => void): void {
	applyingNoteEdit = true;
	try { apply(); } finally { applyingNoteEdit = false; }
}
