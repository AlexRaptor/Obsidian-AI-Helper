import { afterEach, expect, it, vi } from "vitest";
import { IDBFactory } from "fake-indexeddb";
import { createNoteSearch } from "../src/note-index";
import { createServerClient } from "../src/server-client";
import { editor } from "./helpers/chat-note-editor";
import { deferred } from "./helpers/obsidian";
import { t } from "../src/i18n";
import { setup, json, call } from "./helpers/chat-note-actions";

vi.mock("obsidian", async () => import("./helpers/obsidian"));
afterEach(() => { vi.restoreAllMocks(); });
const search = () => json({ tool_calls: [call({ query: "подготовка поездки" }, "поиск", "search_notes")] }, "tool_calls");
async function start(responses: Array<Response | Promise<Response>>) {
	const s = await setup(responses);
	Object.assign(s.plugin.settings, { embeddingServerUrl: "http://s/v1", embeddingModel: "представления" });
	const embeddings: unknown[] = [];
	let offline = false, unrelated = false;
	const client = createServerClient(async (_url, init) => {
		const body = JSON.parse(String(init?.body)); embeddings.push(body);
		if (offline) return new Response("Сервер недоступен", { status: 500 });
		return new Response(JSON.stringify({ data: body.input.map((_text: string, index: number) => ({ index, embedding: unrelated ? [0, 1] : [1, 0] })) }));
	});
	const noteSearch = createNoteSearch({ factory: new IDBFactory(), vaultPath: "/материалы", client,
		read: async path => s.texts.get(path) ?? null, open: async () => {} });
	s.add("Материалы.md", "Для поездки купите билет заранее.");
	noteSearch.configure(s.plugin.settings); await noteSearch.index("Материалы.md"); embeddings.length = 0;
	s.plugin.noteSearch = noteSearch;
	return { ...s, embeddings, failSearch() { offline = true; }, unrelatedSearch() { unrelated = true; } };
}
it("по явному поручению находит материалы и создаёт заметку при выключенном переключателе", async () => {
	const s = await start([search(), json({ tool_calls: [call({ title: "Поездка", content: "Купить билет заранее." })] }, "tool_calls")]);
	await s.ask("Найди материалы о подготовке поездки и создай сводную заметку");
	expect(s.texts.get("Входящие/Поездка.md")).toBe("Купить билет заранее.");
	expect(JSON.stringify(s.requests[1].messages)).toContain("Для поездки купите билет заранее.");
	expect(s.embeddings).toHaveLength(1);
	await s.view.onClose();
});

it.each(["создание", "правка"])("прежний переключатель не добавляет материалы для записи: %s", async mode => {
	const response = deferred<Response>(), s = await start([response.promise]);
	const file = s.add("План.md", "# План\nОбсуждённый маршрут."), e = editor(s, file);
	s.view.app.workspace.getLeavesOfType = (() => [{ view: e.view }]) as any;
	s.view.toggleSearch();
	s.input.value = mode === "правка" ? "Сократи @План" : "Сохрани итоговое решение";
	if (mode === "правка") { s.input.dispatchEvent({ type: "input", inputType: "insertText" } as any); s.input.keydown("Tab"); }
	s.send.click(); await vi.waitFor(() => expect(s.requests).toHaveLength(1));
	const snapshot = mode === "правка" ? JSON.parse(s.requests[0].messages.at(-1).content.split("Note attachments (context data):\n")[1])[0] : undefined;
	response.resolve(json({ tool_calls: [mode === "правка" ? call({ targetId: snapshot.targetId, expectedVersion: snapshot.version, kind: "body", content: "Краткий маршрут." }, "правка", "edit_note") : call()] }, "tool_calls"));
	await s.settle();
	expect(s.embeddings).toHaveLength(0);
	expect(JSON.stringify(s.requests)).not.toContain("Для поездки купите билет заранее.");
	expect(mode === "правка" ? e.text : s.texts.get("Входящие/Решение.md")).toContain(mode === "правка" ? "Краткий маршрут." : "Едем поездом.");
	await s.view.onClose();
});

