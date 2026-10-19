import { Modal, type App, type EventRef, type TFile } from "obsidian";
import { fragmentLabel, type SelectedFragmentSnapshot } from "./note-attachments";
import type { LocaleKey } from "./i18n";

/** Displays the saved Markdown literally, without resolving links or embeds. */
export class FragmentSnapshotModal extends Modal {
	private events: EventRef[] = [];
	private openButton?: HTMLButtonElement;
	private closeButton?: HTMLButtonElement;
	private status?: HTMLElement;
	private restoreFocus = true;

	constructor(app: App, private snapshot: SelectedFragmentSnapshot, private file: TFile | undefined,
		private t: (key: LocaleKey) => string, private trigger: HTMLElement) { super(app); }

	onOpen(): void {
		this.buildContent();
		this.refreshLocale();
		const refresh = () => this.refreshAvailability();
		this.events = [this.app.vault.on("delete", refresh), this.app.vault.on("rename", refresh), this.app.vault.on("create", refresh)];
	}

	private buildContent(): void {
		this.contentEl.empty();
		this.contentEl.createEl("p", { text: fragmentLabel(this.snapshot) });
		this.contentEl.createEl("p", { cls: "ai-helper-fragment-path", text: this.snapshot.path });
		this.contentEl.createEl("pre", { cls: "ai-helper-fragment-text", text: this.snapshot.markdown });
		this.status = this.contentEl.createEl("p", { cls: "ai-helper-fragment-status", attr: { role: "status" } });
		const actions = this.contentEl.createDiv({ cls: "modal-button-container ai-helper-button-group" });
		this.openButton = actions.createEl("button", { cls: "ai-helper-fragment-open", text: this.t("fragment-view-open"), attr: { type: "button" } });
		this.openButton.addEventListener("click", () => { void this.openOriginal(); });
		this.refreshAvailability();
		this.closeButton = actions.createEl("button", { cls: "ai-helper-fragment-close", text: this.t("fragment-view-close"), attr: { type: "button" } });
		this.closeButton.addEventListener("click", () => this.close());
	}

	refreshLocale(): void {
		this.setTitle(this.t("fragment-view-title"));
		this.openButton?.setText(this.t("fragment-view-open"));
		this.closeButton?.setText(this.t("fragment-view-close"));
		this.refreshAvailability();
	}

	private originalAvailable(): boolean {
		return !!this.file && this.app.vault.getFileByPath(this.file.path) === this.file;
	}

	private refreshAvailability(): void {
		const available = this.originalAvailable();
		if (this.openButton) this.openButton.disabled = !available;
		this.status?.setText(this.t(available ? "fragment-view-location" : "fragment-view-unavailable"));
	}

	private async openOriginal(): Promise<void> {
		if (!this.originalAvailable()) { this.refreshAvailability(); return; }
		try {
			await this.app.workspace.getLeaf("tab").openFile(this.file!, { eState: { line: this.snapshot.range.from.line } });
			this.restoreFocus = false;
			this.close();
		} catch {
			this.status?.setText(this.t("fragment-view-unavailable"));
		}
	}

	onClose(): void {
		for (const ref of this.events) this.app.vault.offref(ref);
		this.events = [];
		this.contentEl.empty();
		if (this.restoreFocus) this.trigger.focus();
	}
}
