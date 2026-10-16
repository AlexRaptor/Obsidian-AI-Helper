import { TFile, type Vault } from "obsidian";

export function translationName(raw: string): string | undefined {
	const name = raw.trim().replace(/[. ]+$/u, "").replace(/(?:\.md)+$/iu, "").replace(/[\/\\:*?"<>|\u0000-\u001f\u007f\[\]#^]/gu, "_").replace(/[. ]+$/u, "");
	if (!name || /^(?:con|prn|aux|nul|com[0-9¹²³]|lpt[0-9¹²³])(?:[ .]|$)/iu.test(name) || new TextEncoder().encode(name).length > 240) return undefined;
	return name;
}
export interface SaveConflict { path: string; file?: TFile; content?: string; changed?: boolean }
class TargetChanged extends Error {}

/** Keeps a ready translation independent of the model lease and checks writes at the Vault boundary. */
export class TranslationSave {
	conflict?: SaveConflict;
	private retryMode: "save" | "copy" = "save";
	constructor(private vault: Vault, readonly original: string, readonly path: string, private assemble: (path: string) => string, private signal: AbortSignal, private caseInsensitive: boolean) {}
	private check(): void { if (this.signal.aborted) throw new Error("cancelled"); }
	private protected(path: string): boolean {
		return path === this.original || (this.caseInsensitive && path.toLowerCase() === this.original.toLowerCase());
	}
	private target(path: string) {
		return this.vault.getAbstractFileByPath(path) ?? (this.caseInsensitive ? this.vault.getFiles().find(file => file.path.toLowerCase() === path.toLowerCase()) : undefined);
	}
	private async inspect(path: string): Promise<SaveConflict | undefined> {
		const target = this.target(path);
		if (this.protected(path)) return { path };
		if (target instanceof TFile) return { path, file: target, content: await this.vault.read(target) };
		if (target || await this.vault.adapter.exists(path)) return { path };
		return undefined;
	}
	async write(mode: "save" | "copy" | "overwrite" = this.retryMode): Promise<TFile | undefined> {
		this.retryMode = mode === "copy" ? "copy" : "save";
		let path = this.path;
		let number = 2;
		const approved = mode === "overwrite" ? this.conflict : undefined;
		this.conflict = undefined;
		for (;;) {
			if (mode === "copy") path = this.path.slice(0, -3) + ` (${number++}).md`;
			const conflict = await this.inspect(path); this.check();
			if (approved && !conflict) { this.conflict = { path, changed: true }; return; }
			if (conflict) {
				if (mode === "copy") continue;
				if (!approved?.file || !conflict.file || approved.file !== conflict.file || approved.content !== conflict.content) { this.conflict = conflict; return; }
			}
			const parts = path.split("/").slice(0, -1);
			for (let i = 1; i <= parts.length; i++) {
				const folder = parts.slice(0, i).join("/");
				if (!this.vault.getAbstractFileByPath(folder) && !await this.vault.adapter.exists(folder)) {
					this.check(); await this.vault.createFolder(folder);
				}
				this.check();
			}
			const body = this.assemble(conflict?.file?.path ?? path);
			if (conflict?.file) {
				try {
					await this.vault.process(conflict.file, current => {
						this.check();
						if (current !== approved!.content || this.target(path) !== conflict.file) throw new TargetChanged();
						return body;
					});
					return conflict.file;
				} catch (error) {
					if (!(error instanceof TargetChanged)) throw error;
					this.conflict = await this.inspect(path) ?? { path, changed: true }; return;
				}
			}
			// Recheck after asynchronous folder creation; create itself must never overwrite.
			const changed = await this.inspect(path); this.check();
			if (changed) { if (mode === "copy") continue; this.conflict = changed; return; }
			try { return await this.vault.create(path, body); }
			catch (error) {
				const occupied = await this.inspect(path);
				if (!occupied) throw error;
				if (mode === "copy") continue;
				this.conflict = occupied; return;
			}
		}
	}
}
