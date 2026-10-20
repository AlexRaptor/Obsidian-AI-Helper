import { afterEach, expect, it, vi } from "vitest";
import { type TFile } from "obsidian";
import { t } from "../src/i18n";
import { deferred, flushPromises } from "./helpers/obsidian";
import { setup, json, call } from "./helpers/chat-note-actions";

vi.mock("obsidian", async () => import("./helpers/obsidian"));
afterEach(() => { vi.restoreAllMocks(); });

it("создаёт заметку по полному вызову без текста и передаёт фактический результат модели", async () => {
	const s = await setup([json({ content: null, tool_calls: [call()] }, "tool_calls")]);
	await s.ask("Сохрани итоговое решение в новую заметку");
	expect(s.texts.get("Входящие/Решение.md")).toBe("# Решение\nЕдем поездом.\n\n## Открытые вопросы\nДата отправления.");
	expect(s.parent).toHaveBeenCalledWith("Проекты/Обсуждение.md");
	expect(s.root.getText()).toContain("[[Входящие/Решение.md]]");
	expect(s.requests[0].tools.map((tool: any) => tool.function.name)).toEqual(["create_note", "export_chat"]);
	expect(s.requests[1].messages.at(-1)).toMatchObject({ role: "tool", tool_call_id: "вызов-1" });
	expect(JSON.parse(s.requests[1].messages.at(-1).content)).toMatchObject({ status: "completed", path: "Входящие/Решение.md", stepId: expect.any(String) });
	await s.view.onClose();
});

it("собирает потоковые аргументы целиком; до завершающего события ничего не записывает", async () => {
	let controller!: ReadableStreamDefaultController<Uint8Array>;
	const stream = new Response(new ReadableStream({ start(value) { controller = value; } }), { headers: { "Content-Type": "text/event-stream" } });
	const s = await setup([stream]);
	s.input.value = "Создай заметку по обсуждению"; s.send.click(); await flushPromises();
	const event = (delta: object, finish_reason: string | null = null) => controller.enqueue(new TextEncoder().encode(`data: ${JSON.stringify({ choices: [{ index: 0, delta, finish_reason }] })}\n\n`));
	event({ tool_calls: [{ index: 0, id: "поток-1", type: "function", function: { name: "create_note", arguments: '{"title":"Поездка","content":"Едем' } }] });
	await flushPromises(); expect(s.texts.size).toBe(0);
	event({ tool_calls: [{ index: 0, function: { arguments: ' поездом 🚆"}' } }] });
	await flushPromises(); expect(s.texts.size).toBe(0);
	event({}, "tool_calls"); controller.close(); await s.settle();
	expect(s.texts.get("Входящие/Поездка.md")).toBe("Едем поездом 🚆");
	await s.view.onClose();
});

it("учитывает заданную папку, регистр и конкурентное занятие имени без перезаписи", async () => {
	const s = await setup([json({ tool_calls: [call({ title: "План.md", folder: "Проекты/Поездка", content: "Новый план" })] }, "tool_calls")]);
	s.folder("Проекты"); s.add("Проекты/Поездка/план.md", "Старый план");
	s.create.mockImplementationOnce(async path => { s.add(path, "Конкурентная заметка"); throw new Error("EEXIST: файл занят"); });
	await s.ask("Создай План.md в Проекты/Поездка");
	expect(s.texts.get("Проекты/Поездка/план.md")).toBe("Старый план");
	expect(s.texts.get("Проекты/Поездка/План (2).md")).toBe("Конкурентная заметка");
	expect(s.texts.get("Проекты/Поездка/План (3).md")).toBe("Новый план");
	expect(s.root.getText()).toContain("[[Проекты/Поездка/План (3).md]]");
	expect(s.parent).not.toHaveBeenCalled();
	await s.view.onClose();
});

it("фиксирует активную заметку при отправке, до ожидания модели", async () => {
	const delayed = deferred<Response>();
	const s = await setup([delayed.promise]);
	let activePath = "Проекты/Первый.md";
	s.view.app.workspace.getActiveFile = () => ({ path: activePath }) as TFile;
	const priority = deferred<void>();
	Object.assign(s.plugin, { conversationModel: { tryAcquire: () => ({ ready: priority.promise, release() {} }) } });
	s.input.value = "Сохрани решение"; s.send.click(); await flushPromises();
	activePath = "Другие/Второй.md";
	priority.resolve(); await flushPromises();
	delayed.resolve(json({ tool_calls: [call()] }, "tool_calls")); await s.settle();
	expect(s.parent).toHaveBeenCalledWith("Проекты/Первый.md");
	await s.view.onClose();
});

