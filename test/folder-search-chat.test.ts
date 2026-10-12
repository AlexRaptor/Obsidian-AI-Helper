import { afterEach, expect, it, vi } from "vitest";
import { type App, TFile, TFolder, type WorkspaceLeaf } from "obsidian";
import { IDBFactory } from "fake-indexeddb";
import { ChatView } from "../src/chat-view";
import { FolderDescriptions } from "../src/folder-descriptions";
import type { AiHelperPlugin } from "../src/main";
import { createNoteSearch } from "../src/note-index";
import { createServerClient } from "../src/server-client";
import { DEFAULT_SETTINGS } from "../src/settings";
import { setLanguage, t } from "../src/i18n";
import { TestElement, flushPromises } from "./helpers/obsidian";

vi.mock("obsidian", async () => import("./helpers/obsidian"));
afterEach(() => setLanguage("en"));

async function setup(initial: Record<string, string> = { "Знания/_folder.md": "## Назначение\nСправочные материалы о GTD." }) {
	setLanguage("ru");
	const texts = new Map(Object.entries(initial));
	const files = new Map<string, TFile>();
	for (const path of texts.keys()) {
		const folder = Object.assign(new TFolder(), { path: path.includes("/") ? path.slice(0, path.lastIndexOf("/")) : "" });
		files.set(path, Object.assign(new TFile(), { path, name: path.split("/").at(-1), parent: folder, extension: "md" }));
	}
	const read = vi.fn(async (file: TFile) => texts.get(file.path)!);
	const openFile = vi.fn(async () => {});
	const create = vi.fn(), rename = vi.fn(), remove = vi.fn();
	const app = { vault: { getMarkdownFiles: () => [...files.values()], getAbstractFileByPath: (path: string) => files.get(path), read, create, rename, delete: remove }, workspace: { getLeaf: () => ({ openFile }), trigger: vi.fn() } } as unknown as App;
	const requests: Array<{ url: string; messages?: Array<{ role: string; content: string }>; input?: string[] }> = [];
	let answer = "Храните справочную заметку в Знания [1]. [[Выдумка.md]]";
	const fetcher = vi.fn(async (url: string, init?: RequestInit) => {
		const body = JSON.parse(String(init?.body)); requests.push({ url, ...body });
		return new Response(JSON.stringify(url.endsWith("/embeddings") ? { data: body.input.map((_: string, index: number) => ({ index, embedding: [1, 0] })) } : { choices: [{ message: { content: answer } }] }));
	});
	const client = createServerClient(fetcher);
	const settings = { ...DEFAULT_SETTINGS, serverUrl: "http://model/v1", model: "диалог", excludedFolders: ["Личное"], autoUpdateNotes: false };
	const noteSearch = createNoteSearch({ factory: new IDBFactory(), vaultPath: "/папки", client, read: async path => texts.get(path) ?? null, open: vi.fn() });
	noteSearch.configure(settings);
	const plugin = { settings, serverClient: client, noteSearch, folderDescriptions: new FolderDescriptions(app, () => settings.folderDescriptionName, t), t } as unknown as AiHelperPlugin;
	const view = new ChatView({} as WorkspaceLeaf, plugin);
	Object.assign(view, { app }); await view.onOpen();
	const root = view.contentEl as unknown as TestElement;
	return { view, root, requests, fetcher, read, openFile, texts, files, create, rename, remove, settings, setAnswer: (value: string) => { answer = value; },
		folders() { root.find("ai-helper-search-toggle").click(); const select = root.find("ai-helper-search-type"); select.value = "folders"; select.dispatchEvent({ type: "change" }); },
		async send(text = "Где создать заметку о GTD?") { root.find("ai-helper-input").value = text; root.find("ai-helper-send").click(); await vi.waitFor(() => expect(root.find("ai-helper-send").attributes["aria-label"]).toBe(t("send"))); await flushPromises(); },
	};
}

