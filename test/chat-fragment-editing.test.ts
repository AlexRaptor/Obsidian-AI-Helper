import { EditorState } from "@codemirror/state";
import { afterEach, expect, it, vi } from "vitest";
import { setup, json, call } from "./helpers/chat-note-actions";
import { editor } from "./helpers/chat-note-editor";
import { deferred, flushPromises } from "./helpers/obsidian";
import { t } from "../src/i18n";

vi.mock("obsidian", async () => import("./helpers/obsidian"));
afterEach(() => { vi.restoreAllMocks(); });
const original = "---\nстатус: черновик\n---\n# План\nСОСЕДНИЙ_СЕКРЕТ_70\nДо: выбранный текст. Хвост\nДубликат: выбранный текст.\nНижняя граница";
const changed = "---\nстатус: черновик\n---\n# План\nСОСЕДНИЙ_СЕКРЕТ_70\nДо: Новый фрагмент. Хвост\nДубликат: выбранный текст.\nНижняя граница";
async function start(responses: Array<Response | Promise<Response>>) {
	const s = await setup(responses), file = s.add("План.md", original), e = editor(s, file);
	e.select({ line: 5, ch: 4 }, { line: 5, ch: 19 });
	s.view.app.workspace.getLeavesOfType = (() => [{ view: e.view }]) as any;
	s.view.app.workspace.getActiveViewOfType = (() => e.view) as any;
	return { ...s, file, e };
}
type Setup = Awaited<ReturnType<typeof start>>;
function attach(s: Setup, prompt = "Замени прикреплённый фрагмент короткой фразой @@") {
	s.input.value = prompt; s.input.dispatchEvent({ type: "input", inputType: "insertText" } as any); s.input.keydown("Tab");
}
function target(s: Setup, index = 0, attachment = 0) {
	return JSON.parse(s.requests[index].messages.findLast((m: any) => m.role === "user").content.split("Note attachments (context data):\n")[1])[attachment];
}
function replace(snapshot: { targetId: string; version: string }, content = "Новый фрагмент") {
	return call({ targetId: snapshot.targetId, expectedVersion: snapshot.version, kind: "fragment", content }, "правка-фрагмента", "edit_note");
}
it("заменяет только прикреплённый диапазон, сохраняя YAML, соседний и одинаковый текст", async () => {
	const response = deferred<Response>(), s = await start([response.promise]);
	attach(s); s.send.click(); await vi.waitFor(() => expect(s.requests).toHaveLength(1));
	expect(target(s).markdown).toBe("выбранный текст");
	expect(JSON.stringify(s.requests)).not.toContain("СОСЕДНИЙ_СЕКРЕТ_70");
	response.resolve(json({ tool_calls: [replace(target(s))] }, "tool_calls")); await s.settle();
	expect(s.e.text).toBe(changed); expect(s.e.transaction).toHaveBeenCalledTimes(1);
	expect(JSON.stringify(s.requests)).not.toContain("СОСЕДНИЙ_СЕКРЕТ_70");
	expect(JSON.stringify(s.view.getMessages())).not.toContain("СОСЕДНИЙ_СЕКРЕТ_70");
	await s.view.onClose();
});

it.each(["до отправки", "во время генерации", "выше диапазона", "YAML"])("изменение всей основы вызывает конфликт: %s", async variant => {
	const response = deferred<Response>(), s = await start([response.promise]); attach(s);
	const text = variant === "YAML" ? original.replace("черновик", "готово") : variant === "выше диапазона" ? "Новая строка\n" + original : original + "\nРучная правка в конце";
	if (variant === "до отправки") s.e.change(text);
	s.send.click(); await vi.waitFor(() => expect(s.requests).toHaveLength(1));
	if (variant !== "до отправки") s.e.change(text);
	response.resolve(json({ tool_calls: [replace(target(s))] }, "tool_calls")); await s.settle();
	expect(s.e.text).toBe(text); expect(s.e.transaction).not.toHaveBeenCalled();
	expect(s.root.getText()).toContain(t("action-fragment-conflict")); expect(s.requests).toHaveLength(1);
	await s.ask("Обсудим причину конфликта");
	expect(s.requests[1].tools.map((tool: any) => tool.function.name)).not.toContain("read_note");
	await s.view.onClose();
});

