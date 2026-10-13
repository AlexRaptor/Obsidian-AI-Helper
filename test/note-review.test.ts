import { afterEach, expect, it, vi } from "vitest";
import { type App, type PluginManifest, MarkdownView, TFile, TFolder, type WorkspaceLeaf, type OpenViewState } from "obsidian";
import { AiHelperPlugin } from "../src/main";
import { NoteReviewView, VIEW_TYPE_NOTE_REVIEW } from "../src/note-review-view";
import { DEFAULT_SETTINGS } from "../src/settings";
import { setLanguage } from "../src/i18n";
import { TestElement, deferred, flushPromises } from "./helpers/obsidian";
import type { ChatCompletionResult, ServerClientResult } from "../src/server-client";

vi.mock("obsidian", async () => ({ ...await import("./helpers/obsidian"), parseYaml: (text: string) => Object.fromEntries(text.split("\n").map(line => line.split(":").map(part => part.trim()))) }));
afterEach(() => setLanguage("en"));

async function setup() {
	setLanguage("ru");
	const texts = new Map([
		["_folder.md", "Общие правила: хранить справку."],
		["Знания/_folder.md", "Reference materials, not active projects."],
		["Знания/Проекты/_folder.md", "Исключение: активные проекты."],
		["Личное/_folder.md", "Личные планы."],
		["Пустая/_folder.md", "## Назначение\n<!-- подсказка -->\n%% комментарий %%"],
		["Личное/План.md", "Сохранённый текст"],
		["Секрет.md", "НЕ ЧИТАТЬ"],
	]);
	const folders = new Map<string, TFolder>();
	const files = new Map<string, TFile>();
	for (const path of texts.keys()) {
		const parentPath = path.includes("/") ? path.slice(0, path.lastIndexOf("/")) : "";
		if (!folders.has(parentPath)) folders.set(parentPath, Object.assign(new TFolder(), { path: parentPath }));
		files.set(path, Object.assign(new TFile(), { path, name: path.split("/").at(-1), basename: path.split("/").at(-1)!.slice(0, -3), extension: "md", parent: folders.get(parentPath) }));
	}
	const file = files.get("Личное/План.md")!;
	let text = "---\nстатус: активный\n---\nЛичный план изучения GTD [[Секрет]]";
	const editor = { getValue: () => text };
	const markdown = Object.assign(new MarkdownView({} as WorkspaceLeaf), { file, editor, getMode: (): "source" | "preview" => "source", getViewData: () => text });
	const events = new Map<string, Array<(...args: any[]) => void>>();
	const on = (name: string, cb: (...args: any[]) => void) => { events.set(name, [...events.get(name) ?? [], cb]); return {}; };
	const openFile = vi.fn(async (_file: TFile, _state?: OpenViewState) => {}), create = vi.fn(), remove = vi.fn();
	Object.assign(markdown, { save: async () => { texts.set(file.path, text); } });
	const renameFile = vi.fn(async (f: TFile, path: string) => {
		if (files.has(path) || folders.has(path)) throw new Error("Путь занят");
		const oldPath = f.path, content = texts.get(oldPath)!;
		files.delete(oldPath); texts.delete(oldPath);
		Object.assign(f, { path, parent: folders.get(path.includes("/") ? path.slice(0, path.lastIndexOf("/")) : "") });
		files.set(path, f); texts.set(path, content);
		events.get("rename")?.forEach(cb => cb(f, oldPath));
	});
	const read = vi.fn(async (f: TFile) => texts.get(f.path)!);
	let view: NoteReviewView;
	const leaf = { get view() { return view; } };
	const ensureSideLeaf = vi.fn(async () => leaf);
	const mainLeaf = { openFile };
	const mainLeaves = new Set([mainLeaf]);
	const getLeaf = vi.fn(() => mainLeaf);
	const app = { vault: { on, adapter: { exists: vi.fn(async (path: string) => files.has(path) || folders.has(path)) }, getMarkdownFiles: () => [...files.values()], getAbstractFileByPath: (path: string) => files.get(path) ?? folders.get(path), read, create, delete: remove }, fileManager: { renameFile }, workspace: { on, getActiveViewOfType: () => markdown, getLeavesOfType: () => [], ensureSideLeaf, getLeaf, iterateAllLeaves: (callback: (leaf: typeof mainLeaf) => void) => mainLeaves.forEach(callback), trigger: vi.fn() } } as unknown as App;
	const plugin = new AiHelperPlugin(app, {} as PluginManifest);
	vi.spyOn(plugin, "loadData").mockResolvedValue({ ...DEFAULT_SETTINGS, language: "ru", serverUrl: "http://model/v1", model: "диалог", contextWindow: "32768", excludedFolders: ["Личное"], systemPrompt: "НЕ ОТПРАВЛЯТЬ" });
	vi.spyOn(plugin.serverClient, "listModels").mockResolvedValue({ ok: true, value: ["диалог"] });
	vi.spyOn(plugin.serverClient, "getContextWindow").mockResolvedValue({ ok: true, value: undefined });
	const chat = vi.spyOn(plugin.serverClient, "chat").mockResolvedValue({ ok: true, value: { content: JSON.stringify({ outcome: "recommendations", explanation: "По назначению заметки", candidates: [{ folder: "Знания", explanation: "Справка о методе" }] }) } });
	const commands = vi.spyOn(plugin, "addCommand");
	const hoverSource = vi.spyOn(plugin, "registerHoverLinkSource");
	await plugin.onload();
	view = new NoteReviewView({} as WorkspaceLeaf, plugin); Object.assign(view, { app }); await view.onOpen();
	const command = commands.mock.calls.find(([c]) => c.id === "suggest-note-folder")![0];
	const root = view.contentEl as unknown as TestElement;
	const start = async () => { command.callback!(); await flushPromises(); await vi.waitFor(() => expect(root.find("ai-helper-review-stop").disabled).toBe(true)); };
	const emit = (name: string, ...args: any[]) => events.get(name)?.forEach(cb => cb(...args));
	return { app, plugin, view, root, start, chat, ensureSideLeaf, file, files, folders, texts, editor, markdown, command, hoverSource, trigger: app.workspace.trigger as ReturnType<typeof vi.fn>, read, openFile, getLeaf, mainLeaves, create, renameFile, remove, emit, edit(value: string) { text = value; emit("editor-change", editor, { file }); } };
}

