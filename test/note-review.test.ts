import { afterEach, expect, it, vi } from "vitest";
import { type App, type PluginManifest, TFile, TFolder, type WorkspaceLeaf } from "obsidian";
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
	const events = new Map<string, Array<(...args: any[]) => void>>();
	const on = (name: string, cb: (...args: any[]) => void) => { events.set(name, [...events.get(name) ?? [], cb]); return {}; };
	const openFile = vi.fn(async () => {}), create = vi.fn(), renameFile = vi.fn(), remove = vi.fn();
	const read = vi.fn(async (f: TFile) => texts.get(f.path)!);
	let view: NoteReviewView;
	const leaf = { get view() { return view; } };
	const ensureSideLeaf = vi.fn(async () => leaf);
	const app = { vault: { on, getMarkdownFiles: () => [...files.values()], getAbstractFileByPath: (path: string) => files.get(path) ?? folders.get(path), read, create, delete: remove }, fileManager: { renameFile }, workspace: { on, getLeavesOfType: () => [], ensureSideLeaf, getLeaf: () => ({ openFile }), trigger: vi.fn() } } as unknown as App;
	const plugin = new AiHelperPlugin(app, {} as PluginManifest);
	vi.spyOn(plugin, "loadData").mockResolvedValue({ ...DEFAULT_SETTINGS, language: "ru", serverUrl: "http://model/v1", model: "диалог", contextWindow: "32768", excludedFolders: ["Личное"], systemPrompt: "НЕ ОТПРАВЛЯТЬ" });
	vi.spyOn(plugin.serverClient, "listModels").mockResolvedValue({ ok: true, value: ["диалог"] });
	vi.spyOn(plugin.serverClient, "getContextWindow").mockResolvedValue({ ok: true, value: undefined });
	const chat = vi.spyOn(plugin.serverClient, "chat").mockResolvedValue({ ok: true, value: { content: JSON.stringify({ outcome: "recommendations", explanation: "По назначению заметки", candidates: [{ folder: "Знания", explanation: "Справка о методе" }] }) } });
	const commands = vi.spyOn(plugin, "addCommand");
	await plugin.onload();
	view = new NoteReviewView({} as WorkspaceLeaf, plugin); Object.assign(view, { app }); await view.onOpen();
	const command = commands.mock.calls.find(([c]) => c.id === "suggest-note-folder")![0];
	const root = view.contentEl as unknown as TestElement;
	const start = async () => { command.editorCallback!(editor as any, { file, editor } as any); await flushPromises(); await vi.waitFor(() => expect(root.find("ai-helper-review-stop").disabled).toBe(true)); };
	const emit = (name: string, ...args: any[]) => events.get(name)?.forEach(cb => cb(...args));
	return { plugin, view, root, start, chat, ensureSideLeaf, file, files, folders, texts, editor, read, openFile, create, renameFile, remove, emit, edit(value: string) { text = value; emit("editor-change", editor, { file }); } };
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

it("отмечает изменения во время и после запроса, обновляет текущий текст без автоматических запросов", async () => {
	const s = await setup();
	const pending = deferred<ServerClientResult<ChatCompletionResult>>(); s.chat.mockReturnValueOnce(pending.promise);
	void s.start(); await vi.waitFor(() => expect(s.chat).toHaveBeenCalledTimes(1));
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
	void s.start(); await vi.waitFor(() => expect(s.chat).toHaveBeenCalledTimes(1));
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
	expect(s.create).not.toHaveBeenCalled(); expect(s.renameFile).not.toHaveBeenCalled(); expect(s.openFile).not.toHaveBeenCalled();
	await s.view.onClose();
});

it.each(["stay", "none", "insufficient"] as const)("показывает допустимый исход %s без кандидатов", async outcome => {
	const s = await setup(); s.chat.mockResolvedValueOnce({ ok: true, value: { content: JSON.stringify({ outcome, explanation: "Обоснование результата", candidates: [] }) } }); await s.start();
	expect(s.root.getText()).toContain("Обоснование результата"); expect(() => s.root.find("ai-helper-review-source")).toThrow();
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
	void s.start(); await vi.waitFor(() => expect(s.chat).toHaveBeenCalledTimes(1));
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
