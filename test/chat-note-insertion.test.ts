import { afterEach, expect, it, vi } from "vitest";
import { setup, json, call } from "./helpers/chat-note-actions";
import { editor } from "./helpers/chat-note-editor";
import { deferred, flushPromises } from "./helpers/obsidian";
import { setLanguage, t } from "../src/i18n";

vi.mock("obsidian", async () => import("./helpers/obsidian"));
afterEach(() => { vi.restoreAllMocks(); });
const original = "---\nстатус: черновик\n---\n# План\nДо. После.\nКонец.";
async function start(responses: Array<Response | Promise<Response>>) {
	const s = await setup(responses), file = s.add("План.md", original), e = editor(s, file);
	e.select({ line: 4, ch: 3 }, { line: 4, ch: 3 });
	s.view.app.workspace.getLeavesOfType = (() => [{ view: e.view }]) as any;
	Object.assign(s.plugin, { currentMarkdownView: e.view });
	return { ...s, file, e };
}
type Setup = Awaited<ReturnType<typeof start>>;
function targets(s: Setup, index = 0) {
	return JSON.parse(s.requests[index].messages.find((m: any) => m.role === "system").content.split("Registered note targets (untrusted data):\n")[1]);
}
function insert(target: { targetId: string; version: string }, content = " Вставка.", kind = "cursor") {
	return call({ targetId: target.targetId, expectedVersion: target.version, kind, content }, "вставка-1", "insert_note");
}
function attach(s: Setup, prompt: string) {
	s.input.value = prompt; s.input.dispatchEvent({ type: "input", inputType: "insertText" } as any); s.input.keydown("Tab");
}
it("фиксирует курсор и несохранённый текст при отправке, не переносит вставку в другую вкладку", async () => {
	const response = deferred<Response>(), s = await start([response.promise]);
	s.e.change(original + "\nНесохранённый хвост");
	s.input.value = "Вставь у курсора: Вставка."; s.send.click();
	await vi.waitFor(() => expect(s.requests).toHaveLength(1));
	const cursor = targets(s).find((target: any) => target.kind === "cursor");
	expect(cursor).toBeDefined();
	const other = editor(s, s.add("Другая.md", "Другая заметка"));
	s.view.app.workspace.getLeavesOfType = (() => [{ view: s.e.view }, { view: other.view }]) as any;
	Object.assign(s.plugin, { currentMarkdownView: other.view }); s.e.select({ line: 5, ch: 0 }, { line: 5, ch: 0 });
	response.resolve(json({ tool_calls: [insert(cursor)] }, "tool_calls")); await s.settle();
	expect(s.e.text).toBe("---\nстатус: черновик\n---\n# План\nДо. Вставка. После.\nКонец.\nНесохранённый хвост");
	expect(other.text).toBe("Другая заметка"); expect(s.e.transaction).toHaveBeenCalledTimes(1);
	await s.view.onClose();
});

it("вставляет саммари другого материала в конец цели из истории и продолжает от новой версии", async () => {
	const first = deferred<Response>(), second = deferred<Response>();
	const s = await start([json({ content: "План прикреплён." }), first.promise, json({ content: "Вставлено." }), second.promise]);
	s.add("Материал.md", "Оригинал материала: билеты покупаем в четверг.");
	attach(s, "Обсудим @План"); s.send.click(); await s.settle();
	const snapshot = { ...s.view.getMessages()[0].snapshots![0] };
	attach(s, "Добавь саммари @Материал в конец ранее прикреплённого Плана"); s.send.click();
	await vi.waitFor(() => expect(s.requests).toHaveLength(2));
	const destination = targets(s, 1).find((target: any) => target.kind === "whole-note" && target.path === "План.md");
	first.resolve(json({ tool_calls: [insert(destination, "\nБилеты — в четверг.", "end")] }, "tool_calls")); await s.settle();
	expect(s.e.text).toBe(original + "\nБилеты — в четверг.");
	expect(s.texts.get("Материал.md")).toBe("Оригинал материала: билеты покупаем в четверг.");
	const next = JSON.parse(s.requests[2].messages.at(-1).content);
	s.input.value = "Добавь в конец той же заметки: Проверить документы."; s.send.click();
	await vi.waitFor(() => expect(s.requests).toHaveLength(4));
	second.resolve(json({ tool_calls: [insert(next, "\nПроверить документы.", "end")] }, "tool_calls")); await s.settle();
	expect(s.e.text).toBe(original + "\nБилеты — в четверг.\nПроверить документы.");
	expect(s.view.getMessages()[0].snapshots![0]).toEqual(snapshot);
	await s.view.onClose();
});