it("команда открывает отдельную правую вкладку и передаёт редактор, свойства и все содержательные описания без индекса", async () => {
	const s = await setup(); await s.start();
	expect(s.ensureSideLeaf).toHaveBeenCalledWith(VIEW_TYPE_NOTE_REVIEW, "right", { active: true, reveal: true });
	expect(s.chat).toHaveBeenCalledTimes(1);
	const [url, model, messages, params] = s.chat.mock.calls[0];
	expect([url, model]).toEqual(["http://model/v1", "диалог"]);
	const data = JSON.parse(messages[1].content);
	expect(data.note).toMatchObject({ title: "План", path: "Личное/План.md", properties: { статус: "активный" } });
	expect(data.note.text).toContain("Личный план");
	expect(data.folders.map((f: { folder: string }) => f.folder)).toEqual(["/", "Знания", "Знания/Проекты", "Личное"]);
	expect(data.folders[2].descriptions.map((d: { path: string }) => d.path)).toEqual(["_folder.md", "Знания/_folder.md", "Знания/Проекты/_folder.md"]);
	expect(JSON.stringify(messages)).not.toContain("НЕ ОТПРАВЛЯТЬ"); expect(params?.systemPrompt).toBeUndefined();
	expect(s.read.mock.calls.every(([f]) => f.name === "_folder.md")).toBe(true);
	expect(s.root.getText()).toContain("Личное/План.md"); expect(s.root.getText()).not.toContain("Личный план изучения");
	s.root.find("ai-helper-review-source").click(); await flushPromises();
	expect(s.openFile).toHaveBeenCalledWith(s.files.get("Знания/_folder.md"));
	expect(s.create).not.toHaveBeenCalled(); expect(s.renameFile).not.toHaveBeenCalled(); expect(s.remove).not.toHaveBeenCalled();
	await s.view.onClose();
});

it.each([
	["4.Archives/Работа/КПР-2025q4.md", "4.Archives/Работа", "КПР-2025q4.md", "КПР-2025q4"],
	["4.Archives/Работа/КПР/КПР-2025q4.md", "4.Archives/Работа/КПР", "КПР-2025q4.md", "КПР-2025q4"],
	["КПР-2025q4.md", "/", "КПР-2025q4.md", "КПР-2025q4"],
])("однозначно передаёт текущую папку и имя файла для %s", async (path, currentFolder, fileName, title) => {
	const s = await setup();
	const parentPath = currentFolder === "/" ? "" : currentFolder;
	if (!s.folders.has(parentPath)) s.folders.set(parentPath, Object.assign(new TFolder(), { path: parentPath }));
	await s.renameFile(s.file, path);
	Object.assign(s.file, { name: fileName, basename: title });
	s.edit("Командный план развития за четвёртый квартал 2025 года.");
	await s.start();
	const messages = s.chat.mock.calls[0][2];
	expect(JSON.parse(messages[1].content).note).toMatchObject({ path, currentFolder, fileName, title });
	expect(messages[0].content).toContain("note.currentFolder");
	expect(messages[0].content).toContain("note.fileName");
	await s.view.onClose();
});

it("отмечает изменения во время и после запроса, обновляет текущий текст без автоматических запросов", async () => {
	const s = await setup();
	const pending = deferred<ServerClientResult<ChatCompletionResult>>(); s.chat.mockReturnValueOnce(pending.promise);
	s.command.callback!(); await vi.waitFor(() => expect(s.chat).toHaveBeenCalledTimes(1));
	s.edit("---\nстатус: завершён\n---\nОбновлённое содержание");
	expect(s.root.getText()).toContain("Рекомендации устарели"); expect(s.chat).toHaveBeenCalledTimes(1);
	pending.resolve({ ok: true, value: { content: '{"outcome":"stay","explanation":"Текущее место подходит","candidates":[]}' } });
	await vi.waitFor(() => expect(s.root.getText()).toContain("Оставить в текущей папке"));
	expect(s.root.getText()).toContain("Рекомендации устарели");
	s.root.find("ai-helper-review-refresh").click(); await vi.waitFor(() => expect(s.chat).toHaveBeenCalledTimes(2)); await flushPromises();
	expect(JSON.parse(s.chat.mock.calls[1][2][1].content).note.properties).toEqual({ статус: "завершён" });
	expect(s.root.getText()).not.toContain("Рекомендации устарели");
	s.file.basename = "Новый план"; s.file.path = "Личное/Новый план.md"; s.emit("rename", s.file, "Личное/План.md");
	expect(s.root.getText()).toContain("Рекомендации устарели"); expect(s.chat).toHaveBeenCalledTimes(2);
	await s.view.onClose();
});

it.each(["stop", "close"])("игнорирует поздний результат после %s и допускает повтор после остановки", async action => {
	const s = await setup(); const pending = deferred<ServerClientResult<ChatCompletionResult>>(); s.chat.mockReturnValueOnce(pending.promise);
	s.command.callback!(); await vi.waitFor(() => expect(s.chat).toHaveBeenCalledTimes(1));
	if (action === "stop") s.root.find("ai-helper-review-stop").click(); else await s.view.onClose();
	expect(s.chat.mock.calls[0][3]?.signal?.aborted).toBe(true);
	pending.resolve({ ok: true, value: { content: '{"outcome":"none","explanation":"ПОЗДНИЙ РЕЗУЛЬТАТ","candidates":[]}' } }); await flushPromises();
	expect(s.root.getText()).not.toContain("ПОЗДНИЙ РЕЗУЛЬТАТ");
	if (action === "stop") { s.root.find("ai-helper-review-refresh").click(); await vi.waitFor(() => expect(s.chat).toHaveBeenCalledTimes(2)); await flushPromises(); expect(s.root.getText()).toContain("Справка о методе"); }
	await s.view.onClose();
});

it.each([
	'не JSON',
	'{"outcome":"recommendations","explanation":"Совет","candidates":[{"folder":"Выдумка","explanation":"Здесь"}]}',
	'{"outcome":"recommendations","explanation":"Совет","candidates":[{"folder":"Пустая","explanation":"Здесь"}]}',
	'{"outcome":"recommendations","explanation":"Совет","candidates":[{"folder":"Знания","explanation":"Первый"},{"folder":"Знания","explanation":"Второй"}]}',
])( "отклоняет некорректный ответ %s без файловых действий", async content => {
	const s = await setup(); s.chat.mockResolvedValueOnce({ ok: true, value: { content } }); await s.start();
	expect(s.root.getText()).toContain("некорректную рекомендацию");
	expect(() => s.root.find("ai-helper-review-source")).toThrow();
	expect(() => s.root.find("ai-helper-review-move")).toThrow();
	expect(s.create).not.toHaveBeenCalled(); expect(s.renameFile).not.toHaveBeenCalled(); expect(s.openFile).not.toHaveBeenCalled();
	await s.view.onClose();
});