it("включённый ранее поиск не запускается для создания по обсуждению", async () => {
	const s = await setup([json({ tool_calls: [call()] }, "tool_calls")]);
	const searchSources = vi.fn(async () => []);
	Object.assign(s.plugin.settings, { embeddingServerUrl: "http://s", embeddingModel: "представления" });
	Object.assign(s.plugin, { noteSearch: { searchSources, resume: async () => {}, progress: { state: "complete", completed: 0, total: 0 } } });
	s.root.find("ai-helper-search-toggle").click();
	await s.ask("Сохрани итоговое решение");
	expect(s.texts.has("Входящие/Решение.md")).toBe(true);
	expect(searchSources).not.toHaveBeenCalled();
	await s.view.onClose();
});

it("обычное обсуждение работает и при неизвестном окне контекста", async () => {
	const s = await setup([json({ content: "Давайте обсудим варианты." })]);
	s.plugin.settings.contextWindow = "";
	await s.ask("Какие есть варианты?");
	expect(s.root.getText()).toContain("Давайте обсудим варианты.");
	expect(s.requests[0].tools).toBeUndefined();
	expect(s.texts.size).toBe(0);
	await s.view.onClose();
});

it.each([
	["неверный JSON", { ...call(), function: { name: "create_note", arguments: "{" } }],
	["неизвестная функция", call({}, "1", "delete_note")],
	["неверный тип", call({ title: "План", content: 42 })],
	["неизвестное поле", call({ title: "План", content: "Текст", overwrite: true })],
	["пустой текст", call({ title: "План", content: " " })],
] as const)("отклоняет %s без записи", async (_name, tool) => {
	const s = await setup([json({ tool_calls: [tool] }, "tool_calls")]);
	await s.ask("Создай заметку");
	expect(s.texts.size).toBe(0); expect(s.vault.createFolder).not.toHaveBeenCalled();
	expect(s.root.getText()).toContain(t("action-invalid"));
	await s.view.onClose();
});

it.each([
	{ title: "../План", folder: "Новые" }, { title: "План.", folder: "Новые" },
	{ title: "План", folder: "../Снаружи" }, { title: "План", folder: "/Снаружи" },
	{ title: "План", folder: "Новые//Планы" }, { title: "План", folder: ".obsidian/Планы" },
	{ title: "План", folder: "Папка/./Планы" }, { title: "CON", folder: "Новые" },
])("отклоняет недопустимое расположение $folder/$title", async args => {
	const s = await setup([json({ tool_calls: [call({ ...args, content: "Текст" })] }, "tool_calls")]);
	await s.ask("Создай заметку в указанной папке");
	expect(s.texts.size).toBe(0); expect(s.vault.createFolder).not.toHaveBeenCalled();
	expect(s.root.getText()).toContain(t("action-path"));
	await s.view.onClose();
});

it("отклоняет файл вместо папки и сообщает об оставшихся новых папках после сбоя", async () => {
	const s = await setup([json({ tool_calls: [call({ title: "План", content: "Текст", folder: "Новая/Занято" })] }, "tool_calls")]);
	s.add("Новая/Занято", "Существующий файл");
	await s.ask("Создай План в Новая/Занято");
	expect(s.texts.get("Новая/Занято")).toBe("Существующий файл");
	expect(s.create).not.toHaveBeenCalled();
	expect(s.root.getText()).toContain(t("action-folders") + " Новая");
	await s.view.onClose();
});

it.each(["length", "content_filter", "stop"])("не выполняет вызов с причиной завершения %s", async reason => {
	const s = await setup([json({ tool_calls: [call()] }, reason)]);
	await s.ask("Создай заметку"); expect(s.texts.size).toBe(0);
	await s.view.onClose();
});

