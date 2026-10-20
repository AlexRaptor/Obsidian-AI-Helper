import { afterEach, expect, it, vi } from "vitest";
import { setup, json, call } from "./helpers/chat-note-actions";
import { editor } from "./helpers/chat-note-editor";
import { deferred, flushPromises } from "./helpers/obsidian";
import { t } from "../src/i18n";
vi.mock("obsidian", async () => import("./helpers/obsidian"));
afterEach(() => { vi.restoreAllMocks(); });

it("сохраняет полный вариант и заменяет только прикреплённый фрагмент одним поручением", async () => {
	const response = deferred<Response>();
	const s = await setup([response.promise]);
	const file = s.add("План.md", "До\nДлинное описание поездки\nПосле"), e = editor(s, file);
	e.select({ line: 1, ch: 0 }, { line: 1, ch: 24 });
	s.view.app.workspace.getLeavesOfType = (() => [{ view: e.view }]) as any;
	s.view.app.workspace.getActiveViewOfType = (() => e.view) as any;
	s.input.value = "Сохрани полный вариант и сократи этот фрагмент @@";
	s.input.dispatchEvent({ type: "input", inputType: "insertText" } as any); s.input.keydown("Tab"); s.send.click();
	await vi.waitFor(() => expect(s.requests).toHaveLength(1));
	const snapshot = JSON.parse(s.requests[0].messages.at(-1).content.split("Note attachments (context data):\n")[1])[0];
	response.resolve(json({ tool_calls: [call({ title: "Полный вариант", content: snapshot.markdown }),
		call({ targetId: snapshot.targetId, expectedVersion: snapshot.version, kind: "fragment", content: "Поездка" }, "правка", "edit_note")] }, "tool_calls"));
	await s.settle();
	expect(s.texts.get("Входящие/Полный вариант.md")).toBe("Длинное описание поездки");
	expect(e.text).toBe("До\nПоездка\nПосле");
	expect(s.root.getText()).toContain("Создана заметка:"); expect(s.root.getText()).toContain("Изменена заметка:");
	expect(s.view.getMessages().filter(m => m.role === "user")).toHaveLength(1);
	await s.view.onClose();
});

it("проверяет структуру всего набора до первой записи", async () => {
	const s = await setup([json({ tool_calls: [call(), call({ title: "Вторая", content: 42 }, "2")] }, "tool_calls")]);
	await s.ask("Создай две заметки");
	expect(s.create).not.toHaveBeenCalled(); expect(s.texts.size).toBe(0);
	expect(s.root.getText()).toContain(t("action-invalid"));
	await s.view.onClose();
});

it("останавливает независимые шаги после сбоя и при повторе не дублирует успешное создание с новым ID", async () => {
	const first = call({ title: "Первая", content: "Первый результат" }, "1");
	const second = call({ title: "Вторая", content: "Второй результат", folder: "Занято" }, "2");
	const third = call({ title: "Третья", content: "Третий результат" }, "3");
	const s = await setup([json({ tool_calls: [first, second, third] }, "tool_calls"),
		json({ tool_calls: [{ ...first, id: "новый-1" }, { ...second, id: "новый-2" }, { ...third, id: "новый-3" }] }, "tool_calls")]);
	s.add("Занято", "Файл вместо папки");
	await s.ask("Создай три заметки последовательно");
	expect(s.texts.has("Входящие/Первая.md")).toBe(true);
	expect(s.texts.has("Входящие/Третья.md")).toBe(false);
	expect(s.root.getText()).toContain(t("action-not-executed"));
	s.entries.delete("Занято"); s.texts.delete("Занято");
	await s.ask("Попробуй ещё раз");
	expect(s.texts.get("Занято/Вторая.md")).toBe("Второй результат");
	expect(s.texts.get("Входящие/Третья.md")).toBe("Третий результат");
	expect([...s.texts.keys()].filter(path => path.includes("Первая"))).toEqual(["Входящие/Первая.md"]);
	expect(s.create).toHaveBeenCalledTimes(3);
	await s.view.onClose();
});