it.each(["stay", "none", "insufficient"] as const)("показывает допустимый исход %s без кандидатов", async outcome => {
	const s = await setup(); s.chat.mockResolvedValueOnce({ ok: true, value: { content: JSON.stringify({ outcome, explanation: "Обоснование результата", candidates: [] }) } }); await s.start();
	expect(s.root.getText()).toContain("Обоснование результата"); expect(() => s.root.find("ai-helper-review-source")).toThrow();
	expect(() => s.root.find("ai-helper-review-move")).toThrow();
	await s.view.onClose();
});

it("останавливает превышение контекста без усечения и позволяет повторить после исправления настроек", async () => {
	const s = await setup(); s.plugin.settings.contextWindow = "1000"; await s.start();
	expect(s.chat).not.toHaveBeenCalled(); expect(s.root.getText()).toContain("Ничего не усекалось");
	s.plugin.settings.contextWindow = "32768"; s.root.find("ai-helper-review-refresh").click(); await vi.waitFor(() => expect(s.chat).toHaveBeenCalledTimes(1)); await flushPromises();
	expect(JSON.parse(s.chat.mock.calls[0][2][1].content).folders).toHaveLength(4);
	await s.view.onClose();
});

it("отображает ошибку модель-сервера и допускает повтор", async () => {
	const s = await setup(); s.chat.mockResolvedValueOnce({ ok: false, error: { message: "Ошибка сети" } }); await s.start();
	expect(s.root.getText()).toContain("Ошибка запроса к модель-серверу");
	s.root.find("ai-helper-review-refresh").click(); await vi.waitFor(() => expect(s.chat).toHaveBeenCalledTimes(2)); await flushPromises();
	expect(s.root.getText()).toContain("Справка о методе"); await s.view.onClose();
});

it("не открывает изменившееся описание и не принимает исчезнувшую папку", async () => {
	const s = await setup(); await s.start();
	s.texts.set("Знания/_folder.md", "Изменённые правила"); s.emit("modify", s.files.get("Знания/_folder.md"));
	expect(s.root.getText()).toContain("Рекомендации устарели");
	s.root.find("ai-helper-review-source").click(); await flushPromises(); expect(s.openFile).not.toHaveBeenCalled(); expect(s.root.getText()).toContain("Описание изменилось");
	s.folders.delete("Знания"); s.root.find("ai-helper-review-refresh").click(); await vi.waitFor(() => expect(s.chat).toHaveBeenCalledTimes(2)); await flushPromises();
	expect(s.root.getText()).toContain("некорректную рекомендацию"); await s.view.onClose();
});

it("использует настроенное имя описания и русский/английский интерфейс", async () => {
	const s = await setup(); s.plugin.settings.folderDescriptionName = "Правила.md";
	const original = s.files.get("Знания/_folder.md")!; const file = Object.assign(new TFile(), { ...original, path: "Знания/Правила.md", name: "Правила.md" });
	s.files.set(file.path, file); s.texts.set(file.path, "Reference materials."); setLanguage("en"); await s.start();
	expect(JSON.parse(s.chat.mock.calls[0][2][1].content).folders.map((f: { path: string }) => f.path)).toEqual([file.path]);
	expect(s.root.getText()).toContain("Note review"); expect(s.chat.mock.calls[0][2][0].content).toContain("English");
	await s.view.onClose();
});

it("устаревает при изменении любого переданного описания, включая невыбранную папку", async () => {
	const s = await setup(); await s.start();
	s.texts.set("Личное/_folder.md", "Теперь эта папка тоже подходит для справки"); s.emit("modify", s.files.get("Личное/_folder.md"));
	expect(s.root.getText()).toContain("Рекомендации устарели"); expect(s.chat).toHaveBeenCalledTimes(1);
	await s.view.onClose();
});

it("согласует резерв контекста с лимитом ответа и сообщает об изменении описания во время запроса без требования индекса", async () => {
	const s = await setup(); const pending = deferred<ServerClientResult<ChatCompletionResult>>(); s.chat.mockReturnValueOnce(pending.promise);
	s.command.callback!(); await vi.waitFor(() => expect(s.chat).toHaveBeenCalledTimes(1));
	expect(s.chat.mock.calls[0][3]?.maxTokens).toBe("1024");
	s.texts.set("Знания/_folder.md", "Новые правила");
	pending.resolve({ ok: true, value: { content: '{"outcome":"recommendations","explanation":"Совет","candidates":[{"folder":"Знания","explanation":"Справка"}]}' } });
	await vi.waitFor(() => expect(s.root.getText()).toContain("Описание изменилось"));
	expect(s.root.getText()).not.toContain("Проиндексируйте"); await s.view.onClose();
});

it("отклоняет проценты уверенности в объяснениях", async () => {
	const s = await setup(); s.chat.mockResolvedValueOnce({ ok: true, value: { content: '{"outcome":"recommendations","explanation":"Совет","candidates":[{"folder":"Знания","explanation":"Уверенность 95%"}]}' } }); await s.start();
	expect(s.root.getText()).toContain("некорректную рекомендацию"); expect(s.root.getText()).not.toContain("95%"); await s.view.onClose();
});

it("отмечает новый набор кандидатов после заполнения пустого описания и создания нового", async () => {
	const s = await setup(); await s.start(); s.texts.set("Пустая/_folder.md", "Теперь здесь справка"); s.emit("modify", s.files.get("Пустая/_folder.md"));
	expect(s.root.getText()).toContain("Рекомендации устарели");
	s.root.find("ai-helper-review-refresh").click(); await vi.waitFor(() => expect(s.chat).toHaveBeenCalledTimes(2)); await flushPromises();
	expect(JSON.parse(s.chat.mock.calls[1][2][1].content).folders).toHaveLength(5);
	s.emit("create", { path: "Новая/_folder.md" }); expect(s.root.getText()).toContain("Рекомендации устарели"); await s.view.onClose();
});