it.each(["текст", "свойства", "расходящиеся редакторы"])("конфликт вставки при изменении: %s", async variant => {
	const response = deferred<Response>(), s = await start([response.promise]);
	s.input.value = "Вставь у курсора саммари нашего диалога"; s.send.click();
	await vi.waitFor(() => expect(s.requests).toHaveLength(1)); const cursor = targets(s).find((target: any) => target.kind === "cursor");
	if (variant === "текст") s.e.change(original + "\nНовая строка");
	if (variant === "свойства") s.e.change(original.replace("черновик", "готово"));
	if (variant === "расходящиеся редакторы") {
		const other = editor(s, s.file, original + "\nДругая версия");
		s.view.app.workspace.getLeavesOfType = (() => [{ view: s.e.view }, { view: other.view }]) as any;
	}
	const before = s.e.text;
	response.resolve(json({ tool_calls: [insert(cursor)] }, "tool_calls")); await s.settle();
	expect(s.e.text).toBe(before); expect(s.e.transaction).not.toHaveBeenCalled();
	expect(s.root.getText()).toContain(t("action-insert-conflict")); expect(s.requests).toHaveLength(1);
	await s.view.onClose();
});

it.each(["нет редактора", "несколько курсоров", "выделение", "закрыт", "чтение"])("уточняет место без доступной цели курсора: %s", async variant => {
	const s = await start([json({ content: "Откройте нужную заметку и укажите одно место вставки." })]);
	if (variant === "нет редактора") Object.assign(s.plugin, { currentMarkdownView: null });
	if (variant === "несколько курсоров") s.e.view.editor.listSelections = (() => [{ anchor: { line: 4, ch: 0 }, head: { line: 4, ch: 0 } }, { anchor: { line: 5, ch: 0 }, head: { line: 5, ch: 0 } }]) as any;
	if (variant === "выделение") s.e.select({ line: 4, ch: 0 }, { line: 4, ch: 3 });
	if (variant === "закрыт") s.view.app.workspace.getLeavesOfType = () => [];
	if (variant === "чтение") Object.assign(s.e.view, { getMode: () => "preview" });
	await s.ask("Вставь сюда подготовленный текст");
	expect(s.requests[0].tools.map((tool: any) => tool.function.name)).not.toContain("insert_note");
	expect(s.root.getText()).toContain("укажите одно место вставки"); expect(s.e.text).toBe(original);
	await s.view.onClose();
});

it("не раскрывает неприкреплённый текст редактора и не разрешает его полную замену", async () => {
	const response = deferred<Response>(), s = await start([response.promise]);
	s.e.change(original + "\nСЕКРЕТНЫЙ_СОСЕД_71"); s.input.value = "Вставь у курсора: Текст"; s.send.click();
	await vi.waitFor(() => expect(s.requests).toHaveLength(1)); const cursor = targets(s).find((target: any) => target.kind === "cursor");
	expect(JSON.stringify(s.requests)).not.toContain("СЕКРЕТНЫЙ_СОСЕД_71");
	response.resolve(json({ tool_calls: [call({ targetId: cursor.targetId, expectedVersion: cursor.version, kind: "body", content: "Замена" }, "подмена", "edit_note")] }, "tool_calls")); await s.settle();
	expect(s.e.text).toBe(original + "\nСЕКРЕТНЫЙ_СОСЕД_71"); expect(s.e.transaction).not.toHaveBeenCalled();
	await s.view.onClose();
});

