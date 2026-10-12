import { TFile, type App, type TFolder } from "obsidian";
import type { LocaleKey } from "./i18n";

export const DEFAULT_FOLDER_DESCRIPTION_NAME = "_folder.md";

export function isValidFolderDescriptionName(value: unknown): value is string {
	return typeof value === "string" && value === value.trim() &&
		/^[^\\/:*?"<>|\x00-\x1f]+\.md$/.test(value) &&
		!/[. ]\.md$/.test(value) &&
		!/^(con|prn|aux|nul|com[1-9]|lpt[1-9])(?:\.|$)/i.test(value);
}

/** User-authored descriptions are read directly from the vault, independently of the derived index. */
export class FolderDescriptions {
	constructor(private app: App, private name: () => string, private t: (key: LocaleKey) => string) {}

	isDescription(file: TFile): boolean { return file.name === this.name(); }

	list(): Array<{ file: TFile; folder: TFolder }> {
		return this.app.vault.getMarkdownFiles()
			.filter(file => this.isDescription(file) && file.parent !== null)
			.map(file => ({ file, folder: file.parent! }));
	}

	async createAndOpen(folder: TFolder): Promise<void> {
		const path = `${folder.isRoot() ? "" : `${folder.path}/`}${this.name()}`;
		let existing = this.app.vault.getAbstractFileByPath(path);
		if (!existing) {
			const text = ["purpose", "include", "exclude"].map(section =>
				`## ${this.t(`folder-description-${section}` as LocaleKey)}\n<!-- ${this.t(`folder-description-${section}-hint` as LocaleKey)} -->\n`
			).join("\n");
			try { existing = await this.app.vault.create(path, text); }
			catch (error) {
				// Another invocation can create the same description while create is pending.
				existing = this.app.vault.getAbstractFileByPath(path);
				if (!(existing instanceof TFile)) throw error;
			}
		}
		if (!(existing instanceof TFile)) throw new Error("Description path is occupied by a folder");
		await this.app.workspace.getLeaf(false).openFile(existing);
	}
}