it("регистрирует нативное превью и показывает его при наведении на проверенное описание", async () => {
	const s = await setup(); await s.start();
	expect(s.hoverSource).toHaveBeenCalledWith(VIEW_TYPE_NOTE_REVIEW, expect.objectContaining({ defaultMod: true }));
	const link = s.root.find("ai-helper-review-source");
	link.dispatchEvent({ type: "mouseover", stopPropagation() {} } as any); await flushPromises();
	expect(s.trigger).toHaveBeenCalledWith("hover-link", expect.objectContaining({ source: VIEW_TYPE_NOTE_REVIEW, hoverParent: s.view, targetEl: link, linktext: "Знания/_folder.md" }));
	await s.view.onClose();
});

it("анимирует ожидание тем же стилем, что и чат, и прекращает его при остановке", async () => {
	const s = await setup(); const pending = deferred<ServerClientResult<ChatCompletionResult>>(); s.chat.mockReturnValueOnce(pending.promise);
	s.command.callback!(); await vi.waitFor(() => expect(s.chat).toHaveBeenCalledTimes(1));
	expect(s.root.find("ai-helper-thinking").getText()).toBe("Анализ заметки…");
	s.root.find("ai-helper-review-stop").click(); expect(() => s.root.find("ai-helper-thinking")).toThrow();
	pending.resolve({ ok: false, error: { message: "Остановка" } }); await flushPromises(); await s.view.onClose();
});

it("команда доступна в режиме чтения и анализирует отображаемый текст, а не неактивный редактор", async () => {
	const s = await setup(); s.markdown.getMode = () => "preview";
	s.markdown.getViewData = () => "Текст открытой заметки в режиме чтения";
	expect(s.command.editorCallback).toBeUndefined(); expect(s.command.callback).toBeTypeOf("function");
	s.command.callback!(); await vi.waitFor(() => expect(s.chat).toHaveBeenCalledTimes(1)); await flushPromises();
	expect(JSON.parse(s.chat.mock.calls[0][2][1].content).note.text).toBe("Текст открытой заметки в режиме чтения");
	await s.view.onClose();
});

it.each(["mouseleave", "close", "refresh"] as const)("не показывает запоздалое превью после %s", async action => {
	const s = await setup(); await s.start(); const link = s.root.find("ai-helper-review-source");
	const pending = deferred<string>(); s.read.mockReturnValueOnce(pending.promise);
	link.dispatchEvent({ type: "mouseover", stopPropagation() {} } as any);
	if (action === "mouseleave") link.dispatchEvent({ type: "mouseleave" });
	else if (action === "close") await s.view.onClose();
	else s.root.find("ai-helper-review-refresh").click();
	pending.resolve(s.texts.get("_folder.md")!); await flushPromises();
	expect(s.trigger).not.toHaveBeenCalledWith("hover-link", expect.anything()); await s.view.onClose();
});

it("не показывает превью описания, которое изменилось после анализа", async () => {
	const s = await setup(); await s.start(); s.texts.set("Знания/_folder.md", "Другие критерии");
	s.root.find("ai-helper-review-source").dispatchEvent({ type: "mouseover", stopPropagation() {} } as any); await flushPromises();
	expect(s.trigger).not.toHaveBeenCalledWith("hover-link", expect.anything()); await s.view.onClose();
});


it("переносит только после явного действия, сохраняет текст и свойства редактора", async () => {
	const s = await setup(); await s.start();
	expect(s.files.has("Личное/План.md")).toBe(true);
	s.root.find("ai-helper-review-move").click();
	await vi.waitFor(() => expect(s.root.getText()).toContain("Заметка перенесена"));
	expect(s.files.has("Личное/План.md")).toBe(false);
	expect(s.files.get("Знания/План.md")).toBe(s.file);
	expect(s.texts.get("Знания/План.md")).toBe("---\nстатус: активный\n---\nЛичный план изучения GTD [[Секрет]]");
	expect(s.renameFile).toHaveBeenCalledTimes(1);
	await s.view.onClose();
});

it("требует отдельного выбора прежних рекомендаций и переносит последнюю редакцию без нового анализа", async () => {
	const s = await setup(); await s.start();
	s.edit("---\nстатус: завершён\n---\nИзменённый пользователем текст [[Секрет]]");
	expect(() => s.root.find("ai-helper-review-move")).toThrow();
	s.root.find("ai-helper-review-move-old").click();
	await vi.waitFor(() => expect(s.root.getText()).toContain("Заметка перенесена"));
	expect(s.texts.get("Знания/План.md")).toBe("---\nстатус: завершён\n---\nИзменённый пользователем текст [[Секрет]]");
	expect(s.chat).toHaveBeenCalledTimes(1); await s.view.onClose();
});

it.each(["описание", "родитель", "невыбранное описание", "пустое описание", "настройка", "файл", "папка"])("останавливает перенос при изменении: %s", async change => {
	const s = await setup(); await s.start();
	if (change === "описание") s.texts.set("Знания/_folder.md", "Новые критерии");
	if (change === "родитель") s.texts.set("_folder.md", "Новые общие правила");
	if (change === "невыбранное описание") s.texts.set("Личное/_folder.md", "Справка тоже подходит");
	if (change === "пустое описание") s.texts.set("Пустая/_folder.md", "Теперь есть назначение");
	if (change === "настройка") s.plugin.settings.folderDescriptionName = "Правила.md";
	if (change === "файл") s.files.delete(s.file.path);
	if (change === "папка") s.folders.delete("Знания");
	s.edit("Изменённая заметка"); s.root.find("ai-helper-review-move-old").click(); await flushPromises();
	expect(s.renameFile).not.toHaveBeenCalled();
	expect(s.root.getText()).toContain(change === "файл" ? "Заметка больше недоступна" : change === "папка" ? "Папка назначения больше не существует" : "Описание изменилось");
	expect(s.texts.get("Личное/План.md")).toBe("Сохранённый текст"); await s.view.onClose();
});

it("обновляет рекомендации после редактирования и переносит новую версию обычной кнопкой", async () => {
	const s = await setup(); await s.start(); s.edit("Новая справка о методе");
	s.root.find("ai-helper-review-refresh").click(); await vi.waitFor(() => expect(s.chat).toHaveBeenCalledTimes(2)); await flushPromises();
	expect(JSON.parse(s.chat.mock.calls[1][2][1].content).note.text).toBe("Новая справка о методе");
	s.root.find("ai-helper-review-move").click(); await vi.waitFor(() => expect(s.files.has("Знания/План.md")).toBe(true));
	expect(s.texts.get("Знания/План.md")).toBe("Новая справка о методе"); await s.view.onClose();
});

