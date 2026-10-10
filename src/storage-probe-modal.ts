import { FileSystemAdapter, Modal } from "obsidian";
import { t, type LocaleKey } from "./i18n";
import { createNoteSearchStorageProbe, PROBE_LIMIT_BYTES, StorageProbeError } from "./note-search";

export class StorageProbeModal extends Modal {
	onOpen(): void {
		this.contentEl.createEl("h2", { text: t("probe-title") });
		this.contentEl.createEl("p", { text: t("probe-description") });
		const output = this.contentEl.createEl("pre", { text: t("probe-ready") });
		output.style.whiteSpace = "pre-wrap";
		const buttons: HTMLButtonElement[] = [];
		const adapter = this.app.vault.adapter;
		const vaultPath = adapter instanceof FileSystemAdapter ? adapter.getBasePath() : "";
		const run = (key: LocaleKey, action: (probe: Awaited<ReturnType<typeof createNoteSearchStorageProbe>>) => Promise<string>) => {
			const button = this.contentEl.createEl("button", { text: t(key) });
			buttons.push(button);
			button.addEventListener("click", async () => {
				buttons.forEach((item) => { item.disabled = true; });
				output.setText(t("probe-running"));
				try {
					const probe = await createNoteSearchStorageProbe(vaultPath, globalThis.indexedDB);
					const result = await action(probe);
					output.setText(`${result}\n${probe.databaseName}`);
				} catch (error) {
					const code = error instanceof StorageProbeError ? error.code : "unavailable";
					output.setText(t(`probe-error-${code}`));
				} finally { buttons.forEach((item) => { item.disabled = false; }); }
			});
		};
		run("probe-write", async (probe) => { await probe.write(); return t("probe-written"); });
		run("probe-read", async (probe) => {
			const result = await probe.read();
			return result ? `${t("probe-restored")} ${result.bytes} / ${result.blocks}` : t("probe-empty");
		});
		run("probe-clear", async (probe) => {
			await probe.clear();
			if (await probe.read() !== null) throw new StorageProbeError("corrupt");
			return t("probe-cleared");
		});
		run("probe-failures", async (probe) => {
			const unavailable = await createNoteSearchStorageProbe(vaultPath, undefined);
			const checks: Array<[() => Promise<void>, string]> = [
				[() => unavailable.write(), "unavailable"],
				[() => probe.write(PROBE_LIMIT_BYTES + 1), "limit"],
				[() => probe.testAbortedWrite(), "write"],
			];
			for (const [check, expected] of checks) {
				try { await check(); }
				catch (error) { if (error instanceof StorageProbeError && error.code === expected) continue; throw error; }
				throw new StorageProbeError("corrupt");
			}
			return t("probe-failures-passed");
		});
	}

	onClose(): void { this.contentEl.empty(); }
}
