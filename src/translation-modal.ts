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
		const nameRow = this.contentEl.createDiv({ cls: "ai-helper-translation-name" });
		const name = nameRow.createEl("input", { attr: { type: "text", "aria-label": this.plugin.t("translation-enter-name") } });
		new ButtonComponent(nameRow).setButtonText(this.plugin.t("translation-use-name")).onClick(() => this.plugin.translation.setName(name.value));
		const actions = this.contentEl.createDiv({ cls: "modal-button-container ai-helper-translation-actions" });
		const cancel = new ButtonComponent(actions).onClick(() => { if (this.plugin.translation.busy) this.plugin.translation.stop(); else { this.plugin.translation.cancel(); this.close(); } });
		new ButtonComponent(actions).setButtonText(this.plugin.t("translation-hide")).onClick(() => this.close());
		const retry = new ButtonComponent(actions).setButtonText(this.plugin.t("translation-retry")).onClick(() => this.plugin.translation.retry());
		const save = new ButtonComponent(actions).setButtonText(this.plugin.t("translation-save")).onClick(() => { void this.plugin.translation.save(); });
		const partial = new ButtonComponent(actions).setButtonText(this.plugin.t("translation-save-partial")).onClick(() => { void this.plugin.translation.savePartial(); });
		const overwrite = new ButtonComponent(actions).setButtonText(this.plugin.t("translation-overwrite")).setWarning().onClick(() => { void this.plugin.translation.save("overwrite"); });
		const saveCopy = new ButtonComponent(actions).setButtonText(this.plugin.t("translation-copy")).onClick(() => { void this.plugin.translation.save("copy"); });
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
			partial.setDisabled(!operation.canSavePartial);
			partial.buttonEl.style.display = operation.busy || operation.canSave || !operation.active ? "none" : "";
			retry.setButtonText(this.plugin.t(operation.needsName ? "translation-retry" : "translation-continue"));
			nameRow.style.display = operation.needsName ? "" : "none";
			save.buttonEl.style.display = operation.canSave && !operation.conflict ? "" : "none";
			overwrite.buttonEl.style.display = operation.canSave && operation.conflict?.file ? "" : "none";
			saveCopy.buttonEl.style.display = operation.canSave && operation.conflict ? "" : "none";
			save.setDisabled(!operation.canSave); overwrite.setDisabled(!operation.canSave); saveCopy.setDisabled(!operation.canSave);
			progress.setText(this.plugin.t(operation.partialResult && operation.stage === "translation-saving" ? "translation-partial-saving" : operation.partialResult && operation.stage === "translation-saved" ? "translation-partial-saved" : operation.stage) + (["translation-preparing", "translation-running", "translation-error", "translation-waiting"].includes(operation.stage) ? ` — ${Math.floor(operation.progress * 100)}%` : ""));
			detail.setText(operation.detail ? this.plugin.t(operation.detail) + (operation.saveError ? ` ${operation.saveError}` : "") : "");
			const warning = operation.detail === "translation-unresolved" || operation.detail === "translation-conflict" || operation.detail === "translation-target-changed";
			const error = operation.stage === "translation-error" || operation.detail === "translation-title-error" || operation.detail === "translation-name";
			setStatusTone(detail, warning ? "warning" : error ? "error" : "info");
			detail.style.display = operation.detail ? "" : "none";
			path.setText(operation.savedPath || operation.conflict?.path || "");
			path.style.display = operation.savedPath || operation.conflict ? "" : "none";
			setStatusTone(status, operation.stage === "translation-error" ? "error" : operation.stage === "translation-saved" ? "success" : "info");
			cancel.setButtonText(this.plugin.t(operation.busy ? "translation-stop" : operation.needsName || operation.canSave ? "translation-cancel" : "translation-finish"));
			cancel.setDisabled(operation.stage === "translation-saving");
			retry.buttonEl.style.display = operation.canRetry ? "" : "none";
			retry.setDisabled(!operation.canRetry);
			copy?.setDisabled(!operation.debugResponse);
		};
		this.unsubscribe = this.plugin.translation.subscribe(update); update();
	}
	onClose(): void { this.unsubscribe?.(); this.contentEl.empty(); }
}