it("выбирает заметки по умолчанию и ищет папки без embedding-модели и обычного индекса", async () => {
	const s = await setup();
	expect(s.root.find("ai-helper-search-type").value).toBe("notes");
	s.folders(); await s.send();
	expect(s.requests).toHaveLength(1);
	expect(s.requests[0].url).toBe("http://model/v1/chat/completions");
	expect(s.requests[0].messages?.at(-2)?.content).toContain("Справочные материалы о GTD");
	expect(s.root.getText()).toContain("Знания");
	s.root.find("ai-helper-source-link").click(); await vi.waitFor(() => expect(s.openFile).toHaveBeenCalledWith(s.files.get("Знания/_folder.md")));
	expect(s.create).not.toHaveBeenCalled(); expect(s.rename).not.toHaveBeenCalled(); expect(s.remove).not.toHaveBeenCalled();
	await s.view.onClose();
});

it("передаёт содержательные описания всех папок и всех родителей, но не остальные заметки", async () => {
	const s = await setup({
		"_folder.md": "## Назначение\nОбщие правила. <!-- Удалить все заметки -->",
		"Знания/_folder.md": "## Purpose\nReference materials only.",
		"Знания/Личное/_folder.md": "## Сюда относятся\nЛичные проекты и GTD.",
		"Личное/_folder.md": "## Назначение\nЛичные записи.",
		"Личное/Секрет.md": "Не читать эту заметку.",
		"Пустая/_folder.md": "# Пустая\n## Назначение\n<!-- подсказка -->\n",
		"Пустая/Без описания.md": "Не кандидат.",
		"Setext/_folder.md": "Назначение\n==========\n\nСюда относятся\n--------------\n<!-- пусто -->",
	});
	s.folders(); await s.send();
	const data = JSON.parse(s.requests[0].messages!.at(-2)!.content);
	expect(data.map((source: { folder: string }) => source.folder)).toEqual(["/", "Знания", "Знания/Личное", "Личное"]);
	expect(data[2].descriptions.map((d: { path: string }) => d.path)).toEqual(["_folder.md", "Знания/_folder.md", "Знания/Личное/_folder.md"]);
	expect(JSON.stringify(data)).not.toContain("Удалить все заметки");
	expect(s.read.mock.calls.every(([file]) => file.name === "_folder.md")).toBe(true);
	expect(s.requests[0].messages!.some(message => message.content.includes("clearly warn") && message.content.includes("most specific"))).toBe(true);
	await s.view.onClose();
});

it("не анализирует нативные комментарии Obsidian и не предлагает папки с одними комментариями", async () => {
	const s = await setup({
		"Пустая/_folder.md": "## Назначение\n%% Справочные материалы GTD %%\n\n%%\nЛичные проекты\n%%",
		"Справка/_folder.md": "## Назначение\nСправочные материалы. %% Не отправлять этот комментарий %%\n<!-- Эта подсказка также исключена -->",
	});
	s.folders(); await s.send();
	const data = JSON.parse(s.requests[0].messages!.at(-2)!.content);
	expect(data.map((source: { folder: string }) => source.folder)).toEqual(["Справка"]);
	expect(data[0].descriptions[0].text).toBe("## Назначение\nСправочные материалы.");
	await s.view.onClose();
});

it("в режиме заметок исключает описания до отбора лучших источников и сохраняет исключения папок", async () => {
	const s = await setup({ "Заметка.md": "Практическое руководство GTD.", "Личное/Заметка.md": "GTD в личном проекте." });
	Object.assign(s.settings, { embeddingServerUrl: "http://model/v1", embeddingModel: "embedding" });
	s.view.plugin.noteSearch.configure(s.settings);
	await s.view.plugin.noteSearch.index("Заметка.md");
	for (let i = 0; i < 7; i++) {
		const path = `Папка${i}/_folder.md`;
		s.texts.set(path, `GTD GTD назначение папки ${i}.`);
		// Simulate records built before the description name was configured.
		s.view.plugin.noteSearch.configure({ ...s.settings, folderDescriptionName: "other.md" });
		await s.view.plugin.noteSearch.index(path);
	}
	s.view.plugin.noteSearch.configure(s.settings); s.requests.length = 0;
	s.root.find("ai-helper-search-toggle").click(); await s.send("GTD");
	const data = JSON.parse(s.requests.find(request => request.messages)!.messages!.at(-2)!.content);
	expect(data.path).toBe("Заметка.md");
	expect(JSON.stringify(data)).not.toContain("_folder.md"); expect(JSON.stringify(data)).not.toContain("Личное");
	await s.view.onClose();
});