it("фиксирует локальную полную основу при подтверждении @@, а не при показе предложения", async () => {
	const response = deferred<Response>(), s = await start([response.promise]);
	s.input.value = "Замени фрагмент @@"; s.input.dispatchEvent({ type: "input", inputType: "insertText" } as any);
	s.e.change(original + "\nДополнение до подтверждения");
	s.input.keydown("Tab"); s.send.click(); await vi.waitFor(() => expect(s.requests).toHaveLength(1));
	response.resolve(json({ tool_calls: [replace(target(s))] }, "tool_calls")); await s.settle();
	expect(s.e.text).toBe(changed + "\nДополнение до подтверждения"); expect(s.e.transaction).toHaveBeenCalledTimes(1);
	expect(JSON.stringify(s.requests)).not.toContain("Дополнение до подтверждения");
	await s.view.onClose();
});

it("последующая смена выделения не меняет прикреплённую цель", async () => {
	const response = deferred<Response>(), s = await start([response.promise]); attach(s);
	s.e.select({ line: 6, ch: 10 }, { line: 6, ch: 25 });
	s.send.click(); await vi.waitFor(() => expect(s.requests).toHaveLength(1));
	response.resolve(json({ tool_calls: [replace(target(s))] }, "tool_calls")); await s.settle();
	expect(s.e.text).toBe(changed);
	await s.view.onClose();
});

it("выделение без явного прикрепления не объявляет инструмент редактирования", async () => {
	const s = await start([json({ content: "Прикрепите нужный фрагмент через @@." })]);
	await s.ask("Замени выделенный фрагмент");
	expect(s.requests[0].tools.map((tool: any) => tool.function.name)).toEqual(["create_note", "export_chat"]);
	expect(s.e.transaction).not.toHaveBeenCalled(); await s.view.onClose();
});

it.each(["координаты", "путь", "целая заметка", "свойства", "чтение полной заметки"])("фрагмент не расширяет права: %s", async variant => {
	const response = deferred<Response>(), s = await start([response.promise]); attach(s); s.send.click();
	await vi.waitFor(() => expect(s.requests).toHaveLength(1));
	const args = { targetId: target(s).targetId, expectedVersion: target(s).version, kind: "fragment", content: "Новый текст" };
	const invalid = variant === "координаты" ? { ...args, from: { line: 0, ch: 0 }, to: { line: 7, ch: 10 } }
		: variant === "путь" ? { ...args, path: "Другая.md" } : variant === "целая заметка" ? { ...args, kind: "body" }
		: variant === "свойства" ? { ...args, kind: "properties" } : { targetId: args.targetId };
	response.resolve(json({ tool_calls: [call(invalid, "неверный-вызов", variant === "чтение полной заметки" ? "read_note" : "edit_note")] }, "tool_calls")); await s.settle();
	expect(s.e.text).toBe(original); expect(s.e.transaction).not.toHaveBeenCalled(); expect(s.requests).toHaveLength(1);
	await s.view.onClose();
});

it("цель из истории правится по прежнему прикреплению, затем по новому диапазону результата", async () => {
	const first = deferred<Response>(), second = deferred<Response>();
	const s = await start([json({ content: "Обсудим фрагмент." }), first.promise, json({ content: "Заменено." }), second.promise]);
	attach(s, "Обсудим @@"); s.send.click(); await s.settle();
	const initial = { ...s.view.getMessages()[0].snapshots![0] };
	s.input.value = "Замени тот фрагмент на две строки"; s.send.click(); await vi.waitFor(() => expect(s.requests).toHaveLength(2));
	first.resolve(json({ tool_calls: [replace(target(s), "Первая строка\nВторая")] }, "tool_calls")); await s.settle();
	const result = JSON.parse(s.requests[2].messages.at(-1).content);
	s.input.value = "Замени полученный фрагмент короткой фразой"; s.send.click(); await vi.waitFor(() => expect(s.requests).toHaveLength(4));
	second.resolve(json({ tool_calls: [replace(result)] }, "tool_calls")); await s.settle();
	expect(s.e.text).toBe(changed); expect(s.e.transaction).toHaveBeenCalledTimes(2);
	expect(s.view.getMessages()[0].snapshots![0]).toEqual(initial);
	expect(JSON.stringify(s.requests)).not.toContain("СОСЕДНИЙ_СЕКРЕТ_70"); await s.view.onClose();
});

