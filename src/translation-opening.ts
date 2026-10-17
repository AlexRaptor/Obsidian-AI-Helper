import type { App, WorkspaceLeaf } from "obsidian";
import type { LocaleKey } from "./i18n";

/** Retains only workspace placement and saved paths for retries, never translation text. */
export class TranslationOpening {
	private resultLeaf?: WorkspaceLeaf;
	constructor(private app: App, private originalPath: string, private resultPath: string, private sourceLeaf: WorkspaceLeaf | null, private sideBySide: boolean) {}
	private attached(target: WorkspaceLeaf | null | undefined): target is WorkspaceLeaf {
		let found = false;
		this.app.workspace.iterateAllLeaves(leaf => { if (leaf === target) found = true; });
		return found;
	}
	async open(signal: AbortSignal): Promise<LocaleKey | undefined> {
		if (signal.aborted) return;
		const { workspace, vault } = this.app;
		const result = vault.getFileByPath(this.resultPath);
		if (!result || result.extension !== "md") throw new Error("Saved translation is unavailable");
		const options = { state: { mode: "preview" }, active: true };
		let detail: LocaleKey | undefined;
		let leaf: WorkspaceLeaf;
		if (this.sideBySide) {
			if (!this.attached(this.sourceLeaf)) {
				this.sourceLeaf = workspace.getLeaf(true);
				this.resultLeaf = undefined;
			}
			leaf = this.sourceLeaf;
			const original = vault.getFileByPath(this.originalPath);
			if (original?.extension === "md") {
				await leaf.openFile(original, { ...options, active: false });
				if (signal.aborted) return;
				if (!this.attached(this.resultLeaf)) this.resultLeaf = workspace.createLeafBySplit(leaf, "vertical", false);
				leaf = this.resultLeaf;
			} else detail = "translation-original-missing";
		} else leaf = workspace.getLeaf(false);
		if (signal.aborted) return;
		await leaf.openFile(result, options);
		if (!signal.aborted) workspace.setActiveLeaf(leaf, { focus: true });
		return detail;
	}
}