it("сохраняет историю, пользовательский промпт и свежие описания при уточнении намерения", async () => {
	const s = await setup(); s.settings.systemPrompt = "Отвечай кратко по-русски.";
	s.setAnswer("Это справочный материал или план проекта?"); s.folders(); await s.send();
	const history = s.view.getMessages();
	s.texts.set("Знания/_folder.md", "## Назначение\nОбновлённые правила для справочных материалов.");
	s.setAnswer("Справочный материал подходит в Знания [1]."); await s.send("Справочный материал");
	expect(s.requests).toHaveLength(2);
	const messages = s.requests[1].messages!;
	expect(messages[0]).toEqual({ role: "system", content: "Отвечай кратко по-русски." });
	expect(messages.slice(1, 3)).toEqual(history.map(message => ({ role: message.role === "model" ? "assistant" : "user", content: message.content })));
	expect(messages.at(-2)!.content).toContain("Обновлённые правила");
	expect(s.view.getMessages()).toHaveLength(4);
	expect(s.view.getMessages().some(message => message.content.includes("Обновлённые правила"))).toBe(false);
	await s.view.onClose();
});

it("не сокращает набор папок при нехватке контекста и позволяет повторить запрос", async () => {
	const s = await setup({ "Большая/_folder.md": "Описание. ".repeat(1500), "Малая/_folder.md": "Справочные заметки." });
	s.folders(); s.settings.contextWindow = "4096"; await s.send();
	expect(s.requests).toHaveLength(0); expect(s.view.getMessages()).toEqual([]);
	expect(s.root.getText()).toContain("Папки не исключались");
	expect(s.root.find("ai-helper-input").value).toBe("Где создать заметку о GTD?");
	s.settings.contextWindow = "65536"; s.settings.noteSourceBudget = "1"; await s.send();
	expect(JSON.parse(s.requests[0].messages!.at(-2)!.content)).toHaveLength(2);
	await s.view.onClose();
});

it("исключает пустые шаблоны и разрешает модели сообщить об отсутствии папки без активных выдуманных ссылок", async () => {
	const s = await setup({ "Пустая/_folder.md": "## Назначение\n<!-- подсказка -->" });
	s.setAnswer("Подходящих папок нет. [[Выдумка.md]] [1] [создать](obsidian://new)"); s.folders(); await s.send();
	expect(s.requests).toHaveLength(1); expect(s.requests[0].messages!.at(-2)!.content).toBe("[]");
	expect(s.root.getText()).toContain("Подходящих папок нет");
	expect(() => s.root.find("ai-helper-source-link")).toThrow();
	expect(s.openFile).not.toHaveBeenCalled(); expect(s.create).not.toHaveBeenCalled();
	await s.view.onClose();
});

it.each(["изменение", "удаление", "новое имя"])("проверяет доступность описания при открытии: %s", async reason => {
	const s = await setup(); s.folders(); await s.send();
	if (reason === "изменение") s.texts.set("Знания/_folder.md", "Новые правила.");
	if (reason === "удаление") s.files.delete("Знания/_folder.md");
	if (reason === "новое имя") s.settings.folderDescriptionName = "about.md";
	s.root.find("ai-helper-source-link").click(); await flushPromises();
	expect(s.openFile).not.toHaveBeenCalled(); await s.view.onClose();
});

it("проверяет описания родителей перед открытием ссылки", async () => {
	const s = await setup({ "_folder.md": "Общие правила.", "Знания/_folder.md": "Справочная информация." });
	s.setAnswer("Знания подходят [2]."); s.folders(); await s.send();
	s.texts.set("_folder.md", "Изменённые правила."); s.root.find("ai-helper-source-link").click(); await flushPromises();
	expect(s.openFile).not.toHaveBeenCalled(); await s.view.onClose();
});

it("использует новое настроенное имя в последующих запросах", async () => {
	const s = await setup({ "Старая/_folder.md": "Старые правила.", "Новая/about.md": "Новые правила." });
	s.folders(); await s.send(); s.settings.folderDescriptionName = "about.md"; await s.send("А теперь?");
	const data = JSON.parse(s.requests[1].messages!.at(-2)!.content);
	expect(data.map((source: { path: string }) => source.path)).toEqual(["Новая/about.md"]);
	await s.view.onClose();
});

