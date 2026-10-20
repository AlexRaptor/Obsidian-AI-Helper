import { readFileSync } from "node:fs";
import { expect, it, vi } from "vitest";
import { createServerClient } from "../src/server-client";
import { t } from "../src/i18n";
import { setup, json, call } from "./helpers/chat-note-actions";
import { editor } from "./helpers/chat-note-editor";
import { flushPromises } from "./helpers/obsidian";

vi.mock("obsidian", async () => import("./helpers/obsidian"));
const settingsPath = process.env.AI_HELPER_LIVE_SETTINGS;

// Opt in with a local data.json. No credentials, vault files or model replies are recorded.
it.skipIf(!settingsPath)("модель выполняет новый экспорт исторических снимков после прежнего ошибочного отказа", async () => {
	const s = await setup([
		json({ content: "Я не могу выполнить эту команду: заметку с этим содержимым я уже сохранил в этой сессии, и повторная запись была бы некорректной." }),
		json({ content: "Обсудили поездку." }), json({ content: "Обсудили фрагмент." }),
		json({ tool_calls: [call({ title: "Без текстов вложений", folder: "Экспорт" }, "экспорт", "export_chat")] }, "tool_calls"),
		json({ content: "Чат сохранён." }),
	]);
	try {
		// Replay the prior incorrect claim observed in manual testing, without endorsing it as a tool result.
		await s.ask("Сохрани весь чат в заметку «С остановкой» в папке «Экспорт».");
		const file = s.add("Материалы/Поездка.md", "МАРКЕР_ПОЛНОЙ_ЗАМЕТКИ_73\nЕдем поездом.");
		s.input.value = "Обсудим @Поездка";
		s.input.dispatchEvent({ type: "input", inputType: "insertText" } as any); s.input.keydown("Tab");
		s.send.click(); await s.settle();
		const fragment = s.add("Материалы/Фрагмент.md", "СКРЫТЫЙ_СОСЕД_73\nВЫДЕЛЕННЫЙ_ФРАГМЕНТ_73\nСКРЫТЫЙ_ХВОСТ_73");
		const e = editor(s, fragment);
		e.select({ line: 1, ch: 0 }, { line: 2, ch: 0 });
		s.view.app.workspace.getLeavesOfType = (() => [{ view: e.view }]) as any;
		s.view.app.workspace.getActiveViewOfType = (() => e.view) as any;
		s.input.value = "Обсудим @@";
		s.input.dispatchEvent({ type: "input", inputType: "insertText" } as any); s.input.keydown("Tab");
		s.send.click(); await s.settle();
		await s.ask("Сохрани весь чат в заметку «Без текстов вложений» в папке «Экспорт».");
		s.texts.set(file.path, "НОВАЯ_ВЕРСИЯ_ЗАМЕТКИ_73"); e.change("НОВАЯ_ВЕРСИЯ_ФРАГМЕНТА_73");

		const config = JSON.parse(readFileSync(settingsPath!, "utf8"));
		Object.assign(s.plugin.settings, { serverUrl: config.serverUrl, model: config.model, apiKey: config.apiKey ?? "",
			systemPrompt: config.systemPrompt ?? "", contextWindow: config.contextWindow || "32000", temperature: "0", responseWait: "120" });
		s.plugin.serverClient = createServerClient(fetch);
		s.input.value = "Сохрани весь чат в заметку «Со снимками» в папке «Экспорт». Включи полные исторические снимки прикреплённых заметок и снимки выделенных фрагментов.";
		s.send.click();
		await vi.waitFor(() => expect(s.send.attributes["aria-label"]).toBe(t("send")), { timeout: 180_000, interval: 100 });
		await flushPromises();
		const saved = s.texts.get("Экспорт/Со снимками.md");
		expect(saved, s.root.getText()).toBeDefined();
		expect(saved).toContain("МАРКЕР_ПОЛНОЙ_ЗАМЕТКИ_73");
		expect(saved).toContain("ВЫДЕЛЕННЫЙ_ФРАГМЕНТ_73");
		for (const hidden of ["НОВАЯ_ВЕРСИЯ", "СКРЫТЫЙ_СОСЕД_73", "СКРЫТЫЙ_ХВОСТ_73"]) expect(saved).not.toContain(hidden);
	} finally {
		await s.view.onClose();
		vi.restoreAllMocks();
	}
}, 240_000);