it.each(["успех", "конфликт", "подмена цели"])("явный поиск сохраняет прикреплённую цель и проверку актуальности: %s", async mode => {
	const response = deferred<Response>(), s = await start([search(), response.promise]);
	const file = s.add("План.md", "# План\nМаршрут."), e = editor(s, file);
	s.view.app.workspace.getLeavesOfType = (() => [{ view: e.view }]) as any;
	s.input.value = "Найди материалы о поездке и дополни @План";
	s.input.dispatchEvent({ type: "input", inputType: "insertText" } as any); s.input.keydown("Tab"); s.send.click();
	await vi.waitFor(() => expect(s.requests).toHaveLength(2));
	const snapshot = JSON.parse(s.requests[0].messages.at(-1).content.split("Note attachments (context data):\n")[1])[0];
	expect(JSON.stringify(s.requests[1].messages)).toContain("Для поездки купите билет заранее.");
	if (mode === "конфликт") e.change("Ручная правка");
	response.resolve(json({ tool_calls: [call({ targetId: mode === "подмена цели" ? "Материалы.md" : snapshot.targetId, expectedVersion: snapshot.version, kind: "body", content: "# План\nКупить билет заранее." }, "правка", "edit_note")] }, "tool_calls"));
	await s.settle();
	expect(e.text).toBe(mode === "успех" ? "# План\nКупить билет заранее." : mode === "конфликт" ? "Ручная правка" : "# План\nМаршрут.");
	expect(s.texts.get("Материалы.md")).toBe("Для поездки купите билет заранее.");
	expect(s.create).not.toHaveBeenCalled();
	if (mode === "конфликт") expect(s.root.getText()).toContain(t("action-conflict"));
	await s.view.onClose();
});

it.each(["сеть", "бюджет", "индекс", "пустая выдача"])("не выполняет запись после ошибки обязательного поиска: %s", async mode => {
	const s = await start([mode === "пустая выдача" ? json({ tool_calls: [call({ query: "астрономия" }, "поиск", "search_notes")] }, "tool_calls") : search(), json({ tool_calls: [call()] }, "tool_calls")]);
	if (mode === "сеть") s.failSearch();
	if (mode === "бюджет") s.plugin.settings.noteSourceBudget = "1";
	if (mode === "индекс") await s.plugin.noteSearch.clear();
	if (mode === "пустая выдача") { s.unrelatedSearch(); }
	await s.ask("Найди материалы о поездке и создай заметку");
	expect(s.create).not.toHaveBeenCalled();
	expect(s.requests).toHaveLength(1);
	expect(s.root.getText()).not.toContain("Создана заметка:");
	expect(s.root.getText()).toContain(t(mode === "сеть" ? "search-failed" : mode === "бюджет" ? "search-budget" : mode === "индекс" ? "search-rebuild" : "search-empty"));
	await s.view.onClose();
});