it("не пишет по отказу модели или по нескольким вызовам", async () => {
	for (const message of [{ refusal: "Отказываюсь", tool_calls: [call()] }, { tool_calls: [call(), call({}, "2")] }]) {
		const s = await setup([json(message, "tool_calls")]);
		await s.ask("Создай заметку"); expect(s.texts.size).toBe(0);
		await s.view.onClose();
	}
});

it.each(["Что можно сохранить?", "Обсудим идею заметки", "Приведи материалы в порядок"])("обсуждение или уточнение «%s» ничего не записывает", async text => {
	const s = await setup([json({ content: "Что именно включить в новую заметку?" })]);
	await s.ask(text); expect(s.texts.size).toBe(0);
	expect(s.root.getText()).toContain("Что именно включить в новую заметку?");
	await s.view.onClose();
});

it("передаёт поздние уточнения и полную историю решения без подмены текста", async () => {
	const s = await setup([json({ content: "Рассмотрим самолёт и поезд." }), json({ content: "Принято: самолёт отвергнут, едем поездом. Дата открыта." }),
		json({ tool_calls: [call()] }, "tool_calls")]);
	await s.ask("Обсудим самолёт и поезд");
	await s.ask("Самолёт отвергаем. Решили ехать поездом; дату пока не выбрали.");
	await s.ask("Сохрани итоговое решение");
	expect(s.requests[2].messages).toContainEqual({ role: "user", content: "Самолёт отвергаем. Решили ехать поездом; дату пока не выбрали." });
	expect(s.texts.get("Входящие/Решение.md")).toBe("# Решение\nЕдем поездом.\n\n## Открытые вопросы\nДата отправления.");
	await s.view.onClose();
});

it.each(["stop", "clear", "close", "unload"])("%s запрещает запоздалое создание", async mode => {
	const delayed = deferred<Response>();
	const s = await setup([delayed.promise]);
	s.input.value = "Создай заметку"; s.send.click(); await flushPromises();
	if (mode === "stop") s.send.click();
	if (mode === "clear") s.root.find("ai-helper-clear-btn").click();
	if (mode === "close") await s.view.onClose();
	if (mode === "unload") Object.assign(s.plugin, { isUnloading: true });
	delayed.resolve(json({ tool_calls: [call()] }, "tool_calls"));
	await flushPromises();
	expect(s.texts.size).toBe(0);
	if (mode !== "close") await s.view.onClose();
});

it("сохраняет видимый результат и протокол при ошибке последующего ответа", async () => {
	const s = await setup([json({ tool_calls: [call()] }, "tool_calls"), new Response("ошибка", { status: 500 })]);
	await s.ask("Создай заметку");
	expect(s.root.getText()).toContain("[[Входящие/Решение.md]]");
	expect(s.view.getMessages()).toHaveLength(2);
	await s.ask("Что было выполнено?");
	expect(s.requests[2].messages.some((message: any) => message.role === "tool" && JSON.parse(message.content).path === "Входящие/Решение.md")).toBe(true);
	expect(s.texts.size).toBe(1);
	await s.view.onClose();
});

it("повторная доставка вызова не создаёт второй файл", async () => {
	const s = await setup([json({ tool_calls: [call()] }, "tool_calls"), json({ tool_calls: [call()] }, "tool_calls"), json({ content: "Готово." })]);
	await s.ask("Создай заметку");
	expect(s.texts.size).toBe(1); expect(s.create).toHaveBeenCalledTimes(1);
	await s.view.onClose();
});

it("превышение бюджета описаний инструмента останавливает запрос без обрезки", async () => {
	const s = await setup(); s.plugin.settings.contextWindow = "1900";
	await s.ask("Создай заметку");
	expect(s.requests).toHaveLength(0); expect(s.texts.size).toBe(0);
	expect(s.root.getText()).toContain(t("action-budget"));
	await s.view.onClose();
});

it("явный отказ от инструментов объясняется, а диалог продолжается без смены модели", async () => {
	const s = await setup([new Response(JSON.stringify({ error: { message: "Tools are not supported by this model" } }), { status: 400 }),
		json({ content: "Могу предложить текст заметки." }), json({ content: "Обсудим варианты." })]);
	await s.ask("Создай заметку");
	expect(s.texts.size).toBe(0); expect(s.root.getText()).toContain(t("action-unsupported"));
	expect(s.requests[1].tools).toBeUndefined();
	await s.ask("Какие есть варианты?");
	expect(s.requests[2].tools).toBeUndefined();
	expect(s.requests.every(request => request.model === "модель")).toBe(true);
	await s.view.onClose();
});