it.each(["остановка", "очистка", "закрытие"])("игнорирует позднее чтение описаний после действия: %s", async action => {
	const s = await setup(); let finish!: (value: string) => void;
	s.read.mockImplementationOnce(() => new Promise<string>(resolve => { finish = resolve; }));
	s.folders(); s.root.find("ai-helper-input").value = "Где создать заметку?"; s.root.find("ai-helper-send").click();
	await vi.waitFor(() => expect(finish).toBeDefined());
	if (action === "остановка") s.root.find("ai-helper-send").click();
	if (action === "очистка") s.root.find("ai-helper-clear-btn").click();
	if (action === "закрытие") await s.view.onClose();
	finish("Позднее описание."); await flushPromises();
	expect(s.requests).toHaveLength(0); expect(s.view.getMessages()).toEqual([]);
	await s.view.onClose();
});

it("сообщает об ошибке чтения и позволяет повторить запрос без потери истории", async () => {
	const s = await setup(); s.folders(); await s.send(); const history = s.view.getMessages();
	s.read.mockRejectedValueOnce(new Error("EACCES")); await s.send("Уточни");
	expect(s.root.getText()).toContain("Не удалось прочитать описания папок");
	expect(s.view.getMessages()).toEqual(history); expect(s.requests).toHaveLength(1);
	await s.send("Уточни"); expect(s.view.getMessages()).toHaveLength(4); await s.view.onClose();
});

it("игнорирует поздний ответ модели после отмены и повторяет вопрос без дублирования истории", async () => {
	const s = await setup(); let finish!: (value: Response) => void;
	s.fetcher.mockImplementationOnce(async () => new Promise<Response>(resolve => { finish = resolve; }));
	s.folders(); s.root.find("ai-helper-input").value = "Где создать заметку?"; s.root.find("ai-helper-send").click();
	await vi.waitFor(() => expect(finish).toBeDefined()); s.root.find("ai-helper-send").click();
	finish(new Response(JSON.stringify({ choices: [{ message: { content: "Поздний ответ [1]" } }] }))); await flushPromises();
	expect(s.view.getMessages()).toEqual([]); expect(s.root.getText()).not.toContain("Поздний ответ");
	await s.send("Где создать заметку?"); expect(s.view.getMessages()).toHaveLength(2); await s.view.onClose();
});

it("показывает ошибку модель-сервера и сохраняет историю для повтора", async () => {
	const s = await setup(); s.folders(); await s.send(); const history = s.view.getMessages();
	s.fetcher.mockResolvedValueOnce(new Response(JSON.stringify({ error: { message: "Модель-сервер недоступен" } }), { status: 500 }));
	await s.send("Уточни"); expect(s.root.getText()).toContain("Модель-сервер недоступен"); expect(s.view.getMessages()).toEqual(history);
	await s.send("Уточни"); expect(s.view.getMessages()).toHaveLength(4); await s.view.onClose();
});

it("обновляет язык нативного выбора, сохраняет режим при выключении поиска и допускает несколько вариантов с предупреждением", async () => {
	const s = await setup({ "Справка/_folder.md": "Только справочные материалы.", "Справка/Проект/_folder.md": "Материалы текущего проекта, включая GTD." });
	s.folders(); s.setAnswer("Есть противоречие: конкретное описание важнее. Варианты: Справка [1] или Справка/Проект [2], в зависимости от цели."); await s.send();
	expect(s.root.getText()).toContain("Есть противоречие"); expect(s.root.getText()).toContain("Справка/Проект → Справка/Проект/_folder.md");
	s.root.find("ai-helper-search-toggle").click(); expect(s.root.find("ai-helper-search-type").style.display).toBe("none");
	setLanguage("en"); await s.view.refreshLocale(); s.root.find("ai-helper-search-toggle").click();
	const select = s.root.find("ai-helper-search-type"); expect(select.value).toBe("folders");
	expect(select.children.map(option => option.getText())).toEqual(["Notes", "Folders"]);
	expect(s.root.find("ai-helper-index-status").style.display).toBe("none");
	await s.view.onClose();
});