it.each(["перемещение", "удаление", "новый файл"])("вставка сохраняет идентичность: %s", async variant => {
	const response = deferred<Response>(), s = await start([response.promise]);
	s.input.value = "Вставь у курсора: Вставка."; s.send.click(); await vi.waitFor(() => expect(s.requests).toHaveLength(1));
	const cursor = targets(s).find((target: any) => target.kind === "cursor"); s.entries.delete(s.file.path);
	if (variant === "перемещение") { s.file.path = "Поездка.md"; s.file.basename = "Поездка"; s.entries.set(s.file.path, s.file); }
	if (variant === "новый файл") s.add("План.md", original);
	response.resolve(json({ tool_calls: [insert(cursor)] }, "tool_calls")); await s.settle();
	expect(s.e.transaction).toHaveBeenCalledTimes(variant === "перемещение" ? 1 : 0);
	if (variant === "перемещение") expect(s.root.getText()).toContain("[[Поездка.md]]");
	else expect(s.root.getText()).toContain(t("action-target-unavailable"));
	await s.view.onClose();
});

it.each(["успех", "правка", "другая заметка", "stop", "clear", "close", "unload"])("повторно проверяет цель вставки после открытия редактора: %s", async variant => {
	const response = deferred<Response>(), opening = deferred<void>(), s = await start([response.promise]);
	s.input.value = "Вставь у курсора: Вставка."; s.send.click(); await vi.waitFor(() => expect(s.requests).toHaveLength(1));
	const cursor = targets(s).find((target: any) => target.kind === "cursor");
	let leaves: Array<{ view: typeof s.e.view }> = [];
	s.view.app.workspace.getLeavesOfType = (() => leaves) as any;
	const leaf = { view: s.e.view, openFile: vi.fn(async () => { await opening.promise; leaves = [{ view: s.e.view }]; }) };
	s.view.app.workspace.getLeaf = vi.fn(() => leaf) as any;
	response.resolve(json({ tool_calls: [insert(cursor)] }, "tool_calls")); await vi.waitFor(() => expect(leaf.openFile).toHaveBeenCalled());
	if (variant === "правка") s.e.change(original + "\nРучная правка");
	if (variant === "другая заметка") s.e.view.file = s.add("Другая.md", original);
	if (variant === "stop") s.send.click();
	if (variant === "clear") s.root.find("ai-helper-clear-btn").click();
	if (variant === "close") await s.view.onClose();
	if (variant === "unload") Object.assign(s.plugin, { isUnloading: true });
	opening.resolve(); if (variant === "close") await flushPromises(); else await s.settle();
	expect(s.e.transaction).toHaveBeenCalledTimes(variant === "успех" ? 1 : 0);
	if (variant !== "close") await s.view.onClose();
});

it.each(["stop", "clear", "close", "unload"])("%s блокирует поздний ответ со вставкой", async variant => {
	const response = deferred<Response>(), s = await start([response.promise]);
	s.input.value = "Вставь у курсора: Вставка."; s.send.click(); await vi.waitFor(() => expect(s.requests).toHaveLength(1));
	const cursor = targets(s).find((target: any) => target.kind === "cursor");
	if (variant === "stop") s.send.click();
	if (variant === "clear") s.root.find("ai-helper-clear-btn").click();
	if (variant === "close") await s.view.onClose();
	if (variant === "unload") Object.assign(s.plugin, { isUnloading: true });
	response.resolve(json({ tool_calls: [insert(cursor)] }, "tool_calls")); await flushPromises();
	expect(s.e.text).toBe(original); expect(s.e.transaction).not.toHaveBeenCalled();
	if (variant !== "close") await s.view.onClose();
});

it("отдельно отменяет и повторяет вставку рядом с ручным вводом", async () => {
	const response = deferred<Response>(), s = await start([response.promise]); s.e.change(original + "\nМетка до");
	s.input.value = "Вставь у курсора: Вставка."; s.send.click(); await vi.waitFor(() => expect(s.requests).toHaveLength(1));
	response.resolve(json({ tool_calls: [insert(targets(s).find((target: any) => target.kind === "cursor"))] }, "tool_calls")); await s.settle();
	const inserted = "---\nстатус: черновик\n---\n# План\nДо. Вставка. После.\nКонец.\nМетка до";
	s.e.change(s.e.text + "\nМетка после");
	s.e.view.editor.undo(); expect(s.e.text).toBe(inserted);
	s.e.view.editor.undo(); expect(s.e.text).toBe(original + "\nМетка до");
	s.e.view.editor.redo(); expect(s.e.text).toBe(inserted);
	s.e.view.editor.redo(); expect(s.e.text).toBe(inserted + "\nМетка после"); await s.view.onClose();
});