it("при явном отказе от потока повторяет запрос непотоково с тем же инструментом", async () => {
	const s = await setup([new Response(JSON.stringify({ error: { message: "Streaming is not supported" } }), { status: 400 }),
		json({ tool_calls: [call()] }, "tool_calls")]);
	await s.ask("Создай заметку");
	expect(s.requests[0].stream).toBe(true); expect(s.requests[1].stream).toBe(false);
	expect(s.requests[1].tools).toEqual(s.requests[0].tools);
	expect(s.texts.size).toBe(1);
	await s.view.onClose();
});

it("завершившаяся после остановки атомарная запись видна и не запускает продолжение", async () => {
	const s = await setup([json({ tool_calls: [call()] }, "tool_calls")]);
	const writing = deferred<TFile>();
	s.create.mockImplementationOnce(async () => writing.promise);
	s.input.value = "Создай заметку"; s.send.click(); await flushPromises();
	expect(s.create).toHaveBeenCalledTimes(1);
	s.send.click(); writing.resolve(s.add("Входящие/Решение.md", "Результат")); await flushPromises();
	expect(s.root.getText()).toContain("[[Входящие/Решение.md]]"); expect(s.requests).toHaveLength(1);
	expect(s.view.getMessages()).toHaveLength(2);
	await s.view.onClose();
});

it("материалы из нескольких явных вложений передаются полностью и не изменяются", async () => {
	const s = await setup([json({ tool_calls: [call()] }, "tool_calls")]);
	s.add("Материалы/Поезд.md", "Полный текст про поезд [[Станция]]");
	s.add("Материалы/Самолёт.md", "Полный текст про самолёт ![[Билет.png]]");
	s.input.value = "Создай сводную заметку по @Поезд";
	s.input.dispatchEvent({ type: "input", inputType: "insertText" } as any); s.input.keydown("Tab");
	s.input.createSpan({ text: " и @Самолёт" });
	s.input.dispatchEvent({ type: "input", inputType: "insertText" } as any); s.input.keydown("Tab");
	s.send.click(); await s.settle();
	const sent = s.requests[0].messages.at(-1).content;
	expect(sent).toContain("Полный текст про поезд [[Станция]]");
	expect(sent).toContain("Полный текст про самолёт ![[Билет.png]]");
	expect(s.texts.get("Материалы/Поезд.md")).toBe("Полный текст про поезд [[Станция]]");
	expect(s.texts.get("Материалы/Самолёт.md")).toBe("Полный текст про самолёт ![[Билет.png]]");
	expect(s.texts.size).toBe(3);
	await s.view.onClose();
});

it("обрыв потока с полными аргументами без подтверждения завершения ничего не записывает", async () => {
	const data = `data: ${JSON.stringify({ choices: [{ delta: { tool_calls: [{ index: 0, ...call() }] } }] })}\n\n`;
	const s = await setup([new Response(data, { headers: { "Content-Type": "text/event-stream" } })]);
	await s.ask("Создай заметку"); expect(s.texts.size).toBe(0);
	expect(s.root.getText()).toContain(t("chat-incomplete-response"));
	await s.view.onClose();
});

it("остановка после создания папки оставляет видимый фактический отчёт", async () => {
	const s = await setup([json({ tool_calls: [call({ title: "План", content: "Текст", folder: "Новая/Вложенная" })] }, "tool_calls")]);
	const creatingFolder = deferred<void>();
	s.vault.createFolder.mockImplementationOnce(async path => { await creatingFolder.promise; return s.folder(path); });
	s.input.value = "Создай заметку в Новая/Вложенная"; s.send.click(); await flushPromises();
	s.send.click(); creatingFolder.resolve(); await flushPromises();
	expect(s.texts.size).toBe(0);
	expect(s.root.getText()).toContain(t("action-folders") + " Новая");
	await s.view.onClose();
});

