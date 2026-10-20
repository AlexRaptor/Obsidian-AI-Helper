import { afterEach, expect, it, vi } from "vitest";
import { setup, json, call } from "./helpers/chat-note-actions";
import { editor } from "./helpers/chat-note-editor";
import { setLanguage } from "../src/i18n";
import { deferred, flushPromises } from "./helpers/obsidian";

vi.mock("obsidian", async () => import("./helpers/obsidian"));
afterEach(() => { vi.restoreAllMocks(); });
const saveChat = (args: object = { title: "Переписка" }) => json({ tool_calls: [call(args, "экспорт", "export_chat")] }, "tool_calls");

it("сохраняет исходные реплики до команды включительно без пересказа и технического обмена", async () => {
	const s = await setup([json({ content: "**Поезд**\n\nСамолёт тоже возможен." }), saveChat()]);
	await s.ask("Обсудим поездку");
	await s.ask("Сохрани весь чат");
	expect(s.texts.get("Входящие/Переписка.md")).toBe("## Пользователь\n\nОбсудим поездку\n\n## Модель\n\n**Поезд**\n\nСамолёт тоже возможен.\n\n## Пользователь\n\nСохрани весь чат\n");
	expect(s.root.getText()).toContain("[[Входящие/Переписка.md]]");
	await s.view.onClose();
});

it.each(["stop", "broken", "http"])("включает видимую попытку %s без добавления её в контекст модели", async mode => {
	let controller!: ReadableStreamDefaultController<Uint8Array>;
	const response = mode === "http" ? new Response("Сбой сервера", { status: 500 }) : new Response(new ReadableStream({ start(value) { controller = value; } }), { headers: { "Content-Type": "text/event-stream" } });
	const s = await setup([response, saveChat()]);
	s.input.value = "Неудачный вопрос"; s.send.click(); await flushPromises();
	if (mode !== "http") {
		controller.enqueue(new TextEncoder().encode(`data: ${JSON.stringify({ choices: [{ delta: { content: "Успел получить только начало" } }] })}\n\n`));
		await flushPromises();
		if (mode === "stop") s.send.click(); else controller.close();
	}
	await s.settle();
	await s.ask("Сохрани весь чат");
	const saved = s.texts.get("Входящие/Переписка.md")!;
	expect(saved).toContain("Неудачный вопрос");
	if (mode !== "http") {
		expect(saved).toContain("Успел получить только начало");
		expect(saved).toContain("Незавершённый ответ");
	} else expect(saved).toContain("Ошибка запроса");
	expect(s.requests[1].messages.filter((message: any) => message.role !== "system")).toEqual([{ role: "user", content: "Сохрани весь чат" }]);
	await s.view.onClose();
});

it.each([false, true])("повторно экспортирует исторические вложения (полный текст: %s), сохраняя только выделенный фрагмент", async includeAttachments => {
	const s = await setup([json({ content: "Обсудили заметку." }), json({ content: "Обсудили фрагмент." }),
		saveChat({ title: "Первый экспорт" }), json({ content: "Чат сохранён." }), saveChat({ title: "Переписка", includeAttachments })]);
	const file = s.add("План.md", "# Исходный полный снимок\nЕдем поездом.");
	s.input.value = "Обсудим @План";
	s.input.dispatchEvent({ type: "input", inputType: "insertText" } as any); s.input.keydown("Tab");
	s.send.click(); await s.settle();
	const fragmentFile = s.add("Фрагменты.md", "Скрытый сосед\nВыделенный снимок\nЕщё один сосед");
	const e = editor(s, fragmentFile);
	e.select({ line: 1, ch: 0 }, { line: 1, ch: 17 });
	s.view.app.workspace.getLeavesOfType = (() => [{ view: e.view }]) as any;
	s.view.app.workspace.getActiveViewOfType = (() => e.view) as any;
	s.input.value = "Обсудим @@";
	s.input.dispatchEvent({ type: "input", inputType: "insertText" } as any); s.input.keydown("Tab");
	e.change("Текст изменён до отправки");
	s.send.click(); await s.settle();
	await s.ask("Сохрани весь чат в заметку «Первый экспорт»");
	s.texts.set(file.path, "Новая версия целой заметки");
	e.change("Новая версия фрагмента");
	await s.ask(includeAttachments ? "Сохрани весь чат с полными снимками вложений" : "Сохрани весь чат");
	const saved = s.texts.get("Входящие/Переписка.md")!;
	expect(saved).toContain("[[План.md|План]]");
	expect(saved).toContain("[[Фрагменты.md|Фрагменты]]");
	if (includeAttachments) {
		expect(saved).toContain("# Исходный полный снимок\nЕдем поездом.");
		expect(saved).toContain("Выделенный снимок");
	} else {
		expect(saved).not.toContain("Едем поездом.");
		expect(saved).not.toContain("Выделенный снимок");
	}
	for (const hidden of ["Скрытый сосед", "Ещё один сосед", "Новая версия", "Текст изменён", "targetId", "expectedVersion"]) expect(saved).not.toContain(hidden);
	await s.view.onClose();
});

