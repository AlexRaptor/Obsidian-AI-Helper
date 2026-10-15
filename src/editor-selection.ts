import { layer, RectangleMarker } from "@codemirror/view";

/** Keep the native primary selection visible while focus is in the chat. */
export const chatEditorSelection = layer({
	above: false,
	class: "ai-helper-editor-selection-layer",
	markers(view) {
		const selection = view.state.selection.main;
		return selection.empty ? [] : RectangleMarker.forRange(view, "ai-helper-editor-selection", selection);
	},
	update(update) {
		return update.docChanged || update.selectionSet || update.viewportChanged;
	},
});