it("при конфликте сохраняет оба файла и открывает существующий по отдельной кнопке", async () => {
	const s = await setup(); await s.start();
	const existing = Object.assign(new TFile(), { path: "Знания/План.md", name: "План.md" });
	s.files.set(existing.path, existing); s.texts.set(existing.path, "Существующий файл");
	s.root.find("ai-helper-review-move").click(); await vi.waitFor(() => expect(s.root.getText()).toContain("Перенос остановлен"));
	expect(s.texts.get(existing.path)).toBe("Существующий файл"); expect(s.texts.get(s.file.path)).toBe("Сохранённый текст");
	expect(s.renameFile).not.toHaveBeenCalled(); expect(s.openFile).not.toHaveBeenCalled();
	s.root.find("ai-helper-review-open-conflict").click(); await flushPromises(); expect(s.openFile).toHaveBeenCalledWith(existing);
	await s.view.onClose();
});

it("не сообщает успех при ошибке переноса и позволяет повторить", async () => {
	const s = await setup(); await s.start(); s.renameFile.mockRejectedValueOnce(new Error("Ошибка диска"));
	s.root.find("ai-helper-review-move").click(); await vi.waitFor(() => expect(s.root.getText()).toContain("Не удалось перенести"));
	expect(s.files.get("Личное/План.md")).toBe(s.file); expect(s.files.has("Знания/План.md")).toBe(false);
	expect(s.root.getText()).not.toContain("Заметка перенесена");
	s.root.find("ai-helper-review-move").click(); await vi.waitFor(() => expect(s.root.getText()).toContain("Заметка перенесена")); await s.view.onClose();
});

it.each(["/", "Личное"])("не делает фиктивный перенос и поддерживает корень: %s", async folder => {
	const s = await setup(); s.chat.mockResolvedValueOnce({ ok: true, value: { content: JSON.stringify({ outcome: "recommendations", explanation: "Совет", candidates: [{ folder, explanation: "Подходит" }] }) } }); await s.start();
	s.root.find("ai-helper-review-move").click(); await flushPromises();
	if (folder === "/") { await vi.waitFor(() => expect(s.files.get("План.md")).toBe(s.file)); expect(s.texts.get("План.md")).toContain("Личный план"); }
	else { await vi.waitFor(() => expect(s.root.getText()).toContain("Оставить в текущей папке")); expect(s.renameFile).not.toHaveBeenCalled(); }
	await s.view.onClose();
});

it("не переносит после закрытия панели во время проверки и не выполняет двойной перенос", async () => {
	const s = await setup(); await s.start(); const pending = deferred<string>(); s.read.mockReturnValueOnce(pending.promise);
	const button = s.root.find("ai-helper-review-move"); button.click(); button.click();
	await s.view.onClose(); pending.resolve(s.texts.get("_folder.md")!); await flushPromises();
	expect(s.renameFile).not.toHaveBeenCalled(); expect(s.files.get("Личное/План.md")).toBe(s.file);
});


it("отклоняет новое содержательное описание, появившееся при сохранении редактора", async () => {
	const s = await setup(); await s.start();
	Object.assign(s.markdown, { save: async () => { s.texts.set("Пустая/_folder.md", "Новое назначение"); } });
	s.root.find("ai-helper-review-move").click();
	await vi.waitFor(() => expect(s.root.getText()).toContain("Описание изменилось"));
	expect(s.renameFile).not.toHaveBeenCalled(); await s.view.onClose();
});

it("завершение предыдущего переноса не стирает рекомендации другой заметки", async () => {
	const s = await setup(); await s.start();
	const pending = deferred<void>(), rename = s.renameFile.getMockImplementation()!;
	s.renameFile.mockImplementationOnce(async (file, path) => { await pending.promise; await rename(file, path); });
	s.root.find("ai-helper-review-move").click(); await vi.waitFor(() => expect(s.renameFile).toHaveBeenCalledTimes(1));
	const other = s.files.get("Секрет.md")!;
	s.chat.mockResolvedValueOnce({ ok: true, value: { content: '{"outcome":"none","explanation":"Результат другой заметки","candidates":[]}' } });
	await s.view.analyze(other, { getValue: () => "Другая заметка" });
	pending.resolve(); await vi.waitFor(() => expect(s.files.has("Знания/План.md")).toBe(true)); await flushPromises();
	expect(s.root.getText()).toContain("Результат другой заметки"); expect(s.root.getText()).not.toContain("Заметка перенесена"); await s.view.onClose();
});


it("изменение описания во время последней проверки конфликта останавливает перенос по прежним рекомендациям", async () => {
	const s = await setup(); await s.start(); s.edit("Новая редакция заметки");
	const pending = deferred<boolean>();
	const exists = vi.mocked(s.app.vault.adapter.exists);
	exists.mockResolvedValueOnce(false).mockReturnValueOnce(pending.promise);
	s.root.find("ai-helper-review-move-old").click(); await vi.waitFor(() => expect(exists).toHaveBeenCalledTimes(2));
	s.texts.set("Знания/_folder.md", "Новые критерии"); s.emit("modify", s.files.get("Знания/_folder.md"));
	pending.resolve(false); await flushPromises();
	expect(s.renameFile).not.toHaveBeenCalled(); expect(s.root.getText()).toContain("Описание изменилось");
	expect(s.files.get("Личное/План.md")).toBe(s.file); await s.view.onClose();
});

async function folderMenu(s: Awaited<ReturnType<typeof setup>>, folder: TFolder) {
	const { Menu } = await import("./helpers/obsidian");
	const menu = new Menu(); s.emit("file-menu", menu, folder);
	const action = menu.items.find(item => item.title === "Разобрать заметки");
	expect(action).toBeDefined(); action!.callback!(); await flushPromises();
}

it("меню исключённой папки показывает область и счётчик до запуска, включая вложенные заметки по выбору", async () => {
	const s = await setup();
	const nested = Object.assign(new TFile(), { path: "Личное/Вложенная/Запись.md", name: "Запись.md", basename: "Запись", extension: "md" });
	s.files.set(nested.path, nested); s.texts.set(nested.path, "Вложенная запись");
	await folderMenu(s, s.folders.get("Личное")!);
	expect(s.root.getText()).toContain("Заметок: 1"); expect(s.chat).not.toHaveBeenCalled();
	const checkbox = s.root.find("ai-helper-review-recursive");
	expect(checkbox.checked).toBe(false); checkbox.checked = true; checkbox.dispatchEvent({ type: "change" } as Event);
	expect(s.root.getText()).toContain("Заметок: 2");
	s.root.find("ai-helper-review-start").click(); await flushPromises();
	expect(s.openFile).toHaveBeenNthCalledWith(1, nested, { active: true, state: { mode: "preview" } });
	expect(JSON.parse(s.chat.mock.calls[0][2][1].content).note.text).toBe("Вложенная запись");
	s.root.find("ai-helper-review-skip").click(); await flushPromises();
	expect(s.openFile).toHaveBeenNthCalledWith(2, s.file, { active: true, state: { mode: "preview" } });
	expect(JSON.parse(s.chat.mock.calls[1][2][1].content).note.text).toContain("Личный план");
	await s.view.onClose();
});