it("устаревший после собственной правки вызов требует подготовки от фактического результата", async () => {
	const response = deferred<Response>(), continuation = deferred<Response>();
	const s = await setup([response.promise, continuation.promise]);
	const file = s.add("План.md", "Исходный план"), e = editor(s, file);
	s.view.app.workspace.getLeavesOfType = (() => [{ view: e.view }]) as any;
	s.input.value = "Сократи @План";
	s.input.dispatchEvent({ type: "input", inputType: "insertText" } as any); s.input.keydown("Tab"); s.send.click();
	await vi.waitFor(() => expect(s.requests).toHaveLength(1));
	const snapshot = JSON.parse(s.requests[0].messages.at(-1).content.split("Note attachments (context data):\n")[1])[0];
	const edit = call({ targetId: snapshot.targetId, expectedVersion: snapshot.version, kind: "body", content: "Краткий план" }, "1", "edit_note");
	const insert = call({ targetId: snapshot.targetId, expectedVersion: snapshot.version, kind: "end", content: "\nПроверено" }, "2", "insert_note");
	response.resolve(json({ tool_calls: [edit, insert] }, "tool_calls"));
	await vi.waitFor(() => expect(s.requests).toHaveLength(2));
	expect(e.text).toBe("Краткий план");
	const result = JSON.parse(s.requests[1].messages.find((m: any) => m.role === "tool").content);
	continuation.resolve(json({ tool_calls: [call({ targetId: result.targetId, expectedVersion: result.version, kind: "end", content: "\nПроверено" }, "3", "insert_note")] }, "tool_calls"));
	await s.settle();
	expect(e.text).toBe("Краткий план\nПроверено");
	expect(s.view.getMessages()[0].snapshots![0].markdown).toBe("Исходный план");
	await s.view.onClose();
});

it("проверяет записанный файл при неизвестном исходе и не создаёт дубликат при повторе", async () => {
	const s = await setup([json({ tool_calls: [call()] }, "tool_calls"), json({ tool_calls: [call(undefined, "повтор")] }, "tool_calls")]);
	s.create.mockImplementationOnce(async (path, content) => { s.add(path, content); throw new Error("Связь с адаптером потеряна после записи"); });
	const read = vi.spyOn(s.vault, "read").mockRejectedValueOnce(new Error("Чтение временно недоступно"));
	await s.ask("Создай заметку");
	expect(s.create).toHaveBeenCalledTimes(1); expect(s.requests).toHaveLength(1);
	await s.ask("Попробуй ещё раз");
	expect(read).toHaveBeenCalledTimes(2); expect(s.create).toHaveBeenCalledTimes(1);
	expect(s.root.getText()).toContain("Создана заметка: [[Входящие/Решение.md]]");
	await s.view.onClose();
});

it("не повторяет запись, пока связанный файл не подтверждает ожидаемый результат", async () => {
	const s = await setup([json({ tool_calls: [call()] }, "tool_calls"), json({ tool_calls: [call(undefined, "повтор")] }, "tool_calls")]);
	s.create.mockImplementationOnce(async path => { s.add(path, "Другой текст"); throw new Error("Неизвестный исход"); });
	await s.ask("Создай заметку"); await s.ask("Попробуй ещё раз");
	expect(s.create).toHaveBeenCalledTimes(1); expect(s.texts.size).toBe(1);
	expect(s.root.getText()).toContain(t("action-unknown"));
	await s.view.onClose();
});