it("не вставляет внутрь свойств и сообщает причину по-английски", async () => {
	const response = deferred<Response>(), s = await start([response.promise]); setLanguage("en");
	s.e.select({ line: 1, ch: 8 }, { line: 1, ch: 8 }); s.input.value = "Insert at cursor"; s.send.click();
	await vi.waitFor(() => expect(s.requests).toHaveLength(1));
	response.resolve(json({ tool_calls: [insert(targets(s).find((target: any) => target.kind === "cursor"))] }, "tool_calls")); await s.settle();
	expect(s.e.text).toBe(original); expect(s.root.getText()).toContain("Insertion cannot change note properties"); await s.view.onClose();
});

it("после конфликта старый курсор недоступен, новое явное место даёт свежую основу", async () => {
	const first = deferred<Response>(), stale = deferred<Response>(), fresh = deferred<Response>();
	const s = await start([first.promise, stale.promise, fresh.promise]);
	s.input.value = "Вставь у курсора: Вставка."; s.send.click(); await vi.waitFor(() => expect(s.requests).toHaveLength(1));
	const old = targets(s).find((target: any) => target.kind === "cursor"); s.e.change(original + "\nРучная правка");
	first.resolve(json({ tool_calls: [insert(old)] }, "tool_calls")); await s.settle();
	s.input.value = "Объясни конфликт"; s.send.click(); await vi.waitFor(() => expect(s.requests).toHaveLength(2));
	stale.resolve(json({ tool_calls: [insert(old)] }, "tool_calls")); await s.settle(); expect(s.e.transaction).not.toHaveBeenCalled();
	s.e.select({ line: 5, ch: 6 }, { line: 5, ch: 6 }); s.input.value = "Вставь у нового курсора: Вставка."; s.send.click();
	await vi.waitFor(() => expect(s.requests).toHaveLength(3)); const cursor = targets(s, 2).find((target: any) => target.kind === "cursor");
	expect(cursor.targetId).not.toBe(old.targetId);
	fresh.resolve(json({ tool_calls: [insert(cursor)] }, "tool_calls")); await s.settle();
	expect(s.e.text).toBe(original + " Вставка.\nРучная правка"); expect(s.e.transaction).toHaveBeenCalledTimes(1); await s.view.onClose();
});

it("использует прикреплённый фрагмент как материал, сохраняя оригинал и скрытых соседей", async () => {
	const response = deferred<Response>(), s = await start([response.promise]);
	const file = s.add("Источник.md", "СЕКРЕТ_ИСТОЧНИКА\nБилеты купить в четверг.\nНе передавать соседей"), source = editor(s, file);
	source.select({ line: 1, ch: 0 }, { line: 1, ch: 23 });
	s.view.app.workspace.getLeavesOfType = (() => [{ view: s.e.view }, { view: source.view }]) as any;
	Object.assign(s.plugin, { currentMarkdownView: source.view });
	attach(s, "Вставь перевод фрагмента @@ у курсора в Плане");
	Object.assign(s.plugin, { currentMarkdownView: s.e.view }); s.send.click(); await vi.waitFor(() => expect(s.requests).toHaveLength(1));
	expect(JSON.stringify(s.requests)).not.toContain("СЕКРЕТ_ИСТОЧНИКА");
	response.resolve(json({ tool_calls: [insert(targets(s).find((target: any) => target.kind === "cursor"), " Buy tickets Thursday.")] }, "tool_calls")); await s.settle();
	expect(s.e.text).toBe("---\nстатус: черновик\n---\n# План\nДо. Buy tickets Thursday. После.\nКонец.");
	expect(source.text).toBe("СЕКРЕТ_ИСТОЧНИКА\nБилеты купить в четверг.\nНе передавать соседей"); await s.view.onClose();
});