it("не переносит другой старый диапазон после собственной правки; новое прикрепление даёт новую основу", async () => {
	const first = deferred<Response>(), second = deferred<Response>(), third = deferred<Response>();
	const s = await start([first.promise, json({ content: "Первый изменён." }), second.promise, third.promise]);
	attach(s); s.e.select({ line: 6, ch: 10 }, { line: 6, ch: 25 });
	s.input.createSpan({ text: " и @@" }); s.input.dispatchEvent({ type: "input", inputType: "insertText" } as any); s.input.keydown("Tab");
	s.send.click(); await vi.waitFor(() => expect(s.requests).toHaveLength(1)); const other = { ...target(s, 0, 1) };
	first.resolve(json({ tool_calls: [replace(target(s))] }, "tool_calls")); await s.settle();
	s.input.value = "Теперь замени второй прежний фрагмент"; s.send.click(); await vi.waitFor(() => expect(s.requests).toHaveLength(3));
	second.resolve(json({ tool_calls: [replace(other, "Старый второй")] }, "tool_calls")); await s.settle();
	expect(s.e.text).toBe(changed); expect(s.e.transaction).toHaveBeenCalledTimes(1);
	expect(s.root.getText()).toContain(t("action-fragment-conflict"));
	attach(s, "Заменить заново прикреплённый @@"); s.send.click(); await vi.waitFor(() => expect(s.requests).toHaveLength(4));
	expect(target(s, 3).targetId).not.toBe(other.targetId);
	third.resolve(json({ tool_calls: [replace(target(s, 3), "Новый второй")] }, "tool_calls")); await s.settle();
	expect(s.e.text).toBe("---\nстатус: черновик\n---\n# План\nСОСЕДНИЙ_СЕКРЕТ_70\nДо: Новый фрагмент. Хвост\nДубликат: Новый второй.\nНижняя граница");
	expect(s.e.transaction).toHaveBeenCalledTimes(2); await s.view.onClose();
});

it.each(["перемещение", "удаление", "новый файл по старому пути"])("идентичность прикреплённого фрагмента: %s", async variant => {
	const response = deferred<Response>(), s = await start([response.promise]); attach(s);
	s.send.click(); await vi.waitFor(() => expect(s.requests).toHaveLength(1));
	s.entries.delete("План.md");
	if (variant === "перемещение") { s.file.path = "Проекты/Поездка.md"; s.file.basename = "Поездка"; s.entries.set(s.file.path, s.file); }
	if (variant === "новый файл по старому пути") s.add("План.md", original);
	response.resolve(json({ tool_calls: [replace(target(s))] }, "tool_calls")); await s.settle();
	expect(s.e.transaction).toHaveBeenCalledTimes(variant === "перемещение" ? 1 : 0);
	if (variant === "перемещение") expect(s.root.getText()).toContain("[[Проекты/Поездка.md]]");
	else expect(s.root.getText()).toContain(t("action-target-unavailable"));
	await s.view.onClose();
});

it("создание новой заметки по фрагменту не меняет его оригинал и не раскрывает соседей", async () => {
	const s = await start([json({ tool_calls: [call({ title: "Из фрагмента", content: "Текст на основе выбранного фрагмента" })] }, "tool_calls")]);
	attach(s, "Создай новую заметку по @@"); s.send.click(); await s.settle();
	expect(s.texts.get("Входящие/Из фрагмента.md")).toBe("Текст на основе выбранного фрагмента");
	expect(s.e.text).toBe(original); expect(s.e.transaction).not.toHaveBeenCalled();
	expect(JSON.stringify(s.requests)).not.toContain("СОСЕДНИЙ_СЕКРЕТ_70"); await s.view.onClose();
});