function addQueueFile(s: Awaited<ReturnType<typeof setup>>, path: string, text = "Свежая справка") {
	const file = Object.assign(new TFile(), { path, name: path.split("/").at(-1)!, basename: path.split("/").at(-1)!.replace(/\.md$/, ""), extension: "md" });
	s.files.set(path, file); s.texts.set(path, text); return file;
}

it("перенос по прежним рекомендациям сохраняет редактор, пропуск завершает очередь и новый запуск собирает текущие файлы", async () => {
	const s = await setup(); addQueueFile(s, "Личное/Я.md", "Вторая заметка");
	await folderMenu(s, s.folders.get("Личное")!); s.root.find("ai-helper-review-start").click(); await flushPromises();
	await vi.waitFor(() => expect(s.root.getText()).toContain("Рекомендации готовы"));
	s.edit("Обновлённая справка о методе");
	s.root.find("ai-helper-review-move-old").click();
	await vi.waitFor(() => expect(s.openFile).toHaveBeenCalledTimes(2)); await flushPromises();
	expect(s.texts.get("Знания/План.md")).toBe("Обновлённая справка о методе");
	expect(s.root.getText()).toContain("Личное/Я.md"); expect(s.root.getText()).toContain("Перенесено: 1");
	s.root.find("ai-helper-review-skip").click(); await flushPromises();
	expect(s.root.getText()).toContain("Разбор завершён.");
	expect(s.root.getText()).toContain("Пропущено: 1; Осталось: 0");
	await folderMenu(s, s.folders.get("Личное")!);
	expect(s.root.getText()).toContain("Заметок: 1"); expect(s.root.getText()).not.toContain("Перенесено: 1");
	await s.view.onClose(); await s.view.onOpen();
	expect(s.root.getText()).not.toContain("Личное/Я.md"); expect(s.root.getText()).not.toContain("Перенесено:");
	await s.view.onClose();
});

it("удалённая до анализа заметка отмечается, остальные читаются непосредственно перед своим запросом", async () => {
	const s = await setup(); const deleted = addQueueFile(s, "Личное/Р.md"); const next = addQueueFile(s, "Личное/Я.md", "Старая версия");
	await folderMenu(s, s.folders.get("Личное")!); s.root.find("ai-helper-review-start").click();
	await vi.waitFor(() => expect(s.root.getText()).toContain("Рекомендации готовы"));
	s.files.delete(deleted.path); s.texts.delete(deleted.path); s.texts.set(next.path, "Новая версия перед анализом");
	s.root.find("ai-helper-review-skip").click();
	await vi.waitFor(() => expect(s.chat).toHaveBeenCalledTimes(2));
	expect(JSON.parse(s.chat.mock.calls[1][2][1].content).note.text).toBe("Новая версия перед анализом");
	expect(s.root.getText()).toContain("Удалены до анализа: Личное/Р.md"); expect(s.root.getText()).toContain("Пропущено: 2; Осталось: 1");
	expect(s.openFile).not.toHaveBeenCalledWith(deleted); expect(s.renameFile).not.toHaveBeenCalled();
	await s.view.onClose();
});

it.each(["server", "invalid", "budget"])("ошибка %s сохраняет позицию, повтор использует текущий редактор, завершение отменяет запрос и поздний ответ", async error => {
	const s = await setup(); addQueueFile(s, "Личное/Я.md");
	if (error === "server") s.chat.mockResolvedValueOnce({ ok: false, error: { message: "Сбой" } });
	if (error === "invalid") s.chat.mockResolvedValueOnce({ ok: true, value: { content: "Некорректно" } });
	if (error === "budget") s.plugin.settings.contextWindow = "100";
	await folderMenu(s, s.folders.get("Личное")!); s.root.find("ai-helper-review-start").click();
	await vi.waitFor(() => expect(s.root.getText()).toContain(error === "server" ? "Ошибка запроса" : error === "invalid" ? "некорректную рекомендацию" : "Ничего не усекалось"));
	expect(s.openFile).toHaveBeenCalledTimes(1); expect(s.root.getText()).toContain("Личное/План.md");
	expect(s.root.getText()).toContain("Осталось: 2");
	s.plugin.settings.contextWindow = "32768"; s.edit("Текст для повтора");
	const pending = deferred<ServerClientResult<ChatCompletionResult>>(); s.chat.mockReturnValueOnce(pending.promise);
	s.root.find("ai-helper-review-refresh").click();
	await vi.waitFor(() => expect(s.chat).toHaveBeenCalledTimes(error === "budget" ? 1 : 2));
	const call = s.chat.mock.calls.at(-1)!;
	expect(JSON.parse(call[2][1].content).note.text).toBe("Текст для повтора");
	s.root.find("ai-helper-review-finish").click(); expect(call[3]?.signal?.aborted).toBe(true);
	expect(s.root.getText()).toContain("Разбор завершён."); expect(s.root.getText()).toContain("Перенесено: 0; Пропущено: 0; Осталось: 2");
	pending.resolve({ ok: true, value: { content: '{"outcome":"stay","explanation":"Поздний ответ","candidates":[]}' } }); await flushPromises();
	expect(s.root.getText()).not.toContain("Поздний ответ"); expect(s.openFile).toHaveBeenCalledTimes(1); expect(s.renameFile).not.toHaveBeenCalled();
	await s.view.onClose();
});