it("SSE-вставка ждёт полного вызова; повторная доставка не дублирует текст", async () => {
	let controller!: ReadableStreamDefaultController<Uint8Array>;
	const response = new Response(new ReadableStream({ start(value) { controller = value; } }), { headers: { "Content-Type": "text/event-stream" } });
	const duplicate = deferred<Response>(), s = await start([response, duplicate.promise]);
	s.input.value = "Вставь у курсора: Вставка."; s.send.click(); await vi.waitFor(() => expect(s.requests).toHaveLength(1));
	const write = insert(targets(s).find((target: any) => target.kind === "cursor"));
	const event = (delta: object, finish_reason: string | null = null) => controller.enqueue(new TextEncoder().encode(`data: ${JSON.stringify({ choices: [{ delta, finish_reason }] })}\n\n`));
	event({ tool_calls: [{ index: 0, id: write.id, type: "function", function: { name: "insert_note", arguments: write.function.arguments.slice(0, 25) } }] });
	await flushPromises(); expect(s.e.text).toBe(original);
	event({ tool_calls: [{ index: 0, function: { arguments: write.function.arguments.slice(25) } }] });
	await flushPromises(); expect(s.e.text).toBe(original);
	event({}, "tool_calls"); controller.close(); await vi.waitFor(() => expect(s.requests).toHaveLength(2));
	duplicate.resolve(json({ tool_calls: [write] }, "tool_calls")); await s.settle();
	expect(s.e.text).toBe("---\nстатус: черновик\n---\n# План\nДо. Вставка. После.\nКонец.");
	expect(s.e.transaction).toHaveBeenCalledTimes(1); await s.view.onClose();
});

it.each(["конфликт", "отмена"])("вставка в конец не затирает последующие изменения: %s", async variant => {
	const first = deferred<Response>(), second = deferred<Response>();
	const s = await start([first.promise, ...(variant === "отмена" ? [json({ content: "Готово." })] : []), second.promise]);
	attach(s, "Добавь в конец строку «Итог.» в @План"); s.send.click(); await vi.waitFor(() => expect(s.requests).toHaveLength(1));
	const whole = targets(s).find((target: any) => target.kind === "whole-note");
	if (variant === "конфликт") s.e.change(original + "\nРучное дополнение");
	first.resolve(json({ tool_calls: [insert(whole, "\nИтог.", "end")] }, "tool_calls")); await s.settle();
	if (variant === "конфликт") {
		expect(s.e.text).toBe(original + "\nРучное дополнение"); expect(s.e.transaction).not.toHaveBeenCalled();
	} else {
		const next = JSON.parse(s.requests[1].messages.at(-1).content); s.e.view.editor.undo();
		s.input.value = "Допиши в конец той же заметки ещё строку"; s.send.click(); await vi.waitFor(() => expect(s.requests).toHaveLength(3));
		second.resolve(json({ tool_calls: [insert(next, "\nВторой итог.", "end")] }, "tool_calls")); await s.settle();
		expect(s.e.text).toBe(original); expect(s.e.transaction).toHaveBeenCalledTimes(1);
	}
	expect(s.root.getText()).toContain(t("action-insert-conflict")); await s.view.onClose();
});

it.each(["\n", "\r\n"])("добавляет текст после YAML без конечного перевода строки, сохраняя свойства (%j)", async newline => {
	const response = deferred<Response>(), s = await start([response.promise]);
	const yaml = ["---", "статус: черновик", "---"].join(newline); s.e.change(yaml);
	s.e.select({ line: 2, ch: 3 }, { line: 2, ch: 3 });
	attach(s, "Добавь строку «Итог.» в конец @План"); s.send.click(); await vi.waitFor(() => expect(s.requests).toHaveLength(1));
	response.resolve(json({ tool_calls: [insert(targets(s).find((target: any) => target.kind === "whole-note"), newline + "Итог.", "end")] }, "tool_calls")); await s.settle();
	expect(s.e.text).toBe(yaml + newline + "Итог.");
	s.e.view.editor.undo(); expect(s.e.text).toBe(yaml); await s.view.onClose();
});
