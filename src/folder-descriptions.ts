import { TFile, type App, type TFolder } from "obsidian";
import type { LocaleKey } from "./i18n";

export const DEFAULT_FOLDER_DESCRIPTION_NAME = "_folder.md";

export function isValidFolderDescriptionName(value: unknown): value is string {
	return typeof value === "string" && value === value.trim() &&
		/^[^\\/:*?"<>|\x00-\x1f]+\.md$/.test(value) &&
		!/[. ]\.md$/.test(value) &&
		!/^(con|prn|aux|nul|com[1-9]|lpt[1-9])(?:\.|$)/i.test(value);
}

export class DescriptionRenameConflict extends Error {
	constructor(public paths: string[]) { super("Description rename destinations are occupied"); }
}

export class DescriptionRenameFailure extends Error {
	constructor(public remaining: Array<{ original: string; current: string }>) { super("Description rename failed"); }
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

	async renameAll(name: string, save: () => Promise<void>): Promise<void> {
		const plan = this.list().map(({ file, folder }) => ({ file, original: file.path,
			path: `${folder.isRoot() ? "" : `${folder.path}/`}${name}`,
		}));
		const conflicts: string[] = [];
		for (const { file, path } of plan) {
			if (await this.destinationOccupied(file, path)) conflicts.push(path);
		}
		if (conflicts.length) throw new DescriptionRenameConflict(conflicts);
		const attempted: typeof plan = [];
		try {
			for (const entry of plan) {
				// Recheck immediately before each move: the vault can change after preflight.
				if (await this.destinationOccupied(entry.file, entry.path)) throw new Error("Destination became occupied");
				attempted.push(entry);
				await this.app.fileManager.renameFile(entry.file, entry.path);
			}
			await save();
		} catch {
			for (const { file, original } of [...attempted].reverse()) {
				if (file.path === original) continue;
				try {
					if (await this.destinationOccupied(file, original)) continue;
					await this.app.fileManager.renameFile(file, original);
				} catch { /* Continue restoring the rest; report actual remaining paths below. */ }
			}
			throw new DescriptionRenameFailure(attempted.filter(entry => entry.file.path !== entry.original)
				.map(entry => ({ original: entry.original, current: entry.file.path })));
		}
	}

	private async destinationOccupied(file: TFile, path: string): Promise<boolean> {
		const existing = this.app.vault.getAbstractFileByPath(path);
		if (existing) return existing !== file;
		if (!await this.app.vault.adapter.exists(path)) return false;
		// A case-only rename on a case-insensitive filesystem resolves to the source itself.
		// Exact-case existence still protects a distinct destination on a case-sensitive vault.
		if (file.path.toLowerCase() === path.toLowerCase() &&
			await this.app.vault.adapter.exists(file.path, true) &&
			!await this.app.vault.adapter.exists(path, true)) return false;
		return true;
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
