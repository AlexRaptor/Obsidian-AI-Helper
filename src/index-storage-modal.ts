import { Modal } from "obsidian";
import { setStatusTone } from "./ui-status";
import type { AiHelperPlugin } from "./main";
import type { IndexStorageMode } from "./note-index";

export class IndexStorageModal extends Modal {
	constructor(private plugin: AiHelperPlugin, private mode: IndexStorageMode, private finished: () => void) { super(plugin.app); }
	onOpen(): void {
		this.contentEl.createEl("h2", { text: this.plugin.t("index-storage-mode") });
		setStatusTone(this.contentEl.createEl("p", { text: this.plugin.t("index-storage-warning") }), "warning");
		this.contentEl.createEl("p", { text: this.plugin.noteIndexDisclosure() });
		const actions = this.contentEl.createDiv({ cls: "modal-button-container ai-helper-button-group" });
		actions.createEl("button", { cls: "ai-helper-storage-cancel", text: this.plugin.t("index-storage-cancel") })
			.addEventListener("click", () => this.close());
		const confirm = actions.createEl("button", { cls: "ai-helper-storage-confirm mod-warning", text: this.plugin.t("index-storage-confirm") });
		confirm.addEventListener("click", () => {
			confirm.disabled = true;
			this.close();
			const changing = this.plugin.changeIndexStorage(this.mode);
			this.finished();
			void changing.finally(this.finished);
		});
	}
	onClose(): void { this.contentEl.empty(); this.finished(); }
}