it("учитывает начавшуюся запись после остановки и не запускает оставшиеся шаги", async () => {
	const s = await setup([json({ tool_calls: [call(), call({ title: "Вторая", content: "Не записывать" }, "2")] }, "tool_calls")]);
	const writing = deferred<void>();
	s.create.mockImplementationOnce(async (path, content) => { await writing.promise; return s.add(path, content); });
	s.input.value = "Создай две заметки"; s.send.click();
	await vi.waitFor(() => expect(s.create).toHaveBeenCalledTimes(1));
	s.send.click(); writing.resolve(); await flushPromises();
	expect(s.texts.size).toBe(1); expect(s.create).toHaveBeenCalledTimes(1); expect(s.requests).toHaveLength(1);
	expect(s.root.getText()).toContain("[[Входящие/Решение.md]]");
	expect(s.root.getText()).toContain(t("action-not-executed"));
	await s.view.onClose();
});

it("новое явное поручение разрешает создать ещё одну такую же заметку", async () => {
	const s = await setup([json({ tool_calls: [call()] }, "tool_calls"), json({ content: "Готово" }), json({ tool_calls: [call()] }, "tool_calls")]);
	await s.ask("Создай заметку"); await s.ask("Создай ещё одну такую же заметку");
	expect(s.texts.has("Входящие/Решение (2).md")).toBe(true);
	await s.view.onClose();
});

it("ограничивает продолжения 16 раундами и сохраняет результаты", async () => {
	const s = await setup(Array.from({ length: 17 }, (_, i) => json({ tool_calls: [call({ title: `Шаг ${i + 1}`, content: "Результат" }, `вызов-${i}`)] }, "tool_calls")));
	s.plugin.settings.contextWindow = "200000";
	await s.ask("Создай несколько заметок");
	expect(s.requests).toHaveLength(16); expect(s.texts.size).toBe(16);
	expect(s.root.getText()).toContain(t("action-limit"));
	await s.view.onClose();
});

it("ограничивает запуск 32 вызовами, включая повторные доставки", async () => {
	const response = json({ tool_calls: Array.from({ length: 32 }, (_, i) => call({ title: `Шаг ${i + 1}`, content: "Результат" }, `вызов-${i}`)) }, "tool_calls");
	const s = await setup([response]); s.plugin.settings.contextWindow = "200000";
	await s.ask("Создай несколько заметок");
	expect(s.requests).toHaveLength(1); expect(s.texts.size).toBe(32);
	expect(s.root.getText()).toContain(t("action-limit"));
	await s.view.onClose();
});

it("не начинает набор, превышающий оставшийся лимит вызовов", async () => {
	const s = await setup([json({ tool_calls: Array.from({ length: 33 }, (_, i) => call({ title: `Шаг ${i + 1}`, content: "Результат" }, `вызов-${i}`)) }, "tool_calls")]);
	await s.ask("Создай несколько заметок");
	expect(s.create).not.toHaveBeenCalled(); expect(s.root.getText()).toContain(t("action-limit"));
	await s.view.onClose();
});

it("учитывает редакторскую запись, завершившуюся исключением после изменения текста", async () => {
	const response = deferred<Response>(), s = await setup([response.promise]);
	const file = s.add("План.md", "Исходный текст"), e = editor(s, file);
	s.view.app.workspace.getLeavesOfType = (() => [{ view: e.view }]) as any;
	const transaction = e.transaction.getMockImplementation()!;
	e.transaction.mockImplementationOnce((...args) => { transaction(...args); throw new Error("Ошибка наблюдателя после записи"); });
	s.input.value = "Сократи @План"; s.input.dispatchEvent({ type: "input", inputType: "insertText" } as any); s.input.keydown("Tab"); s.send.click();
	await vi.waitFor(() => expect(s.requests).toHaveLength(1));
	const snapshot = JSON.parse(s.requests[0].messages.at(-1).content.split("Note attachments (context data):\n")[1])[0];
	response.resolve(json({ tool_calls: [call({ targetId: snapshot.targetId, expectedVersion: snapshot.version, content: "Кратко", kind: "body" }, "1", "edit_note")] }, "tool_calls"));
	await s.settle();
	expect(e.text).toBe("Кратко"); expect(s.root.getText()).toContain("Изменена заметка: [[План.md]]");
	expect(s.requests).toHaveLength(2);
	await s.view.onClose();
});

