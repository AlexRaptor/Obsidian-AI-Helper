import { ButtonComponent, Modal } from "obsidian";
import type { AiHelperPlugin } from "./main";
import { setStatusTone, showStatusNotice } from "./ui-status";

export class TranslationModal extends Modal {
	private unsubscribe?: () => void;
	constructor(private plugin: AiHelperPlugin) { super(plugin.app); }
	onOpen(): void {
		this.setTitle(this.plugin.t("translation-title"));
		const status = this.contentEl.createDiv({ attr: { "aria-live": "polite" } });
		const progress = status.createDiv();
		const detail = status.createDiv();
		const path = status.createDiv({ cls: "ai-helper-translation-path" });
		setStatusTone(path, "muted");
		const actions = this.contentEl.createDiv({ cls: "modal-button-container ai-helper-translation-actions" });
		const cancel = new ButtonComponent(actions).onClick(() => { this.plugin.translation.cancel(); this.close(); });
		new ButtonComponent(actions).setButtonText(this.plugin.t("translation-hide")).onClick(() => this.close());
		const retry = new ButtonComponent(actions).setButtonText(this.plugin.t("translation-retry")).onClick(() => this.plugin.translation.retry());
		const copy = this.plugin.settings.translationDebugMode ? new ButtonComponent(actions)
			.setButtonText(this.plugin.t("translation-copy-response"))
			.onClick(async () => {
				const response = this.plugin.translation.debugResponse;
				if (!response) return;
				try {
					await navigator.clipboard.writeText(response);
					showStatusNotice(this.plugin.t("translation-response-copied"), "success");
				} catch { showStatusNotice(this.plugin.t("translation-copy-error"), "error"); }
			}) : undefined;
		const update = () => {
			const operation = this.plugin.translation;
			progress.setText(this.plugin.t(operation.stage));
			detail.setText(operation.detail ? this.plugin.t(operation.detail) : "");
			detail.style.display = operation.detail ? "" : "none";
			path.setText(operation.savedPath);
			path.style.display = operation.savedPath ? "" : "none";
			setStatusTone(status, operation.stage === "translation-error" ? "error" : operation.stage === "translation-saved" ? "success" : "info");
			cancel.setButtonText(this.plugin.t(operation.busy ? "translation-stop" : "translation-finish"));
			cancel.setDisabled(operation.stage === "translation-saving");
			retry.buttonEl.style.display = operation.canRetry ? "" : "none";
			retry.setDisabled(!operation.canRetry);
			copy?.setDisabled(!operation.debugResponse);
		};
		this.unsubscribe = this.plugin.translation.subscribe(update); update();
	}
	onClose(): void { this.unsubscribe?.(); this.contentEl.empty(); }
}