it.each(["успех", "текст вне диапазона", "YAML", "новый файл", "другое представление", "stop", "clear", "close", "unload"])("проверяет закрытый редактор после открытия: %s", async variant => {
	const response = deferred<Response>(), opening = deferred<void>(), s = await start([response.promise]); attach(s);
	s.send.click(); await vi.waitFor(() => expect(s.requests).toHaveLength(1));
	let leaves: Array<{ view: typeof s.e.view }> = [];
	s.view.app.workspace.getLeavesOfType = (() => leaves) as any;
	const leaf = { view: s.e.view, openFile: vi.fn(async (file: typeof s.file) => { expect(file).toBe(s.file); await opening.promise; leaves = [{ view: s.e.view }]; }) };
	s.view.app.workspace.getLeaf = vi.fn(() => leaf) as any;
	response.resolve(json({ tool_calls: [replace(target(s))] }, "tool_calls")); await vi.waitFor(() => expect(leaf.openFile).toHaveBeenCalledTimes(1));
	if (variant === "текст вне диапазона") s.e.change(original + "\nРучная правка");
	if (variant === "YAML") s.e.change(original.replace("черновик", "готово"));
	if (variant === "новый файл") s.add("План.md", original);
	if (variant === "другое представление") s.e.view.file = s.add("Другая.md", original);
	if (variant === "stop") s.send.click();
	if (variant === "clear") s.root.find("ai-helper-clear-btn").click();
	if (variant === "close") await s.view.onClose();
	if (variant === "unload") Object.assign(s.plugin, { isUnloading: true });
	opening.resolve(); if (variant !== "close") await s.settle(); else await flushPromises();
	expect(s.e.transaction).toHaveBeenCalledTimes(variant === "успех" ? 1 : 0);
	if (variant !== "close") await s.view.onClose();
});

it.each(["stop", "clear", "close", "unload"])("%s запрещает поздний ответ с заменой фрагмента", async mode => {
	const response = deferred<Response>(), s = await start([response.promise]); attach(s);
	s.send.click(); await vi.waitFor(() => expect(s.requests).toHaveLength(1)); const write = replace(target(s));
	if (mode === "stop") s.send.click();
	if (mode === "clear") s.root.find("ai-helper-clear-btn").click();
	if (mode === "close") await s.view.onClose();
	if (mode === "unload") Object.assign(s.plugin, { isUnloading: true });
	response.resolve(json({ tool_calls: [write] }, "tool_calls")); await flushPromises();
	expect(s.e.text).toBe(original); expect(s.e.transaction).not.toHaveBeenCalled();
	if (mode !== "close") await s.view.onClose();
});

it("обратное многострочное выделение с концом в начале строки сохраняет точные границы", async () => {
	const first = deferred<Response>(), second = deferred<Response>(), s = await start([first.promise, json({ content: "Готово." }), second.promise]);
	s.e.select({ line: 7, ch: 0 }, { line: 5, ch: 4 }); attach(s); s.send.click(); await vi.waitFor(() => expect(s.requests).toHaveLength(1));
	expect(target(s).markdown).toBe("выбранный текст. Хвост\nДубликат: выбранный текст.\n");
	first.resolve(json({ tool_calls: [replace(target(s), "Строка один\nСтрока два\n")] }, "tool_calls")); await s.settle();
	expect(s.e.text).toBe("---\nстатус: черновик\n---\n# План\nСОСЕДНИЙ_СЕКРЕТ_70\nДо: Строка один\nСтрока два\nНижняя граница");
	const next = JSON.parse(s.requests[1].messages.at(-1).content);
	s.input.value = "Сократи полученный фрагмент"; s.send.click(); await vi.waitFor(() => expect(s.requests).toHaveLength(3));
	second.resolve(json({ tool_calls: [replace(next, "Итог.\n")] }, "tool_calls")); await s.settle();
	expect(s.e.text).toBe("---\nстатус: черновик\n---\n# План\nСОСЕДНИЙ_СЕКРЕТ_70\nДо: Итог.\nНижняя граница");
	await s.view.onClose();
});