it("сохраняет оба результата перед сетевым сбоем и повтором с новыми ID", async () => {
	const first = call({ title: "Первая", content: "Первый результат" }, "1"), second = call({ title: "Вторая", content: "Второй результат" }, "2");
	const s = await setup([json({ tool_calls: [first, second] }, "tool_calls"), new Response("Сбой", { status: 500 }),
		json({ tool_calls: [{ ...first, id: "новый-1" }, { ...second, id: "новый-2" }] }, "tool_calls")]);
	await s.ask("Создай две заметки");
	expect(s.texts.size).toBe(2);
	await s.ask("Попробуй ещё раз");
	expect(s.create).toHaveBeenCalledTimes(2);
	const protocol = s.requests[2].messages.filter((m: any) => m.role === "tool").map((m: any) => JSON.parse(m.content));
	expect(protocol.map((r: any) => r.path)).toEqual(["Входящие/Первая.md", "Входящие/Вторая.md"]);
	await s.view.onClose();
});

it("удерживает занятость модели во время записи, включая завершение после остановки", async () => {
	const s = await setup([json({ tool_calls: [call(), call({ title: "Вторая", content: "Не писать" }, "2")] }, "tool_calls")]);
	const release = vi.fn(), writing = deferred<void>();
	Object.assign(s.plugin, { conversationModel: { tryAcquire: () => ({ ready: Promise.resolve(), release }) } });
	s.create.mockImplementationOnce(async (path, content) => { await writing.promise; return s.add(path, content); });
	s.input.value = "Создай две заметки"; s.send.click(); await vi.waitFor(() => expect(s.create).toHaveBeenCalledTimes(1));
	expect(release).not.toHaveBeenCalled(); s.send.click(); expect(release).not.toHaveBeenCalled();
	writing.resolve(); await vi.waitFor(() => expect(release).toHaveBeenCalledTimes(1));
	expect(s.create).toHaveBeenCalledTimes(1);
	await s.view.onClose();
});

it("SSE-набор не выполняется до завершения всех аргументов", async () => {
	let controller!: ReadableStreamDefaultController<Uint8Array>;
	const stream = new Response(new ReadableStream({ start(c) { controller = c; } }), { headers: { "Content-Type": "text/event-stream" } });
	const s = await setup([stream]); s.input.value = "Создай две заметки"; s.send.click(); await flushPromises();
	const event = (delta: object, finish_reason: string | null = null) => controller.enqueue(new TextEncoder().encode(`data: ${JSON.stringify({ choices: [{ index: 0, delta, finish_reason }] })}\n\n`));
	event({ tool_calls: [{ index: 0, ...call({ title: "Первая", content: "Первый результат" }, "1") },
		{ index: 1, id: "2", type: "function", function: { name: "create_note", arguments: '{"title":"Вторая","content":"Второй' } }] });
	await flushPromises(); expect(s.create).not.toHaveBeenCalled();
	event({ tool_calls: [{ index: 1, function: { arguments: ' результат"}' } }] });
	await flushPromises(); expect(s.create).not.toHaveBeenCalled();
	event({}, "tool_calls"); controller.close(); await s.settle();
	expect(s.texts.get("Входящие/Первая.md")).toBe("Первый результат"); expect(s.texts.get("Входящие/Вторая.md")).toBe("Второй результат");
	await s.view.onClose();
});