it("сохраняет видимый результат действия и его ошибку, исключая результат самого экспорта", async () => {
	const delayed = deferred<Response>();
	const s = await setup([json({ tool_calls: [call()] }, "tool_calls"), new Response("Сбой", { status: 500 }), delayed.promise]);
	await s.ask("Создай заметку с решением");
	s.input.value = "Сохрани весь чат"; s.send.click(); await flushPromises();
	expect(s.texts.has("Входящие/Переписка.md")).toBe(false);
	delayed.resolve(saveChat()); await s.settle();
	const saved = s.texts.get("Входящие/Переписка.md")!;
	expect(saved).toContain("Создана заметка: [[Входящие/Решение.md]]");
	expect(saved).toContain("Ошибка запроса");
	expect(saved.indexOf("Создай заметку")).toBeLessThan(saved.indexOf("Создана заметка:"));
	expect(saved.indexOf("Создана заметка:")).toBeLessThan(saved.indexOf("Сохрани весь чат"));
	for (const hidden of ["[[Входящие/Переписка.md]]", "Готово.", "thinking", "tool_calls", "Instruction journal"]) expect(saved).not.toContain(hidden);
	await s.view.onClose();
});

it("поздний результат предыдущей записи не сдвигает границу отправленной команды", async () => {
	const write = deferred<ReturnType<Awaited<ReturnType<typeof setup>>["add"]>>();
	const response = deferred<Response>();
	const s = await setup([json({ tool_calls: [call()] }, "tool_calls"), response.promise]);
	s.create.mockImplementationOnce(() => write.promise);
	s.input.value = "Создай заметку"; s.send.click();
	await vi.waitFor(() => expect(s.create).toHaveBeenCalledOnce());
	s.send.click();
	s.input.value = "Сохрани весь чат"; s.send.click();
	await vi.waitFor(() => expect(s.requests).toHaveLength(2));
	write.resolve(s.add("Входящие/Решение.md", "Решение")); await flushPromises();
	expect(s.root.getText()).toContain("[[Входящие/Решение.md]]");
	response.resolve(saveChat()); await s.settle();
	const saved = s.texts.get("Входящие/Переписка.md")!;
	expect(saved).toContain("Создай заметку");
	expect(saved).toContain("Сохрани весь чат");
	expect(saved).not.toContain("Создана заметка:");
	await s.view.onClose();
});

it("локализует подписи и сохраняет длинный текст целиком при малом резерве ответа модели", async () => {
	const long = "Исходная реплика — без перевода.\n".repeat(100);
	const s = await setup([json({ content: long }), saveChat()]);
	await s.ask("Обсудим по-русски");
	s.plugin.settings.maxTokens = "32";
	setLanguage("en");
	await s.ask("Save the whole chat");
	expect(s.texts.get("Входящие/Переписка.md")).toBe(`## User\n\nОбсудим по-русски\n\n## Model\n\n${long}\n\n## User\n\nSave the whole chat\n`);
	await s.view.onClose();
});

it.each(["stop", "clear", "close", "unload"])("%s запрещает запоздалый экспорт", async mode => {
	const delayed = deferred<Response>();
	const s = await setup([delayed.promise]);
	s.input.value = "Сохрани весь чат"; s.send.click(); await flushPromises();
	if (mode === "stop") s.send.click();
	if (mode === "clear") s.root.find("ai-helper-clear-btn").click();
	if (mode === "close") await s.view.onClose();
	if (mode === "unload") Object.assign(s.plugin, { isUnloading: true });
	delayed.resolve(saveChat()); await flushPromises();
	expect(s.texts.size).toBe(0);
	if (mode !== "close") await s.view.onClose();
});