it("каждая замена фрагмента отдельно отменяется и повторяется в истории CodeMirror рядом с ручным вводом", async () => {
	const response = deferred<Response>(), s = await start([response.promise]); s.e.change(original + "\nРучная метка до");
	attach(s); s.send.click(); await vi.waitFor(() => expect(s.requests).toHaveLength(1));
	response.resolve(json({ tool_calls: [replace(target(s))] }, "tool_calls")); await s.settle();
	s.e.change(s.e.text + "\nРучная метка после");
	s.e.view.editor.undo(); expect(s.e.text).toBe(changed + "\nРучная метка до");
	s.e.view.editor.undo(); expect(s.e.text).toBe(original + "\nРучная метка до");
	s.e.view.editor.undo(); expect(s.e.text).toBe(original);
	s.e.view.editor.redo(); expect(s.e.text).toBe(original + "\nРучная метка до");
	s.e.view.editor.redo(); expect(s.e.text).toBe(changed + "\nРучная метка до");
	s.e.view.editor.redo(); expect(s.e.text).toBe(changed + "\nРучная метка до\nРучная метка после");
	await s.view.onClose();
});

it("повторная доставка не выполняет вторую транзакцию замены", async () => {
	const first = deferred<Response>(), duplicate = deferred<Response>(), s = await start([first.promise, duplicate.promise]);
	attach(s); s.send.click(); await vi.waitFor(() => expect(s.requests).toHaveLength(1)); const write = replace(target(s));
	first.resolve(json({ tool_calls: [write] }, "tool_calls")); await vi.waitFor(() => expect(s.requests).toHaveLength(2));
	duplicate.resolve(json({ tool_calls: [write] }, "tool_calls")); await s.settle();
	expect(s.e.text).toBe(changed); expect(s.e.transaction).toHaveBeenCalledTimes(1); await s.view.onClose();
});

it("новая версия сохраняется при сбое финального ответа; ручная отмена вызывает конфликт следующей правки", async () => {
	const first = deferred<Response>(), second = deferred<Response>(), s = await start([first.promise, new Response("Ошибка", { status: 500 }), second.promise]);
	attach(s); s.send.click(); await vi.waitFor(() => expect(s.requests).toHaveLength(1));
	first.resolve(json({ tool_calls: [replace(target(s))] }, "tool_calls")); await s.settle();
	const next = JSON.parse(s.requests[1].messages.at(-1).content);
	expect(s.root.getText()).toContain("Изменена заметка: [[План.md]]"); s.e.view.editor.undo();
	s.input.value = "Снова замени результат"; s.send.click(); await vi.waitFor(() => expect(s.requests).toHaveLength(3));
	second.resolve(json({ tool_calls: [replace(next)] }, "tool_calls")); await s.settle();
	expect(s.e.text).toBe(original); expect(s.e.transaction).toHaveBeenCalledTimes(1);
	expect(s.root.getText()).toContain(t("action-fragment-conflict")); await s.view.onClose();
});

it("не позволяет менять свойства даже при выделении текста внутри YAML", async () => {
	const response = deferred<Response>(), s = await start([response.promise]);
	s.e.select({ line: 1, ch: 8 }, { line: 1, ch: 16 }); attach(s); s.send.click(); await vi.waitFor(() => expect(s.requests).toHaveLength(1));
	response.resolve(json({ tool_calls: [replace(target(s), "готово")] }, "tool_calls")); await s.settle();
	expect(s.e.text).toBe(original); expect(s.e.transaction).not.toHaveBeenCalled();
	expect(s.root.getText()).toContain(t("action-fragment-properties")); await s.view.onClose();
});

it("повтор одинакового прикрепления после конфликта даёт новую основу, не изменяя прежний снимок", async () => {
	const first = deferred<Response>(), second = deferred<Response>(), s = await start([first.promise, second.promise]);
	attach(s); s.send.click(); await vi.waitFor(() => expect(s.requests).toHaveLength(1)); const old = { ...target(s) };
	s.e.change(original + "\nНовая нижняя строка");
	first.resolve(json({ tool_calls: [replace(old)] }, "tool_calls")); await s.settle();
	attach(s, "Возьми заново прикреплённый фрагмент @@"); s.send.click(); await vi.waitFor(() => expect(s.requests).toHaveLength(2));
	expect(target(s, 1).targetId).not.toBe(old.targetId);
	second.resolve(json({ tool_calls: [replace(target(s, 1))] }, "tool_calls")); await s.settle();
	expect(s.e.text).toBe(changed + "\nНовая нижняя строка"); expect(s.view.getMessages()[0].snapshots![0]).toEqual(old);
	await s.view.onClose();
});

