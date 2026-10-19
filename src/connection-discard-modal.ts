import { ButtonComponent, Modal, type App } from "obsidian";
import type { LocaleKey } from "./i18n";

/** Closing the dialog by any means keeps the selection. */
export class ConnectionDiscardModal extends Modal {
	private confirmed = false;
	constructor(app: App, private t: (key: LocaleKey) => string, private action: "clear-conversation" | "connections-close", private done: (discard: boolean) => void) { super(app); }
	onOpen(): void {
		this.setTitle(this.t(this.action));
		this.contentEl.createEl("p", { text: this.t("connections-discard-warning") });
		const actions = this.contentEl.createDiv();
		new ButtonComponent(actions).setButtonText(this.t("translation-cancel")).onClick(() => this.close()).buttonEl.addClass("ai-helper-discard-cancel");
		new ButtonComponent(actions).setButtonText(this.t(this.action)).setWarning().onClick(() => { this.confirmed = true; this.close(); }).buttonEl.addClass("ai-helper-discard-confirm");
	}
	onClose(): void { this.contentEl.empty(); this.done(this.confirmed); }
}