it("новый запуск во время открытия отменяет прежний переход и настроенное описание исключено из счётчика", async () => {
	const s = await setup(); s.plugin.settings.folderDescriptionName = "Правила.md";
	addQueueFile(s, "Личное/Правила.md", "Правила папки");
	await folderMenu(s, s.folders.get("Личное")!);
	expect(s.root.getText()).toContain("Заметок: 2"); // прежний _folder.md теперь обычная заметка
	const opening = deferred<void>(); s.openFile.mockReturnValueOnce(opening.promise);
	s.root.find("ai-helper-review-start").click(); await flushPromises();
	s.root.find("ai-helper-review-finish").click();
	await folderMenu(s, s.folders.get("Личное")!);
	opening.resolve(); await flushPromises();
	expect(s.chat).not.toHaveBeenCalled(); expect(s.root.getText()).toContain("Заметок: 2");
	await s.view.onClose();
});

it("ошибка открытия сохраняет путь и допускает повтор или пропуск, меню есть в корне и локализовано", async () => {
	const s = await setup(); const { Menu } = await import("./helpers/obsidian");
	setLanguage("en"); const fileMenu = new Menu(); s.emit("file-menu", fileMenu, s.file);
	expect(fileMenu.items.some(item => item.title === "Review notes")).toBe(false);
	const rootMenu = new Menu(); s.emit("file-menu", rootMenu, s.folders.get("")!);
	rootMenu.items.find(item => item.title === "Review notes")!.callback(); await flushPromises();
	expect(s.root.getText()).toContain("Notes: 1"); expect(s.root.getText()).toContain("Include subfolders");
	s.openFile.mockRejectedValueOnce(new Error("Открытие не удалось"));
	s.root.find("ai-helper-review-start").click();
	await vi.waitFor(() => expect(s.root.getText()).toContain("Could not analyze"));
	expect(s.root.getText()).toContain("Секрет.md"); expect(s.chat).not.toHaveBeenCalled();
	s.root.find("ai-helper-review-refresh").click();
	await vi.waitFor(() => expect(s.root.getText()).toContain("Recommendations are ready"));
	s.root.find("ai-helper-review-skip").click(); await flushPromises();
	expect(s.root.getText()).toContain("Review finished."); expect(s.root.getText()).toContain("Skipped: 1; Remaining: 0");
	await s.view.onClose();
});

it("после перехода к следующей заметке повтор и перенос используют её текущий редактор", async () => {
	const s = await setup(); const next = addQueueFile(s, "Личное/Я.md");
	let nextText = "Несохранённый текст следующей заметки";
	const nextEditor = { getValue: () => nextText };
	s.openFile.mockImplementation(async () => {
		if (s.openFile.mock.calls.length === 2) Object.assign(s.markdown, { file: next, editor: nextEditor, save: async () => { s.texts.set(next.path, nextText); } });
	});
	await folderMenu(s, s.folders.get("Личное")!); s.root.find("ai-helper-review-start").click();
	await vi.waitFor(() => expect(s.root.getText()).toContain("Рекомендации готовы"));
	s.root.find("ai-helper-review-skip").click();
	await vi.waitFor(() => expect(s.chat).toHaveBeenCalledTimes(2));
	expect(JSON.parse(s.chat.mock.calls[1][2][1].content).note.text).toBe(nextText);
	await vi.waitFor(() => expect(s.root.getText()).toContain("Рекомендации готовы"));
	nextText = "Новая редакция следующей заметки"; s.emit("editor-change", nextEditor, { file: next });
	expect(s.root.getText()).toContain("Рекомендации устарели");
	s.root.find("ai-helper-review-refresh").click();
	await vi.waitFor(() => expect(s.chat).toHaveBeenCalledTimes(3));
	expect(JSON.parse(s.chat.mock.calls[2][2][1].content).note.text).toBe(nextText);
	await vi.waitFor(() => expect(s.root.getText()).toContain("Рекомендации готовы"));
	s.root.find("ai-helper-review-move").click();
	await vi.waitFor(() => expect(s.root.getText()).toContain("Разбор завершён."));
	expect(s.texts.get("Знания/Я.md")).toBe(nextText);
	expect(s.root.getText()).toContain("Перенесено: 1; Пропущено: 1; Осталось: 0");
	await s.view.onClose();
});

it("открытие описания вместо исходного редактора не делает неизменённую заметку устаревшей", async () => {
	const s = await setup();
	// Редактор и диск содержат одну и ту же неизменённую заметку.
	s.edit("Сохранённый текст");
	await folderMenu(s, s.folders.get("Личное")!); s.root.find("ai-helper-review-start").click();
	await vi.waitFor(() => expect(s.root.getText()).toContain("Рекомендации готовы"));
	s.root.find("ai-helper-review-source").click(); await flushPromises();
	Object.assign(s.markdown, { file: s.files.get("Знания/_folder.md") });
	s.root.find("ai-helper-review-move").click();
	await vi.waitFor(() => expect(s.root.getText()).toContain("Разбор завершён."));
	expect(s.files.get("Знания/План.md")).toBe(s.file);
	await s.view.onClose();
});

it("предварительный счётчик обновляется после создания, переименования и удаления заметки", async () => {
	const s = await setup(); const folder = Object.assign(new TFolder(), { path: "Новая" }); s.folders.set(folder.path, folder);
	await folderMenu(s, folder); expect(s.root.getText()).toContain("Заметок: 0"); expect(s.root.find("ai-helper-review-start").disabled).toBe(true);
	const file = addQueueFile(s, "Новая/Запись.md"); s.emit("create", file);
	expect(s.root.getText()).toContain("Заметок: 1"); expect(s.root.find("ai-helper-review-start").disabled).toBe(false);
	file.path = "Личное/Запись.md"; s.emit("rename", file, "Новая/Запись.md"); expect(s.root.getText()).toContain("Заметок: 0");
	file.path = "Новая/Запись.md"; s.emit("rename", file, "Личное/Запись.md");
	s.files.delete("Новая/Запись.md"); s.emit("delete", file); expect(s.root.getText()).toContain("Заметок: 0");
	expect(s.chat).not.toHaveBeenCalled(); await s.view.onClose();
});

it("новая очередь по умолчанию открывает заметки в режиме чтения и использует одну отдельную вкладку", async () => {
	const s = await setup(); addQueueFile(s, "Личное/Я.md");
	await folderMenu(s, s.folders.get("Личное")!);
	expect(s.root.find("ai-helper-review-reading").checked).toBe(true);
	expect(s.root.find("ai-helper-review-separate-tab").checked).toBe(true);
	s.root.find("ai-helper-review-start").click();
	await vi.waitFor(() => expect(s.root.getText()).toContain("Рекомендации готовы"));
	expect(s.getLeaf).toHaveBeenCalledWith("tab");
	expect(s.openFile).toHaveBeenCalledWith(s.file, { active: true, state: { mode: "preview" } });
	s.root.find("ai-helper-review-skip").click();
	await vi.waitFor(() => expect(s.chat).toHaveBeenCalledTimes(2));
	expect(s.getLeaf).toHaveBeenCalledTimes(1);
	expect(s.openFile.mock.calls[1][1]).toEqual({ active: true, state: { mode: "preview" } });
	await s.view.onClose();
});