it("экспорт использует указанную папку и свободное имя, повторный вызов не создаёт копию", async () => {
	const args = { title: "Переписка", folder: "Архив/Обсуждения" };
	const s = await setup([saveChat(args), saveChat(args)]);
	s.add("Архив/Обсуждения/переписка.md", "Существующий текст");
	await s.ask("Сохрани весь чат в Архив/Обсуждения");
	expect(s.texts.get("Архив/Обсуждения/переписка.md")).toBe("Существующий текст");
	expect(s.texts.get("Архив/Обсуждения/Переписка (2).md")).toContain("Сохрани весь чат в Архив/Обсуждения");
	expect(s.create).toHaveBeenCalledOnce();
	expect(s.root.getText()).toContain("[[Архив/Обсуждения/Переписка (2).md]]");
	await s.view.onClose();
});

it.each([
	{ title: "Переписка", content: "Пересказ модели" },
	{ title: "Переписка", includeAttachments: "true" },
	{ title: "Переписка", folder: "../Снаружи" },
])("отклоняет неверный экспорт $title без записи", async args => {
	const s = await setup([saveChat(args)]);
	await s.ask("Сохрани весь чат");
	expect(s.texts.size).toBe(0);
	expect(s.vault.createFolder).not.toHaveBeenCalled();
	await s.view.onClose();
});

it("собирает потоковый вызов экспорта целиком перед созданием заметки", async () => {
	let controller!: ReadableStreamDefaultController<Uint8Array>;
	const stream = new Response(new ReadableStream({ start(value) { controller = value; } }), { headers: { "Content-Type": "text/event-stream" } });
	const s = await setup([stream]);
	s.input.value = "Сохрани весь чат"; s.send.click(); await flushPromises();
	const event = (delta: object, finish_reason: string | null = null) => controller.enqueue(new TextEncoder().encode(`data: ${JSON.stringify({ choices: [{ index: 0, delta, finish_reason }] })}\n\n`));
	event({ tool_calls: [{ index: 0, id: "экспорт", type: "function", function: { name: "export_chat", arguments: '{"title":"Пере' } }] });
	await flushPromises(); expect(s.texts.size).toBe(0);
	event({ tool_calls: [{ index: 0, function: { arguments: 'писка"}' } }] });
	await flushPromises(); expect(s.texts.size).toBe(0);
	event({}, "tool_calls"); controller.close(); await s.settle();
	expect(s.texts.get("Входящие/Переписка.md")).toBe("## Пользователь\n\nСохрани весь чат\n");
	await s.view.onClose();
});

it("новая команда после остановленного ответа создаёт отдельный экспорт несмотря на предыдущий сохранённый чат", async () => {
	let controller!: ReadableStreamDefaultController<Uint8Array>;
	const stream = new Response(new ReadableStream({ start(value) { controller = value; } }), { headers: { "Content-Type": "text/event-stream" } });
	const s = await setup([json({ content: "Едем поездом, дата открыта." }), saveChat(), json({ content: "Сохранено." }), stream,
		saveChat({ title: "С остановкой", folder: "Экспорт" }), json({ content: "Создана новая заметка." })]);
	await s.ask("Обсудим поездку");
	await s.ask("Сохрани весь чат в заметку «Переписка»");
	const first = s.texts.get("Входящие/Переписка.md")!;
	s.input.value = "Напиши подробный план поездки"; s.send.click(); await flushPromises();
	controller.enqueue(new TextEncoder().encode(`data: ${JSON.stringify({ choices: [{ delta: { content: "Первый день: отправление." } }] })}\n\n`));
	await flushPromises(); s.send.click();
	await s.ask("Сохрани весь чат в заметку «С остановкой» в папке «Экспорт».");
	expect(s.texts.get("Входящие/Переписка.md")).toBe(first);
	expect(s.texts.get("Экспорт/С остановкой.md")).toContain("Первый день: отправление.");
	expect(s.texts.get("Экспорт/С остановкой.md")).toContain("Незавершённый ответ");
	expect(s.root.getText()).toContain("[[Экспорт/С остановкой.md]]");
	await s.view.onClose();
});