it("на чувствительном к регистру хранилище разные имена не получают лишний суффикс", async () => {
	const s = await setup([json({ tool_calls: [call({ title: "План", content: "Новый план" })] }, "tool_calls")]);
	s.setCaseSensitive(); s.add("Входящие/план.md", "Старый план");
	await s.ask("Создай План");
	expect(s.texts.get("Входящие/План.md")).toBe("Новый план");
	expect(s.texts.get("Входящие/план.md")).toBe("Старый план");
	await s.view.onClose();
});

it("позднее завершение остановленной записи сохраняет исходный порядок истории", async () => {
	const s = await setup([json({ tool_calls: [call()] }, "tool_calls"), json({ content: "Новый ответ" })]);
	const writing = deferred<TFile>();
	s.create.mockImplementationOnce(async () => writing.promise);
	s.input.value = "Создай заметку"; s.send.click(); await flushPromises(); s.send.click();
	await s.ask("Новое обсуждение");
	writing.resolve(s.add("Входящие/Решение.md", "Результат")); await flushPromises();
	expect(s.view.getMessages().map(message => message.content)).toEqual([
		"Создай заметку", "Создана заметка: [[Входящие/Решение.md]]", "Новое обсуждение", "Новый ответ",
	]);
	await s.view.onClose();
});

it("отказ от инструментов при включённом поиске виден и не запускает поиск для записи", async () => {
	const s = await setup([new Response(JSON.stringify({ error: { message: "Tools are not supported" } }), { status: 400 }), json({ content: "Могу предложить текст." })]);
	const searchSources = vi.fn(async () => []);
	Object.assign(s.plugin.settings, { embeddingServerUrl: "http://s", embeddingModel: "представления" });
	Object.assign(s.plugin, { noteSearch: { searchSources, resume: async () => {}, progress: { state: "complete", completed: 0, total: 0 } } });
	s.root.find("ai-helper-search-toggle").click(); await s.ask("Создай заметку");
	expect(s.root.getText()).toContain(t("action-unsupported"));
	expect(searchSources).not.toHaveBeenCalled();
	await s.view.onClose();
});

it("неизвестное окно не превращает оборванный ответ в полный", async () => {
	const s = await setup([json({ content: "Начало результата…" }, "length")]);
	s.plugin.settings.contextWindow = ""; await s.ask("Создай заметку");
	expect(s.view.getMessages()).toEqual([]); expect(s.texts.size).toBe(0);
	expect(s.root.getText()).toContain(t("action-incomplete"));
	await s.view.onClose();
});

it("результаты инструментов входят в бюджет продолжения, успешная запись при этом сохраняется", async () => {
	const content = "Полный результат. ".repeat(160);
	const s = await setup([json({ tool_calls: [call({ title: "Полный результат", content })] }, "tool_calls")]);
	s.plugin.settings.contextWindow = "5000";
	await s.ask("Сохрани полный результат в заметку");
	expect(s.texts.get("Входящие/Полный результат.md")).toBe(content);
	expect(s.requests).toHaveLength(1);
	expect(s.root.getText()).toContain("[[Входящие/Полный результат.md]]");
	expect(s.root.getText()).toContain(t("action-budget"));
	await s.view.onClose();
});

it.each(["тот же идентификатор с другими аргументами", "новый идентификатор"])("%s после успешного шага не разрешает второе создание", async variant => {
	const repeated = variant === "новый идентификатор" ? call(undefined, "вызов-2") : call({ title: "Другой план", content: "Другой текст" });
	const s = await setup([json({ tool_calls: [call()] }, "tool_calls"), json({ tool_calls: [repeated] }, "tool_calls")]);
	await s.ask("Создай заметку");
	expect(s.texts.size).toBe(1); expect(s.create).toHaveBeenCalledTimes(1);
	if (variant !== "новый идентификатор") expect(s.root.getText()).toContain(t("action-single"));
	await s.view.onClose();
});

it("сообщает об отказе от инструментов даже при сбое резервного текстового запроса", async () => {
	const s = await setup([new Response(JSON.stringify({ error: { message: "Tools are not supported" } }), { status: 400 }),
		new Response("ошибка", { status: 500 })]);
	await s.ask("Создай заметку"); expect(s.texts.size).toBe(0);
	expect(s.root.getText()).toContain(t("action-unsupported"));
	await s.view.onClose();
});