it("кликабельные название и путь возвращают к текущей заметке после перехода по ссылке без нового анализа", async () => {
	const s = await setup(); await folderMenu(s, s.folders.get("Личное")!);
	s.root.find("ai-helper-review-start").click();
	await vi.waitFor(() => expect(s.root.getText()).toContain("Рекомендации готовы"));
	Object.assign(s.markdown, { file: s.files.get("Секрет.md") });
	const path = s.root.find("ai-helper-review-note-path");
	expect(path.attributes["data-href"]).toBe("Личное/План.md");
	path.click(); await flushPromises();
	expect(s.openFile).toHaveBeenLastCalledWith(s.file, { active: true, state: { mode: "preview" } });
	expect(s.getLeaf).toHaveBeenCalledTimes(1); expect(s.chat).toHaveBeenCalledTimes(1);
	s.root.find("ai-helper-review-note-title").click(); await flushPromises();
	expect(s.openFile).toHaveBeenCalledTimes(3); expect(s.chat).toHaveBeenCalledTimes(1);
	expect(s.root.getText()).toContain("Перенесено: 0; Пропущено: 0; Осталось: 1");
	await s.view.onClose();
});

it.each([
	{ reading: false, separate: false },
	{ reading: true, separate: false },
	{ reading: false, separate: true },
])("флажки применяются независимо: $reading чтение, $separate отдельная вкладка", async ({ reading, separate }) => {
	const s = await setup(); await folderMenu(s, s.folders.get("Личное")!);
	for (const [cls, checked] of [["ai-helper-review-reading", reading], ["ai-helper-review-separate-tab", separate]] as const) {
		const input = s.root.find(cls); input.checked = checked; input.dispatchEvent({ type: "change" });
	}
	s.root.find("ai-helper-review-start").click();
	await vi.waitFor(() => expect(s.root.getText()).toContain("Рекомендации готовы"));
	expect(s.getLeaf).toHaveBeenCalledWith(separate ? "tab" : false);
	expect(s.openFile).toHaveBeenCalledWith(s.file, reading ? { active: true, state: { mode: "preview" } } : { active: true });
	s.root.find("ai-helper-review-note-path").click(); await flushPromises();
	expect(s.openFile.mock.calls.at(-1)![1]).toEqual(reading ? { active: true, state: { mode: "preview" } } : { active: true });
	expect(s.chat).toHaveBeenCalledTimes(1);
	await folderMenu(s, s.folders.get("Личное")!);
	expect(s.root.find("ai-helper-review-reading").checked).toBe(true); expect(s.root.find("ai-helper-review-separate-tab").checked).toBe(true);
	await s.view.onClose();
});

it("ссылка создаёт новую вкладку после закрытия вкладки разбора, но не открывает удалённую заметку", async () => {
	const s = await setup(); await folderMenu(s, s.folders.get("Личное")!); s.root.find("ai-helper-review-start").click();
	await vi.waitFor(() => expect(s.root.getText()).toContain("Рекомендации готовы"));
	s.mainLeaves.clear();
	const replacement = { openFile: s.openFile }; s.getLeaf.mockReturnValueOnce(replacement); s.mainLeaves.add(replacement);
	s.root.find("ai-helper-review-note-path").click(); await flushPromises();
	expect(s.getLeaf).toHaveBeenCalledTimes(2); expect(s.getLeaf).toHaveBeenLastCalledWith("tab");
	expect(s.chat).toHaveBeenCalledTimes(1);
	s.files.delete(s.file.path); s.emit("delete", s.file);
	s.root.find("ai-helper-review-note-path").click(); await flushPromises();
	expect(s.openFile).toHaveBeenCalledTimes(2); expect(s.root.getText()).toContain("Заметка больше недоступна");
	await s.view.onClose();
});

it("возврат по пути отдельной заметки доступен и ошибка открытия не стирает рекомендации", async () => {
	const s = await setup(); await s.start();
	s.openFile.mockRejectedValueOnce(new Error("Ошибка открытия"));
	s.root.find("ai-helper-review-note-path").click();
	await vi.waitFor(() => expect(s.root.getText()).toContain("Не удалось открыть разбираемую заметку"));
	expect(s.root.getText()).toContain("Справка о методе");
	s.root.find("ai-helper-review-note-title").click(); await flushPromises();
	expect(s.openFile).toHaveBeenLastCalledWith(s.file); expect(s.chat).toHaveBeenCalledTimes(1);
	expect(s.root.getText()).not.toContain("Не удалось открыть разбираемую заметку");
	expect(s.root.getText()).toContain("Рекомендации готовы");
	await s.view.onClose();
});

it("отдельная вкладка чтения сохраняет несохранённый текст уже открытого редактора для анализа и переноса", async () => {
	const s = await setup();
	const preview = Object.assign(new MarkdownView({} as WorkspaceLeaf), { file: s.file, getMode: () => "preview", getViewData: () => "Сохранённый текст", save: vi.fn(async () => {}) });
	const originalLeaf = { view: s.markdown };
	const readingLeaf = { view: preview, openFile: s.openFile };
	s.getLeaf.mockReturnValueOnce(readingLeaf); s.mainLeaves.add(readingLeaf);
	Object.assign(s.app.workspace, { getLeavesOfType: (type: string) => type === "markdown" ? [originalLeaf, readingLeaf] : [] });
	await folderMenu(s, s.folders.get("Личное")!);
	Object.assign(s.app.workspace, { getActiveViewOfType: () => preview });
	s.root.find("ai-helper-review-start").click();
	await vi.waitFor(() => expect(s.root.getText()).toContain("Рекомендации готовы"));
	expect(JSON.parse(s.chat.mock.calls[0][2][1].content).note.text).toContain("Личный план изучения GTD");
	s.root.find("ai-helper-review-move").click();
	await vi.waitFor(() => expect(s.root.getText()).toContain("Разбор завершён."));
	expect(s.texts.get("Знания/План.md")).toContain("Личный план изучения GTD"); expect(preview.save).not.toHaveBeenCalled();
	await s.view.onClose();
});