it("новое прикрепление рядом с восстановленным старым упоминанием не теряет новую основу", async () => {
	const first = deferred<Response>(), second = deferred<Response>(), s = await start([first.promise, second.promise]);
	attach(s); s.send.click(); await vi.waitFor(() => expect(s.requests).toHaveLength(1));
	s.e.change(original + "\nДополнение вне выделения");
	first.resolve(json({ tool_calls: [replace(target(s))] }, "tool_calls")); await s.settle();
	// The failed draft, including its old mention, is restored by ChatView.
	s.input.createSpan({ text: " Используй новый фрагмент @@" }); s.input.dispatchEvent({ type: "input", inputType: "insertText" } as any); s.input.keydown("Tab");
	s.send.click(); await vi.waitFor(() => expect(s.requests).toHaveLength(2));
	const fresh = target(s, 1, 1); expect(fresh).toBeDefined(); expect(fresh.targetId).not.toBe(target(s).targetId);
	second.resolve(json({ tool_calls: [replace(fresh)] }, "tool_calls")); await s.settle();
	expect(s.e.text).toBe(changed + "\nДополнение вне выделения"); expect(s.e.transaction).toHaveBeenCalledTimes(1);
	expect(JSON.stringify(s.requests)).not.toContain("Дополнение вне выделения"); await s.view.onClose();
});

it("при расходящихся редакторах требует заново прикрепить фрагмент", async () => {
	const response = deferred<Response>(), s = await start([response.promise]); attach(s); s.send.click();
	await vi.waitFor(() => expect(s.requests).toHaveLength(1));
	const other = editor(s, s.file, original + "\nДругая редакторская версия");
	s.view.app.workspace.getLeavesOfType = (() => [{ view: s.e.view }, { view: other.view }]) as any;
	response.resolve(json({ tool_calls: [replace(target(s))] }, "tool_calls")); await s.settle();
	expect(s.e.transaction).not.toHaveBeenCalled(); expect(other.transaction).not.toHaveBeenCalled();
	expect(s.root.getText()).toContain("Затем заново выделите и прикрепите фрагмент"); await s.view.onClose();
});

it("потоковые части замены применяются только после полного вызова", async () => {
	let controller!: ReadableStreamDefaultController<Uint8Array>;
	const stream = new Response(new ReadableStream({ start(value) { controller = value; } }), { headers: { "Content-Type": "text/event-stream" } });
	const s = await start([stream]); attach(s); s.send.click(); await vi.waitFor(() => expect(s.requests).toHaveLength(1));
	const args = JSON.stringify({ targetId: target(s).targetId, expectedVersion: target(s).version, kind: "fragment", content: "Новый фрагмент" });
	const event = (delta: object, finish_reason: string | null = null) => controller.enqueue(new TextEncoder().encode(`data: ${JSON.stringify({ choices: [{ delta, finish_reason }] })}\n\n`));
	event({ tool_calls: [{ index: 0, id: "поток-фрагмента", type: "function", function: { name: "edit_note", arguments: args.slice(0, 30) } }] });
	await flushPromises(); expect(s.e.transaction).not.toHaveBeenCalled();
	event({ tool_calls: [{ index: 0, type: "function", function: { arguments: args.slice(30) } }] });
	await flushPromises(); expect(s.e.transaction).not.toHaveBeenCalled();
	event({}, "tool_calls"); controller.close(); await s.settle();
	expect(s.e.text).toBe(changed); expect(s.e.transaction).toHaveBeenCalledTimes(1); await s.view.onClose();
});