it("сохраняет журнал через обсуждение и вежливую просьбу повторить с новыми stepId", async () => {
	const first = call({ title: "Первая", content: "Первый результат", stepId: "копия" }, "1");
	const second = call({ title: "Вторая", content: "Второй результат", folder: "Занято", stepId: "остаток" }, "2");
	const s = await setup([json({ tool_calls: [first, second] }, "tool_calls"), json({ content: "Сохранена первая, вторая не создана." }),
		json({ tool_calls: [call({ title: "Первая", content: "Первый результат", stepId: "новая-копия" }, "новый-1"), { ...second, id: "новый-2" }] }, "tool_calls")]);
	s.add("Занято", "Файл вместо папки");
	await s.ask("Создай две заметки"); await s.ask("Что было выполнено?");
	s.entries.delete("Занято"); s.texts.delete("Занято");
	await s.ask("Попробуй ещё раз, пожалуйста");
	expect(s.create).toHaveBeenCalledTimes(2);
	expect(s.texts.has("Входящие/Первая (2).md")).toBe(false);
	expect(s.texts.get("Занято/Вторая.md")).toBe("Второй результат");
	await s.view.onClose();
});

it("не продолжает заранее зарегистрированный независимый шаг при неизвестном исходе предыдущего", async () => {
	const first = call({ title: "Первая", content: "Первый результат" }, "1"), second = call({ title: "Вторая", content: "Второй результат" }, "2");
	const s = await setup([json({ tool_calls: [first, second] }, "tool_calls"), json({ tool_calls: [{ ...second, id: "новый-2" }] }, "tool_calls")]);
	s.create.mockImplementationOnce(async () => { throw new Error("Исход неизвестен"); });
	await s.ask("Создай две заметки"); await s.ask("Попробуй ещё раз");
	expect(s.create).toHaveBeenCalledTimes(1); expect(s.texts.size).toBe(0);
	expect(s.root.getText()).toContain(t("action-unknown"));
	await s.view.onClose();
});

it("не принимает новый файл по старому пути за связанную запись с неизвестным исходом", async () => {
	const args = { title: "Первая", content: "Ожидаемый результат" };
	const s = await setup([json({ tool_calls: [call(args, "1")] }, "tool_calls"), json({ tool_calls: [call(args, "повтор")] }, "tool_calls")]);
	s.create.mockImplementationOnce(async path => { s.add(path, "Неожиданный текст"); throw new Error("Исход неизвестен"); });
	await s.ask("Создай заметку");
	s.entries.delete("Входящие/Первая.md"); s.add("Входящие/Первая.md", "Ожидаемый результат");
	await s.ask("Попробуй ещё раз");
	expect(s.create).toHaveBeenCalledTimes(1);
	expect(s.view.getMessages().some(m => m.content.includes("Создана заметка:"))).toBe(false);
	expect(s.root.getText()).toContain(t("action-unknown"));
	await s.view.onClose();
});

it("новое создание с просьбой продолжить обсуждение не считается повтором прежнего", async () => {
	const s = await setup([json({ tool_calls: [call()] }, "tool_calls"), json({ content: "Готово" }), json({ tool_calls: [call()] }, "tool_calls")]);
	await s.ask("Создай заметку"); await s.ask("Создай ещё одну такую же заметку и продолжи обсуждение");
	expect(s.texts.has("Входящие/Решение (2).md")).toBe(true);
	await s.view.onClose();
});

it("повторно проверяет связанный файл после асинхронного установления исхода записи", async () => {
	const args = { title: "Первая", content: "Ожидаемый результат" };
	const s = await setup([json({ tool_calls: [call(args, "1")] }, "tool_calls")]);
	const reading = deferred<string>();
	s.create.mockImplementationOnce(async path => { s.add(path, args.content); throw new Error("Исход неизвестен"); });
	const read = vi.spyOn(s.vault, "read").mockImplementationOnce(() => reading.promise);
	s.input.value = "Создай заметку"; s.send.click(); await vi.waitFor(() => expect(read).toHaveBeenCalledTimes(1));
	s.entries.delete("Входящие/Первая.md"); s.add("Входящие/Первая.md", "Чужой новый файл");
	reading.resolve(args.content); await s.settle();
	expect(s.view.getMessages().some(m => m.content.includes("Создана заметка:"))).toBe(false);
	expect(s.texts.get("Входящие/Первая.md")).toBe("Чужой новый файл");
	await s.view.onClose();
});
