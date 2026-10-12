import { Modal, Notice, Setting, type ButtonComponent } from "obsidian";
import type { AiHelperPlugin } from "./main";

export class FolderDescriptionNameModal extends Modal {
	private saving = false;
	private cancel?: ButtonComponent;
	constructor(private plugin: AiHelperPlugin, private name: string, private finished: () => void) { super(plugin.app); }
	onOpen(): void {
		this.contentEl.createEl("h2", { text: this.plugin.t("folder-description-name") });
		this.contentEl.createEl("p", { text: this.plugin.t("folder-description-change").replace("{count}", String(this.plugin.folderDescriptions.list().length)).replace("{name}", this.name) });
		new Setting(this.contentEl)
			.addButton(button => {
				this.cancel = button;
				button.buttonEl.addClass("ai-helper-description-cancel");
				button.setButtonText(this.plugin.t("folder-description-cancel")).onClick(() => this.close());
			});
		new Setting(this.contentEl)
			.addButton(button => {
				button.buttonEl.addClass("ai-helper-description-confirm", "mod-cta");
				button.setButtonText(this.plugin.t("folder-description-confirm")).onClick(async () => {
					if (this.saving) return;
					this.saving = true;
					this.cancel?.setDisabled(true);
					button.setDisabled(true);
					const previous = this.plugin.settings.folderDescriptionName;
					this.plugin.settings.folderDescriptionName = this.name;
					try { await this.plugin.saveSettings(); this.saving = false; this.close(); }
					catch {
						this.plugin.settings.folderDescriptionName = previous;
						new Notice(this.plugin.t("folder-description-save-error"));
						this.saving = false;
						this.cancel?.setDisabled(false);
						button.setDisabled(false);
					}
				});
			});
	}
	close(): void { if (!this.saving) super.close(); }
	onClose(): void { this.contentEl.empty(); this.finished(); }
}
