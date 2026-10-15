import { ButtonComponent, Modal } from "obsidian";
import type { AiHelperPlugin } from "./main";
import { setStatusTone } from "./ui-status";

export class TranslationModal extends Modal {
	private unsubscribe?: () => void;
	constructor(private plugin: AiHelperPlugin) { super(plugin.app); }
	onOpen(): void {
		this.setTitle(this.plugin.t("translation-title"));
		const status = this.contentEl.createDiv({ attr: { "aria-live": "polite" } });
		const cancel = new ButtonComponent(this.contentEl).onClick(() => { this.plugin.translation.cancel(); this.close(); });
		new ButtonComponent(this.contentEl).setButtonText(this.plugin.t("translation-hide")).onClick(() => this.close());
		const update = () => {
			const operation = this.plugin.translation;
			status.setText(`${this.plugin.t(operation.stage)}${operation.detail ? `: ${this.plugin.t(operation.detail)}` : ""}${operation.savedPath ? `\n${operation.savedPath}` : ""}`);
			setStatusTone(status, operation.stage === "translation-error" ? "error" : operation.stage === "translation-saved" ? "success" : "info");
			cancel.setButtonText(this.plugin.t(operation.busy ? "translation-stop" : "translation-finish"));
		};
		this.unsubscribe = this.plugin.translation.subscribe(update); update();
	}
	onClose(): void { this.unsubscribe?.(); this.contentEl.empty(); }
}