it.each(["обычный", "переименование", "история"])("не передаёт скрытых соседей прикреплённого фрагмента: %s", async mode => {
	const response = deferred<Response>();
	const s = await start([...(mode !== "обычный" ? [json({ content: "Обсудили." })] : []), search(), response.promise]);
	const file = s.add("План.md", "Старый сосед\nКупить билет.\nСтарый конец"), e = editor(s, file);
	s.view.app.workspace.getLeavesOfType = (() => [{ view: e.view }]) as any;
	Object.assign(s.plugin, { currentMarkdownView: e.view });
	e.select({ line: 1, ch: 0 }, { line: 1, ch: 13 });
	if (mode !== "обычный") {
		s.input.value = mode === "история" ? "Обсудим @План" : "Обсудим фрагмент @@";
		s.input.dispatchEvent({ type: "input", inputType: "insertText" } as any); s.input.keydown("Tab");
		s.send.click(); await s.settle();
	}
	e.change("СЕКРЕТ_СВЕРХУ\nКупить билет.\nСЕКРЕТ_СНИЗУ");
	if (mode === "переименование") {
		s.entries.delete(file.path); s.texts.delete(file.path); file.path = "Поездка.md"; s.entries.set(file.path, file); s.texts.set(file.path, e.text);
	}
	await s.plugin.noteSearch.index(file.path);
	s.input.value = mode === "переименование" ? "Найди материалы и дополни тот фрагмент" : "Найди материалы и дополни фрагмент @@";
	s.input.dispatchEvent({ type: "input", inputType: "insertText" } as any);
	if (mode !== "переименование") s.input.keydown("Tab");
	s.send.click();
	const offset = mode === "обычный" ? 0 : 1;
	await vi.waitFor(() => expect(s.requests).toHaveLength(offset + 2));
	expect(JSON.stringify(s.requests)).not.toContain("СЕКРЕТ_");
	const snapshot = JSON.parse(s.requests[mode === "история" ? 1 : 0].messages.at(-1).content.split("Note attachments (context data):\n")[1])[0];
	response.resolve(json({ tool_calls: [call({ targetId: snapshot.targetId, expectedVersion: snapshot.version, kind: "fragment", content: "Купить билет заранее." }, "правка", "edit_note")] }, "tool_calls"));
	await s.settle();
	// A changed historical fragment must conflict; search still cannot disclose its neighbors.
	expect(e.text).toBe(mode === "переименование" ? "СЕКРЕТ_СВЕРХУ\nКупить билет.\nСЕКРЕТ_СНИЗУ" : "СЕКРЕТ_СВЕРХУ\nКупить билет заранее.\nСЕКРЕТ_СНИЗУ");
	expect(JSON.stringify(s.requests)).not.toContain("СЕКРЕТ_");
	await s.view.onClose();
});

it("обычное обсуждение с включённым поиском получает прежнюю выдачу", async () => {
	const s = await start([json({ content: "Обсудим подготовку." }), json({ content: "Купить билет заранее [1]." })]);
	s.view.toggleSearch(); await s.ask("Как подготовиться к поездке?");
	expect(s.embeddings).toHaveLength(1);
	expect(JSON.stringify(s.requests.at(-1)!.messages)).toContain("Для поездки купите билет заранее.");
	expect(s.root.getText()).toContain("Купить билет заранее");
	expect(s.create).not.toHaveBeenCalled();
	await s.view.onClose();
});

it("не объявляет поиск материалов без настроенной embedding-модели", async () => {
	const s = await setup([json({ content: "Настройте поиск, чтобы получить материалы." })]);
	await s.ask("Найди материалы и создай заметку");
	expect(s.requests[0].tools.map((tool: any) => tool.function.name)).not.toContain("search_notes");
	expect(s.create).not.toHaveBeenCalled();
	await s.view.onClose();
});

it("SSE-поиск выполняется до подготовки создания при включённом переключателе", async () => {
	const tool = call({ query: "подготовка поездки" }, "поиск", "search_notes");
	const data = `data: ${JSON.stringify({ choices: [{ delta: { tool_calls: [{ index: 0, ...tool }] }, finish_reason: null }] })}\n\ndata: ${JSON.stringify({ choices: [{ delta: {}, finish_reason: "tool_calls" }] })}\n\ndata: [DONE]\n\n`;
	const s = await start([new Response(data, { headers: { "Content-Type": "text/event-stream" } }), json({ tool_calls: [call()] }, "tool_calls")]);
	s.view.toggleSearch(); await s.ask("Найди материалы о поездке и создай заметку");
	expect(s.texts.has("Входящие/Решение.md")).toBe(true);
	expect(s.embeddings).toHaveLength(1);
	expect(JSON.stringify(s.requests[1].messages)).toContain("Для поездки купите билет заранее.");
	await s.view.onClose();
});

it("не записывает подготовленный заранее текст в одном пакете с поиском", async () => {
	const s = await start([json({ tool_calls: [call({ query: "поездка" }, "поиск", "search_notes"), call()] }, "tool_calls")]);
	await s.ask("Найди материалы о поездке и создай заметку");
	expect(s.create).not.toHaveBeenCalled();
	expect(s.embeddings).toHaveLength(0);
	expect(s.root.getText()).toContain(t("action-invalid"));
	await s.view.onClose();
});