it("объясняет конфликт фрагмента на английском", async () => {
	const response = deferred<Response>(), s = await start([response.promise]);
	const { setLanguage } = await import("../src/i18n"); setLanguage("en");
	attach(s); s.send.click(); await vi.waitFor(() => expect(s.requests).toHaveLength(1));
	s.e.change(original + "\nРучная правка"); response.resolve(json({ tool_calls: [replace(target(s))] }, "tool_calls")); await s.settle();
	expect(s.root.getText()).toContain("Select and attach the fragment again"); expect(s.e.transaction).not.toHaveBeenCalled(); await s.view.onClose();
});

it("не расширяет новую цель, если синхронный фильтр редактора изменил соседний текст", async () => {
	const first = deferred<Response>(), second = deferred<Response>(), s = await start([first.promise, json({ content: "Применено." }), second.promise]);
	const e = editor(s, s.file, original, [EditorState.transactionFilter.of(tx => tx.isUserEvent("ai-helper.note-edit")
		? [tx, { changes: { from: tx.newDoc.length, insert: "!" }, sequential: true }] : tx)]);
	s.e = e; e.select({ line: 5, ch: 4 }, { line: 5, ch: 19 });
	s.view.app.workspace.getLeavesOfType = (() => [{ view: e.view }]) as any;
	s.view.app.workspace.getActiveViewOfType = (() => e.view) as any;
	attach(s); s.send.click(); await vi.waitFor(() => expect(s.requests).toHaveLength(1));
	first.resolve(json({ tool_calls: [replace(target(s))] }, "tool_calls")); await s.settle();
	expect(s.e.text).toBe(changed + "!"); const result = JSON.parse(s.requests[1].messages.at(-1).content);
	s.input.value = "Продолжи править полученный фрагмент"; s.send.click(); await vi.waitFor(() => expect(s.requests).toHaveLength(3));
	second.resolve(json({ tool_calls: [replace(result, "Итог")] }, "tool_calls")); await s.settle();
	expect(s.e.text).toBe(changed + "!"); expect(s.e.transaction).toHaveBeenCalledTimes(1);
	expect(result.requiresReattachment).toBe(true);
	expect(s.root.getText()).toContain("Редактор изменил текст за пределами фрагмента");
	expect(JSON.stringify(s.requests)).not.toContain("СОСЕДНИЙ_СЕКРЕТ_70"); await s.view.onClose();
});

it("сохраняет восстановление ранее явно прикреплённой целой заметки после правки её фрагмента", async () => {
	const fragment = deferred<Response>(), whole = deferred<Response>(), refresh = deferred<Response>();
	const s = await start([json({ content: "Обсудим целую заметку." }), fragment.promise, json({ content: "Изменено." }), whole.promise, refresh.promise]);
	s.input.value = "Обсудим @План"; s.input.dispatchEvent({ type: "input", inputType: "insertText" } as any); s.input.keydown("Tab");
	s.send.click(); await s.settle(); const oldWhole = { ...target(s) };
	attach(s); s.send.click(); await vi.waitFor(() => expect(s.requests).toHaveLength(2));
	fragment.resolve(json({ tool_calls: [replace(target(s, 1))] }, "tool_calls")); await s.settle();
	s.input.value = "Измени всю ранее прикреплённую заметку"; s.send.click(); await vi.waitFor(() => expect(s.requests).toHaveLength(4));
	whole.resolve(json({ tool_calls: [call({ targetId: oldWhole.targetId, expectedVersion: oldWhole.version, kind: "body", content: "Новый полный текст" }, "целиком", "edit_note")] }, "tool_calls")); await s.settle();
	s.input.value = "Возьми актуальную версию ранее прикреплённой целой заметки"; s.send.click(); await vi.waitFor(() => expect(s.requests).toHaveLength(5));
	expect(s.requests[4].tools.map((tool: any) => tool.function.name)).toContain("read_note");
	refresh.resolve(json({ tool_calls: [call({ targetId: oldWhole.targetId }, "перечитывание", "read_note")] }, "tool_calls")); await s.settle();
	expect(JSON.parse(s.requests[5].messages.at(-1).content).markdown).toBe(changed);
	expect(s.e.transaction).toHaveBeenCalledTimes(1); await s.view.onClose();
});
