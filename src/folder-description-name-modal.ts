import { Modal, Notice, Setting, type ButtonComponent } from "obsidian";
import { DescriptionRenameConflict, DescriptionRenameFailure } from "./folder-descriptions";
import type { AiHelperPlugin } from "./main";

export class FolderDescriptionNameModal extends Modal {
	private saving = false;
	private resultEl?: HTMLElement;
	private buttons: ButtonComponent[] = [];
	constructor(private plugin: AiHelperPlugin, private name: string, private finished: () => void) { super(plugin.app); }
	onOpen(): void {
		this.contentEl.createEl("h2", { text: this.plugin.t("folder-description-name") });
		this.contentEl.createEl("p", { text: this.plugin.t("folder-description-change").replace("{count}", String(this.plugin.folderDescriptions.list().length)).replace("{name}", this.name) });
		new Setting(this.contentEl)
			.addButton(button => {
				this.buttons.push(button);
				button.buttonEl.addClass("ai-helper-description-cancel");
				button.setButtonText(this.plugin.t("folder-description-cancel")).onClick(() => this.close());
			});
		this.resultEl = this.contentEl.createDiv({ attr: { "role": "status", "aria-live": "polite" } });
		this.addSaveAction("ai-helper-description-confirm", "folder-description-confirm", false);
		this.addSaveAction("ai-helper-description-rename", "folder-description-rename", true);
	}
	private addSaveAction(cls: string, label: "folder-description-confirm" | "folder-description-rename", rename: boolean): void {
		new Setting(this.contentEl).addButton(button => {
			this.buttons.push(button);
			button.buttonEl.addClass(cls, "mod-cta");
			button.setButtonText(this.plugin.t(label)).onClick(async () => {
				if (this.saving) return;
				this.resultEl?.empty();
				this.saving = true;
				this.buttons.forEach(button => button.setDisabled(true));
				const previous = this.plugin.settings.folderDescriptionName;
				const save = async () => {
					this.plugin.settings.folderDescriptionName = this.name;
					await this.plugin.saveSettings();
				};
				try {
					if (rename) await this.plugin.folderDescriptions.renameAll(this.name, save);
					else await save();
					this.saving = false; this.close();
				} catch (error) {
					this.plugin.settings.folderDescriptionName = previous;
					if (error instanceof DescriptionRenameConflict) {
						this.resultEl?.createEl("p", { text: this.plugin.t("folder-description-conflicts") });
						const list = this.resultEl?.createEl("ul");
						error.paths.forEach(path => list?.createEl("li", { text: path }));
					} else if (error instanceof DescriptionRenameFailure) {
						this.resultEl?.createEl("p", { text: this.plugin.t(error.remaining.length ? "folder-description-restore-incomplete" : "folder-description-restored") });
						const list = this.resultEl?.createEl("ul");
						error.remaining.forEach(({ original, current }) => list?.createEl("li", { text: `${current} → ${original}` }));
					} else new Notice(this.plugin.t("folder-description-save-error"));
				} finally {
					this.saving = false;
					this.buttons.forEach(button => button.setDisabled(false));
				}
			});
		});
	}
	close(): void { if (!this.saving) super.close(); }
	onClose(): void { this.contentEl.empty(); this.finished(); }
}
