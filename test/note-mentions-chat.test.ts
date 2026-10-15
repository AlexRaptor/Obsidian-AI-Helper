import { afterEach, expect, it, vi } from "vitest";
import { MarkdownView, TFile, TFolder, type WorkspaceLeaf } from "obsidian";
import { IDBFactory } from "fake-indexeddb";
import { createNoteSearch } from "../src/note-index";
import { FolderDescriptions } from "../src/folder-descriptions";
import { ChatView } from "../src/chat-view";
import type { AiHelperPlugin } from "../src/main";
import type { ServerClient, ServerClientResult, ChatCompletionResult } from "../src/server-client";
import { DEFAULT_SETTINGS } from "../src/settings";
import { setLanguage, t } from "../src/i18n";
import { Modal, Notice, TestElement, deferred, flushPromises } from "./helpers/obsidian";

vi.mock("obsidian", async () => import("./helpers/obsidian"));
afterEach(() => { for (const modal of [...Modal.opened]) modal.close(); vi.restoreAllMocks(); });

async function setup(paths?: string[], hasCurrent = true) {
	setLanguage("ru");
	Notice.messages = [];
	const file = Object.assign(new TFile(), { path: "Проекты/План.md", basename: "План", extension: "md" });
	let markdown = "---\nстатус: готов\n---\n# План\nПервоначальная метка\n[[Секрет]]\n![[Вложение]]";
	const editor = Object.assign(new MarkdownView({} as WorkspaceLeaf), { file, getMode: (): "source" | "preview" => "source", editor: { getValue: () => markdown } });
	const files = paths ? paths.map(path => path === file.path ? file : Object.assign(new TFile(), { path, basename: path.split("/").pop()!.slice(0, -3), extension: "md" })) : [file];
	const workspace = { getActiveViewOfType: (): MarkdownView | null => hasCurrent ? editor : null, getLeavesOfType: (): { view: MarkdownView }[] => hasCurrent ? [{ view: editor }] : [] };
	const read = vi.fn(async (_file: TFile) => markdown);
	const chat = vi.fn<Parameters<ServerClient["chat"]>, ReturnType<ServerClient["chat"]>>(async () => ({ ok: true as const, value: { content: "Ответ" } }));
	const plugin = { settings: { ...DEFAULT_SETTINGS, serverUrl: "http://s", model: "модель", contextWindow: "20000" }, serverClient: { chat }, t } as unknown as AiHelperPlugin;
	const view = new ChatView({} as WorkspaceLeaf, plugin);
	const listeners = new Map<string, Set<(...args: any[]) => void>>();
	const on = (event: string, callback: (...args: any[]) => void) => {
		if (!listeners.has(event)) listeners.set(event, new Set());
		listeners.get(event)!.add(callback);
		return { event, callback };
	};
	const offref = (ref: ReturnType<typeof on>) => { listeners.get(ref.event)?.delete(ref.callback); };
	const emit = (event: string, ...args: any[]) => { listeners.get(event)?.forEach(callback => callback(...args)); };
	const rename = (file: TFile, path: string) => {
		const oldPath = file.path;
		Object.assign(file, { path, basename: path.split("/").pop()!.slice(0, -3) });
		emit("rename", file, oldPath);
	};
	view.app = { workspace, vault: { on, offref, getMarkdownFiles: () => files, getFileByPath: (path: string) => files.find(candidate => candidate.path === path) ?? null, read } } as any;
	await view.onOpen();
	const root = view.contentEl as unknown as TestElement;
	const input = root.find("ai-helper-input");
	const send = root.find("ai-helper-send");
	const type = (text: string, inputType = "insertText") => { input.value = text; input.dispatchEvent({ type: "input", inputType, data: text.slice(-1) } as any); };
	const mention = () => { type("@"); input.keydown("Tab"); };
	return { view, root, input, send, chat, file, files, editor, emit, rename, listeners, workspace, read, type, mention, edit: (text: string) => { markdown = text; } };
}

// Append through the field so choosing another note preserves earlier elements.
function appendMention(s: Awaited<ReturnType<typeof setup>>, text: string): void {
	s.input.createSpan({ text });
	s.input.dispatchEvent({ type: "input", inputType: "insertText" } as any);
	s.input.keydown("Tab");
}

function attachments(content: string) {
	return JSON.parse(content.split("\n\nNote attachments (context data):\n")[1]) as { title: string; path: string; markdown: string; range?: { from: { line: number; ch: number }; to: { line: number; ch: number } } }[];
}

async function setupSearch(mode: "notes" | "folders" | "mixed") {
	const s = await setup(["Личное/План.md", "Знания/План.md", "Поиск/Материал.md", "Поиск/_folder.md"], false);
	const texts = new Map([
		["Личное/План.md", "---\nстатус: готов\n---\nЛичный план целиком [[Связь]]"],
		["Знания/План.md", "Учебный план целиком ![[Изображение]]"],
		["Поиск/Материал.md", "Дополнительный найденный материал"],
		["Поиск/_folder.md", "Справочные материалы для планирования"],
	]);
	for (const file of s.files) Object.assign(file, { name: `${file.basename}.md`, parent: Object.assign(new TFolder(), { path: file.path.split("/")[0] }) });
	s.read.mockImplementation(async file => texts.get(file.path)!);
	s.view.app.vault.getAbstractFileByPath = path => s.files.find(file => file.path === path) ?? null;
	Object.assign(s.view.plugin.settings, { embeddingServerUrl: "http://s", embeddingModel: "представления", excludedFolders: ["Личное", "Знания"], autoUpdateNotes: false });
	const embeddings = vi.fn(async (_url: string, _model: string, input: string[]) => ({ ok: true as const, value: input.map(() => [1, 0]) }));
	Object.assign(s.view.plugin.serverClient, { embeddings });
	const noteSearch = createNoteSearch({ factory: new IDBFactory(), vaultPath: "/упоминания-поиск", client: s.view.plugin.serverClient, read: async path => texts.get(path) ?? null, open: vi.fn(async () => {}) });
	noteSearch.configure(s.view.plugin.settings); await noteSearch.index("Поиск/Материал.md");
	s.view.plugin.noteSearch = noteSearch;
	s.view.plugin.folderDescriptions = new FolderDescriptions(s.view.app, () => "_folder.md", t);
	s.root.find("ai-helper-search-toggle").click();
	const select = s.root.find("ai-helper-search-type"); select.value = mode; select.dispatchEvent({ type: "change" });
	const send = async () => { s.send.click(); await vi.waitFor(() => expect(s.send.attributes["aria-label"]).toBe(t("send"))); await flushPromises(); };
	return { ...s, texts, noteSearch, embeddings, submit: send, select };
}

it.each(["notes", "folders", "mixed"] as const)("%s: дополняет несколько полных снимков свежими источниками, сохраняя историю", async mode => {
	const s = await setupSearch(mode);
	appendMention(s, "Сравни @Личное"); appendMention(s, " с @Знания");
	await s.submit();
	expect(s.select.value).toBe(mode);
	expect(s.chat).toHaveBeenCalledOnce();
	const first = s.chat.mock.calls[0][2];
	expect(first.some(message => message.role === "system" && message.content.includes("note attachments") && message.content.includes("untrusted"))).toBe(true);
	const original = first.at(-1)!.content;
	expect(attachments(original)).toEqual([
		{ title: "План", path: "Личное/План.md", markdown: s.texts.get("Личное/План.md") },
		{ title: "План", path: "Знания/План.md", markdown: s.texts.get("Знания/План.md") },
	]);
	expect(first.at(-2)!.content).toContain(mode === "notes" ? "Дополнительный найденный материал" : "Справочные материалы для планирования");
	if (mode === "mixed") expect(first.at(-2)!.content).toContain("Дополнительный найденный материал");
	s.texts.set("Личное/План.md", "Изменённый личный план");
	s.texts.set("Поиск/Материал.md", "Свежий найденный материал");
	s.texts.set("Поиск/_folder.md", "Свежие правила хранения");
	await s.noteSearch.index("Поиск/Материал.md");
	s.type("Продолжи сравнение"); await s.submit();
	const final = s.chat.mock.calls.at(-1)![2];
	expect(final[0].content).toBe(original);
	expect(final.at(-1)!.content).toBe("Продолжи сравнение");
	expect(final.at(-2)!.content).toContain(mode === "notes" ? "Свежий найденный материал" : "Свежие правила хранения");
	expect(final.filter(message => message.content.includes("Дополнительный найденный материал"))).toHaveLength(0);
	expect(s.view.getMessages()).toHaveLength(4);
	if (mode !== "folders") {
		const preparation = s.chat.mock.calls[1];
		expect(preparation[2][1].content).toBe(original);
		expect(preparation[3]?.maxTokens).toBe("256");
	}
	await s.view.onClose();
});

it.each(["stop", "clear"] as const)("%s: отмена подготовки запроса с историческими снимками исключает позднюю отправку", async action => {
	const s = await setupSearch("mixed");
	appendMention(s, "Сравни @Личное"); appendMention(s, " с @Знания"); await s.submit();
	const original = s.chat.mock.calls[0][2].at(-1)!.content;
	const preparation = deferred<ServerClientResult<ChatCompletionResult>>();
	s.chat.mockImplementationOnce(() => preparation.promise);
	s.type("Продолжи сравнение"); s.send.click();
	await vi.waitFor(() => expect(s.chat).toHaveBeenCalledTimes(2));
	expect(s.chat.mock.calls[1][2][1].content).toBe(original);
	const signal = s.chat.mock.calls[1][3]!.signal!;
	if (action === "stop") s.send.click();
	else { s.type("Новый черновик"); s.root.find("ai-helper-clear-btn").click(); }
	expect(signal.aborted).toBe(true);
	preparation.resolve({ ok: true, value: { content: "Поздний поисковый запрос" } });
	await flushPromises();
	expect(s.chat).toHaveBeenCalledTimes(2);
	expect(s.view.getMessages()).toHaveLength(action === "stop" ? 2 : 0);
	expect(s.input.getText()).toBe(action === "stop" ? "" : "Новый черновик");
	await s.view.onClose();
});

it("бюджет промежуточного запроса включает старые и новые снимки и собственный резерв", async () => {
	const s = await setupSearch("notes");
	appendMention(s, "Обсуди @Личное"); await s.submit();
	s.view.plugin.settings.contextWindow = "2000"; s.view.plugin.settings.maxTokens = "100";
	const count = vi.fn<Parameters<ServerClient["countPromptTokens"]>, ReturnType<ServerClient["countPromptTokens"]>>(async (_url, _model, messages) => ({
		tokens: messages[0].content.includes("search query") ? 1489 : 500, method: "lmstudio",
	}));
	s.view.plugin.serverClient.countPromptTokens = count;
	appendMention(s, "Сравни с @Знания"); await s.submit();
	expect(s.chat).toHaveBeenCalledOnce();
	const preparation = count.mock.calls.at(-1)![2];
	expect(attachments(preparation[1].content)[0].path).toBe("Личное/План.md");
	expect(attachments(preparation.at(-1)!.content)[0].path).toBe("Знания/План.md");
	expect(s.input.getText()).toBe("Сравни с @План");
	expect(s.root.getText()).toContain(t("search-budget"));
	await s.view.onClose();
});

it.each(["automatic", "manual", "invalid-manual"] as const)("%s: для снимков использует известное окно с приоритетом ручного значения", async limit => {
	const s = await setupSearch("notes");
	Object.assign(s.view.plugin, { contextWindowConnection: { value: { tokens: limit === "manual" ? 100 : 20000, source: "vLLM" }, refresh: vi.fn(async () => {}) } });
	s.view.plugin.settings.contextWindow = limit === "automatic" ? "" : limit === "manual" ? "20000" : "не число";
	appendMention(s, "Сравни @Личное"); appendMention(s, " с @Знания"); await s.submit();
	if (limit === "invalid-manual") {
		expect(s.chat).not.toHaveBeenCalled();
		expect(s.root.getText()).toContain(t("mention-window-unknown"));
		expect(s.input.getText()).toBe("Сравни @План с @План");
	} else expect(s.chat).toHaveBeenCalledOnce();
	await s.view.onClose();
});

it.each(["notes", "folders", "mixed"] as const)("%s: обязательные снимки и резервы блокируют поиск до запросов подготовки", async mode => {
	const s = await setupSearch(mode);
	Object.assign(s.view.plugin.settings, { contextWindow: "1355", maxTokens: "100" });
	s.view.plugin.serverClient.countPromptTokens = vi.fn<Parameters<ServerClient["countPromptTokens"]>, ReturnType<ServerClient["countPromptTokens"]>>(async () => ({ tokens: 1000, method: "lmstudio" }));
	const search = vi.spyOn(s.noteSearch, "searchSources");
	const folders = vi.spyOn(s.view.plugin.folderDescriptions, "sources");
	appendMention(s, "Сравни @Личное"); appendMention(s, " с @Знания"); await s.submit();
	expect(s.chat).not.toHaveBeenCalled(); expect(search).not.toHaveBeenCalled(); expect(folders).not.toHaveBeenCalled();
	expect(s.input.getText()).toBe("Сравни @План с @План");
	expect(s.root.getText()).toContain("Недостаточно контекста");
	await s.view.onClose();
});

it("ограничивает дополнительные заметки свободным контекстом даже при большом бюджете источников", async () => {
	const s = await setupSearch("notes");
	Object.assign(s.view.plugin.settings, { contextWindow: "1800", maxTokens: "100", noteSourceBudget: "12000" });
	s.view.plugin.serverClient.countPromptTokens = vi.fn<Parameters<ServerClient["countPromptTokens"]>, ReturnType<ServerClient["countPromptTokens"]>>(async () => ({ tokens: 1000, method: "lmstudio" }));
	const search = vi.spyOn(s.noteSearch, "searchSources");
	appendMention(s, "Сравни @Личное"); appendMention(s, " с @Знания"); await s.submit();
	expect(s.chat).toHaveBeenCalledOnce();
	// 1800 total - 1000 prompt - 100 answer - 256 safety = 444 bytes for extra sources.
	expect(search.mock.calls[0][2]).toBe(444);
	expect(attachments(s.chat.mock.calls[0][2].at(-1)!.content)).toHaveLength(2);
	await s.view.onClose();
});

it("отправляет обязательные снимки даже когда поиск не нашёл дополнительных заметок", async () => {
	const s = await setupSearch("notes");
	vi.spyOn(s.noteSearch, "searchSources").mockResolvedValue([]);
	appendMention(s, "Сравни @Личное"); appendMention(s, " с @Знания"); await s.submit();
	expect(s.chat).toHaveBeenCalledOnce();
	expect(attachments(s.chat.mock.calls[0][2].at(-1)!.content)).toHaveLength(2);
	expect(s.chat.mock.calls[0][2].at(-2)!.content).toBe("[]");
	expect(s.view.getMessages()).toHaveLength(2);
	await s.view.onClose();
});

it.each(["notes", "folders", "mixed"] as const)("%s: переименование во время подготовки обновляет снимок и бюджет", async mode => {
	const s = await setupSearch(mode);
	const file = s.files[0];
	appendMention(s, "Обсуди @Личное");
	const count = vi.fn<Parameters<ServerClient["countPromptTokens"]>, ReturnType<ServerClient["countPromptTokens"]>>(async () => {
		if (file.path === "Личное/План.md") {
			s.texts.set("Личное/Новый план.md", s.texts.get(file.path)!);
			s.rename(file, "Личное/Новый план.md");
			return { tokens: 50000, method: "lmstudio" };
		}
		return { tokens: 1000, method: "lmstudio" };
	});
	s.view.plugin.serverClient.countPromptTokens = count;
	await s.submit();
	expect(s.chat).toHaveBeenCalledOnce();
	expect(attachments(s.chat.mock.calls[0][2].at(-1)!.content)[0]).toMatchObject({ title: "Новый план", path: "Личное/Новый план.md" });
	expect(count.mock.calls.at(-1)![2].at(-1)!.content).toContain("Личное/Новый план.md");
	await s.view.onClose();
});

it.each(["notes", "mixed"] as const)("%s: не помещающийся найденный фрагмент не блокирует обязательные снимки", async mode => {
	const s = await setupSearch(mode);
	s.view.plugin.settings.noteSourceBudget = "1";
	appendMention(s, "Сравни @Личное"); appendMention(s, " с @Знания"); await s.submit();
	expect(s.chat).toHaveBeenCalledOnce();
	expect(attachments(s.chat.mock.calls[0][2].at(-1)!.content)).toHaveLength(2);
	expect(s.chat.mock.calls[0][2].at(-2)!.content).not.toContain("Дополнительный найденный материал");
	if (mode === "mixed") expect(s.chat.mock.calls[0][2].at(-2)!.content).toContain("Справочные материалы для планирования");
	await s.view.onClose();
});

it.each(["notes", "mixed"] as const)("%s: нулевой остаток бюджета дополнительных заметок позволяет ответить по полным снимкам", async mode => {
	const s = await setupSearch(mode);
	Object.assign(s.view.plugin.settings, { contextWindow: "1356", maxTokens: "100" });
	s.view.plugin.serverClient.countPromptTokens = vi.fn<Parameters<ServerClient["countPromptTokens"]>, ReturnType<ServerClient["countPromptTokens"]>>(async () => ({ tokens: 1000, method: "lmstudio" }));
	const search = vi.spyOn(s.noteSearch, "searchSources");
	appendMention(s, "Сравни @Личное"); appendMention(s, " с @Знания"); await s.submit();
	expect(search).not.toHaveBeenCalled();
	expect(s.chat).toHaveBeenCalledOnce();
	expect(attachments(s.chat.mock.calls[0][2].at(-1)!.content)).toHaveLength(2);
	await s.view.onClose();
});

it("ошибка повторного чтения после переименования завершает подготовку и восстанавливает черновик", async () => {
	const s = await setupSearch("notes");
	const file = s.files[0];
	appendMention(s, "Обсуди @Личное");
	s.view.plugin.serverClient.countPromptTokens = vi.fn<Parameters<ServerClient["countPromptTokens"]>, ReturnType<ServerClient["countPromptTokens"]>>(async () => {
		if (file.path === "Личное/План.md") {
			s.texts.set("Личное/Новый план.md", s.texts.get(file.path)!);
			s.rename(file, "Личное/Новый план.md");
			s.read.mockRejectedValueOnce(new Error("Не удалось прочитать переименованную заметку"));
		}
		return { tokens: 1000, method: "lmstudio" };
	});
	await s.submit();
	expect(s.chat).not.toHaveBeenCalled();
	expect(s.view.getMessages()).toEqual([]);
	expect(s.input.getText()).toBe("Обсуди @Новый план");
	expect(s.root.getText()).toContain(t("mention-file-unavailable"));
	await s.view.onClose();
});

it.each(["notes", "folders", "mixed"] as const)("%s: блокирует неизвестное окно и перепроверяет историю без новых упоминаний", async mode => {
	const s = await setupSearch(mode);
	appendMention(s, "Сравни @Личное"); appendMention(s, " с @Знания");
	s.view.plugin.settings.contextWindow = "";
	await s.submit();
	expect(s.chat).not.toHaveBeenCalled();
	expect(s.root.getText()).toContain(t("mention-window-unknown"));
	expect(s.input.getText()).toBe("Сравни @План с @План");
	s.view.plugin.settings.contextWindow = "20000";
	await s.submit();
	expect(s.view.getMessages()).toHaveLength(2);
	s.view.plugin.settings.contextWindow = "";
	s.type("Продолжи сравнение"); await s.submit();
	expect(s.chat).toHaveBeenCalledOnce();
	expect(s.input.getText()).toBe("Продолжи сравнение");
	expect(s.root.getText()).toContain(t("mention-window-unknown"));
	await s.view.onClose();
});

it.each(["notes", "folders", "mixed"] as const)("%s: считает окончательный запрос и резерв ответа, выделяя только оставшийся бюджет источникам", async mode => {
	const s = await setupSearch(mode);
	Object.assign(s.view.plugin.settings, { contextWindow: "4000", maxTokens: "100", systemPrompt: "Обсуди полные планы", noteSourceBudget: "300" });
	const count = vi.fn<Parameters<ServerClient["countPromptTokens"]>, ReturnType<ServerClient["countPromptTokens"]>>(async (_url, _model, messages) => ({
		tokens: messages.some(message => message.content.includes("Дополнительный найденный материал") || mode === "folders" && message.content.includes('"ancestors"')) ? 3644 : 1000,
		method: "lmstudio",
	}));
	s.view.plugin.serverClient.countPromptTokens = count;
	const search = vi.spyOn(s.noteSearch, "searchSources");
	appendMention(s, "Сравни @Личное"); appendMention(s, " с @Знания");
	await s.submit();
	expect(s.chat).toHaveBeenCalledOnce();
	expect(s.chat.mock.calls[0][3]?.maxTokens).toBe("100");
	const messages = s.chat.mock.calls[0][2];
	expect(count.mock.calls.at(-1)![2]).toEqual([{ role: "system", content: "Обсуди полные планы" }, ...messages]);
	if (mode !== "folders") expect(search.mock.calls[0][2]).toBeLessThanOrEqual(300);
	// One more reserved token crosses the final limit; snapshots and draft remain intact.
	s.view.plugin.settings.maxTokens = "101";
	s.type("Продолжи сравнение"); await s.submit();
	expect(s.view.getMessages()).toHaveLength(2);
	expect(s.chat.mock.calls.filter(call => call[3]?.maxTokens !== "256")).toHaveLength(1);
	expect(s.input.getText()).toBe("Продолжи сравнение");
	expect(s.root.getText()).toContain("Недостаточно контекста");
	await s.view.onClose();
});

it.each([1, 2])("удаление %i повторений оставляет только явно выбранные вложения", async removed => {
	const s = await setup(["Личное/План.md", "Знания/План.md"], false);
	appendMention(s, "Сравни @Личное"); appendMention(s, " и @Личное"); appendMention(s, " с @Знания");
	const repeated = s.input.children.filter(child => child.attributes.title === "Личное/План.md");
	for (const chip of repeated.slice(0, removed)) chip.remove();
	s.input.dispatchEvent({ type: "input", inputType: "deleteContentBackward" } as any);
	s.send.click(); await flushPromises();
	expect(attachments(s.chat.mock.calls[0][2][0].content).map(snapshot => snapshot.path)).toEqual(
		removed === 1 ? ["Личное/План.md", "Знания/План.md"] : ["Знания/План.md"],
	);
	await s.view.onClose();
});

it("читает несохранённые правки каждого редактора, предпочитая их вкладкам чтения после переключения", async () => {
	const s = await setup(["Личное/План.md", "Знания/План.md"], false);
	let personal = "Старый личный план", learning = "Старый учебный план";
	const personalView = Object.assign(new MarkdownView({} as WorkspaceLeaf), {
		file: s.view.app.vault.getFileByPath("Личное/План.md"), getMode: () => "source", editor: { getValue: () => personal },
	});
	const learningView = Object.assign(new MarkdownView({} as WorkspaceLeaf), {
		file: s.view.app.vault.getFileByPath("Знания/План.md"), getMode: () => "source", editor: { getValue: () => learning },
	});
	const readingViews = [personalView, learningView].map(source => Object.assign(new MarkdownView({} as WorkspaceLeaf), {
		file: source.file, getMode: () => "preview", getViewData: () => "Устаревшее представление чтения",
	}));
	s.workspace.getLeavesOfType = () => [...readingViews, personalView, learningView].map(view => ({ view }));
	appendMention(s, "Сравни @Личное"); appendMention(s, " с @Знания");
	personal = "Несохранённый личный план"; learning = "Несохранённый учебный план";
	s.workspace.getActiveViewOfType = () => readingViews[1];
	s.send.click(); await flushPromises();
	expect(attachments(s.chat.mock.calls[0][2][0].content)).toEqual([
		{ title: "План", path: "Личное/План.md", markdown: "Несохранённый личный план" },
		{ title: "План", path: "Знания/План.md", markdown: "Несохранённый учебный план" },
	]);
	expect(s.read).not.toHaveBeenCalled();
	await s.view.onClose();
});

it.each(["missing", "read-error"])("недоступность одного из файлов сохраняет весь вопрос и все повторения: %s", async reason => {
	const s = await setup(["Личное/План.md", "Знания/План.md"], false);
	appendMention(s, "Сравни @Личное"); appendMention(s, " с @Знания"); appendMention(s, " и @Личное");
	const lookup = s.view.app.vault.getFileByPath;
	if (reason === "missing") s.view.app.vault.getFileByPath = path => path === "Знания/План.md" ? null : lookup(path);
	else s.read.mockImplementation(async file => {
		if (file.path === "Знания/План.md") throw new Error("Ошибка чтения");
		return "Личный план";
	});
	s.send.click(); await flushPromises();
	expect(s.chat).not.toHaveBeenCalled();
	expect(s.view.getMessages()).toEqual([]);
	expect(s.input.getText()).toBe("Сравни @План с @План и @План");
	expect(s.input.children.filter(child => child.attributes.title).map(child => child.attributes.title)).toEqual([
		"Личное/План.md", "Знания/План.md", "Личное/План.md",
	]);
	expect(s.root.getText()).toContain(t("mention-file-unavailable"));
	expect(s.root.getText()).toContain("Знания/План.md");
	s.input.children.find(child => child.attributes.title === "Знания/План.md")!.remove();
	s.send.click(); await flushPromises();
	expect(attachments(s.chat.mock.calls[0][2][0].content).map(snapshot => snapshot.path)).toEqual(["Личное/План.md"]);
	await s.view.onClose();
});

it("история хранит обе старые версии, новый выбор передаёт свежую версию только в новом ходе", async () => {
	const s = await setup(["Личное/План.md", "Знания/План.md"], false);
	s.read.mockImplementation(async file => `Старый текст: ${file.path}`);
	appendMention(s, "Сравни @Личное"); appendMention(s, " с @Знания");
	s.send.click(); await flushPromises();
	const original = s.chat.mock.calls[0][2][0].content;
	s.read.mockImplementation(async file => `Новый текст: ${file.path}`);
	s.type("Продолжи сравнение"); s.send.click(); await flushPromises();
	expect(s.chat.mock.calls[1][2][0].content).toBe(original);
	expect(s.chat.mock.calls[1][2][2].content).toBe("Продолжи сравнение");
	appendMention(s, "Теперь обсуди @Личное"); s.send.click(); await flushPromises();
	expect(s.chat.mock.calls[2][2][0].content).toBe(original);
	expect(attachments(s.chat.mock.calls[2][2][4].content)).toEqual([
		{ title: "План", path: "Личное/План.md", markdown: "Новый текст: Личное/План.md" },
	]);
	await s.view.onClose();
});

it("бюджет включает историю, все новые снимки, системный промпт и резерв без усечения", async () => {
	const s = await setup(["Личное/План.md", "Знания/План.md"], false);
	s.view.plugin.settings.systemPrompt = "Сравнивай подробно";
	s.view.plugin.settings.maxTokens = "100";
	s.view.plugin.settings.contextWindow = "1056";
	const count = vi.fn<Parameters<ServerClient["countPromptTokens"]>, ReturnType<ServerClient["countPromptTokens"]>>(async () => ({ tokens: 700, method: "bytes" }));
	s.view.plugin.serverClient.countPromptTokens = count;
	s.read.mockImplementation(async file => `Полный текст: ${file.path}`);
	appendMention(s, "Сравни @Личное"); appendMention(s, " с @Знания");
	s.send.click(); await flushPromises();
	expect(s.chat).toHaveBeenCalledOnce();
	const original = s.chat.mock.calls[0][2][0].content;
	count.mockResolvedValue({ tokens: 701, method: "bytes" });
	appendMention(s, "Ещё сравни @Личное"); appendMention(s, " с @Знания");
	s.send.click(); await flushPromises();
	expect(s.chat).toHaveBeenCalledOnce();
	expect(count.mock.calls[1][2]).toHaveLength(4);
	expect(count.mock.calls[1][2][0]).toEqual({ role: "system", content: "Сравнивай подробно" });
	expect(count.mock.calls[1][2][1].content).toBe(original);
	expect(attachments(count.mock.calls[1][2][3].content)).toEqual(attachments(original));
	expect(s.input.getText()).toBe("Ещё сравни @План с @План");
	expect(s.root.getText()).toContain(t("mention-budget"));
	s.view.plugin.settings.contextWindow = "1057";
	s.send.click(); await flushPromises();
	expect(s.chat).toHaveBeenCalledTimes(2);
	await s.view.onClose();
});

it("ошибка восстанавливает весь набор с повторениями, повтор читает свежие версии", async () => {
	const s = await setup(["Личное/План.md", "Знания/План.md"], false);
	s.chat.mockResolvedValueOnce({ ok: false, error: { message: "Ошибка сервера" } });
	appendMention(s, "Сравни @Личное"); appendMention(s, " с @Знания"); appendMention(s, " и @Личное");
	s.send.click(); await flushPromises();
	expect(s.input.getText()).toBe("Сравни @План с @План и @План");
	expect(s.view.getMessages()).toEqual([]);
	s.read.mockImplementation(async file => `Свежий текст: ${file.path}`);
	s.send.click(); await flushPromises();
	expect(attachments(s.chat.mock.calls[1][2][0].content)).toEqual([
		{ title: "План", path: "Личное/План.md", markdown: "Свежий текст: Личное/План.md" },
		{ title: "План", path: "Знания/План.md", markdown: "Свежий текст: Знания/План.md" },
	]);
	expect(s.view.getMessages()).toHaveLength(2);
	await s.view.onClose();
});

it.each(["new-draft", "new-mentions", "stop", "clear"])("поздний результат не возвращает прежний набор снимков: %s", async action => {
	const s = await setup(["Личное/План.md", "Знания/План.md"], false);
	const pending = deferred<ServerClientResult<ChatCompletionResult>>();
	s.chat.mockReturnValueOnce(pending.promise);
	appendMention(s, "Сравни @Личное"); appendMention(s, " с @Знания");
	s.send.click(); await flushPromises();
	if (action === "new-draft") s.type("Новый вопрос");
	if (action === "new-mentions") { appendMention(s, "Новый @Знания"); appendMention(s, " и @Личное"); }
	if (action === "stop") s.send.click();
	if (action === "clear") { s.type("После очистки"); s.root.find("ai-helper-clear-btn").click(); }
	pending.resolve(action === "stop" || action === "clear" ? { ok: true, value: { content: "Поздний ответ" } } : { ok: false, error: { message: "Ошибка" } });
	await flushPromises();
	expect(s.view.getMessages()).toEqual([]);
	expect(s.input.getText()).toBe(action === "new-draft" ? "Новый вопрос" : action === "new-mentions" ? "Новый @План и @План" : action === "clear" ? "После очистки" : "");
	if (action === "new-mentions") expect(s.input.children.filter(child => child.attributes.title).map(child => child.attributes.title)).toEqual(["Знания/План.md", "Личное/План.md"]);
	s.type("Продолжи"); s.send.click(); await flushPromises();
	expect(s.chat.mock.calls[1][2]).toEqual([{ role: "user", content: "Продолжи" }]);
	await s.view.onClose();
});

it("смена языка, очистка истории и повторное открытие сохраняют несколько упоминаний и повторения", async () => {
	const s = await setup(["Личное/План.md", "Знания/План.md"], false);
	appendMention(s, "Сравни @Личное"); appendMention(s, " с @Знания"); appendMention(s, " и @Личное");
	setLanguage("en"); await s.view.refreshLocale();
	s.root.find("ai-helper-clear-btn").click();
	await s.view.onClose(); await s.view.onOpen();
	const input = (s.view.contentEl as unknown as TestElement).find("ai-helper-input");
	expect(input.getText()).toBe("Сравни @План с @План и @План");
	expect(input.children.filter(child => child.attributes.title).map(child => child.attributes.title)).toEqual(["Личное/План.md", "Знания/План.md", "Личное/План.md"]);
	input.keydown("Enter"); await flushPromises();
	expect(attachments(s.chat.mock.calls[0][2][0].content)).toHaveLength(2);
	await s.view.onClose();
});

it("сохраняет три упоминания на своих местах и передаёт по одному снимку двух заметок", async () => {
	const s = await setup(["Личное/План.md", "Знания/План.md"], false);
	s.read.mockImplementation(async file => `Текст: ${file.path}`);
	appendMention(s, "Сравни @Личное");
	appendMention(s, " с @Знания");
	appendMention(s, " и уточни @Личное");
	expect(s.input.getText()).toBe("Сравни @План с @План и уточни @План");
	expect(s.input.children.filter(child => child.attributes.title).map(child => child.attributes.title)).toEqual([
		"Личное/План.md", "Знания/План.md", "Личное/План.md",
	]);
	s.send.click(); await flushPromises();
	expect(s.chat).toHaveBeenCalledOnce();
	expect(attachments(s.chat.mock.calls[0][2][0].content)).toEqual([
		{ title: "План", path: "Личное/План.md", markdown: "Текст: Личное/План.md" },
		{ title: "План", path: "Знания/План.md", markdown: "Текст: Знания/План.md" },
	]);
	expect(s.read).toHaveBeenCalledTimes(2);
	await s.view.onClose();
});

it("блокирует весь набор, если одна заметка стала недоступна во время подсчёта контекста", async () => {
	const s = await setup(["Личное/План.md", "Знания/План.md"], false);
	const count = deferred<{ tokens: number; method: "bytes" }>();
	s.view.plugin.serverClient.countPromptTokens = vi.fn(() => count.promise);
	appendMention(s, "Сравни @Личное"); appendMention(s, " с @Знания");
	s.send.click(); await flushPromises();
	const lookup = s.view.app.vault.getFileByPath;
	s.view.app.vault.getFileByPath = path => path === "Знания/План.md" ? null : lookup(path);
	count.resolve({ tokens: 200, method: "bytes" }); await flushPromises();
	expect(s.chat).not.toHaveBeenCalled();
	expect(s.input.getText()).toBe("Сравни @План с @План");
	expect(s.input.children.filter(child => child.attributes.title).map(child => child.attributes.title)).toEqual(["Личное/План.md", "Знания/План.md"]);
	expect(s.root.getText()).toContain(t("mention-file-unavailable"));
	expect(s.view.getMessages()).toEqual([]);
	await s.view.onClose();
});

it("отправляет актуальную выбранную заметку и сохраняет снимок для следующего вопроса", async () => {
	const s = await setup();
	s.mention();
	expect(s.root.getText()).toContain("План");
	s.edit("---\nстатус: исправлен\n---\nСвежая метка\n[[Секрет]]\n![[Вложение]]");
	s.input.appendChild(Object.assign(new TestElement(), { text: " Что изменилось?" }));
	s.send.click(); await flushPromises();
	expect(s.chat).toHaveBeenCalledTimes(1);
	const content = s.chat.mock.calls[0]![2].map((m: any) => m.content).join("\n");
	expect(content).toContain("Свежая метка");
	expect(content).toContain("Проекты/План.md");
	expect(content).toContain("статус: исправлен");
	expect(content).toContain("[[Секрет]]");
	s.edit("Новая версия после ответа");
	s.input.value = "Продолжи"; s.send.click(); await flushPromises();
	expect(s.chat.mock.calls[1]![2].map((m: any) => m.content).join("\n")).toContain("Свежая метка");
	expect(s.chat.mock.calls[1]![2].map((m: any) => m.content).join("\n")).not.toContain("Новая версия после ответа");
	await s.view.onClose();
});

it.each(["Enter", "Tab", "ArrowDown", "ArrowUp", "click"])("явный выбор через %s, удаление и чистое упоминание", async action => {
	const s = await setup();
	s.type("@");
	expect(s.root.getText()).toContain("Проекты/План.md");
	if (action === "click") s.root.find("ai-helper-mention-suggest").children[0].click();
	else {
		s.input.keydown(action);
		if (action.startsWith("Arrow")) s.input.keydown("Enter");
	}
	expect(s.input.getText()).toBe("@План");
	expect(s.input.children.find(child => child.attributes.title === s.file.path)?.attributes["aria-label"]).toContain(s.file.path);
	s.send.click(); await flushPromises();
	expect(s.chat).not.toHaveBeenCalled();
	expect(s.input.getText()).toBe("@План");
	s.input.children.find(child => child.attributes.title === s.file.path)!.remove();
	s.input.value = "Обычный вопрос"; s.send.click(); await flushPromises();
	expect(s.chat.mock.calls[0][2]).toEqual([{ role: "user", content: "Обычный вопрос" }]);
	await s.view.onClose();
});

it.each(["Почта user@example.com", "`код @", "``код ` @", "```ts\nкод @", "~~~\nкод @"])("не открывает подсказку в почте и коде: %s", async text => {
	const s = await setup();
	s.type(text); s.input.keydown("Tab");
	expect(s.input.getText()).toBe(text);
	expect(s.root.find("ai-helper-mention-suggest").getText()).toBe("");
	s.send.click(); await flushPromises();
	expect(s.chat.mock.calls[0][2]).toEqual([{ role: "user", content: text }]);
	await s.view.onClose();
});

it.each(["Escape", "Escape+Enter", "paste"])("обычный @ сохраняется без вложения: %s", async action => {
	const s = await setup();
	s.type("Вопрос @", action === "paste" ? "insertFromPaste" : "insertText");
	if (action !== "paste") s.input.keydown("Escape");
	if (action === "Escape+Enter") s.input.keydown("Enter"); else s.send.click();
	await flushPromises();
	expect(s.chat.mock.calls[0][2]).toEqual([{ role: "user", content: "Вопрос @" }]);
	await s.view.onClose();
});

it("читает выбранный файл из хранилища после закрытия его редактора", async () => {
	const s = await setup(); s.mention();
	s.workspace.getActiveViewOfType = () => null as any;
	s.workspace.getLeavesOfType = () => [];
	s.edit("Текст закрытой заметки");
	s.input.createSpan({ text: " Объясни" }); s.send.click(); await flushPromises();
	expect(s.read).toHaveBeenCalledWith(s.file);
	expect(s.chat.mock.calls[0][2][0].content).toContain("Текст закрытой заметки");
	await s.view.onClose();
});

it("переключение вкладки не меняет выбранную заметку; режим чтения использует полные данные", async () => {
	const s = await setup(); s.mention();
	const other = Object.assign(new MarkdownView({} as WorkspaceLeaf), { file: Object.assign(new TFile(), { path: "Другой.md", basename: "Другой" }) });
	const original = s.workspace.getActiveViewOfType()!;
	original.getMode = () => "preview";
	original.getViewData = () => "---\nметка: режим чтения\n---\nТекст";
	s.workspace.getActiveViewOfType = () => other as any;
	s.input.createSpan({ text: " Объясни" }); s.send.click(); await flushPromises();
	expect(s.chat.mock.calls[0][2][0].content).toContain("режим чтения");
	expect(s.chat.mock.calls[0][2][0].content).toContain("Проекты/План.md");
	expect(s.chat.mock.calls[0][2][0].content).not.toContain("Другой.md");
	await s.view.onClose();
});

it.each(["unknown", "budget", "unavailable"])("блокирует %s и сохраняет весь черновик", async reason => {
	const s = await setup(); s.mention(); s.input.createSpan({ text: " Объясни" });
	if (reason === "unknown") s.view.plugin.settings.contextWindow = "";
	if (reason === "budget") s.view.plugin.settings.contextWindow = "100";
	if (reason === "unavailable") s.view.app.vault.getFileByPath = () => null;
	s.send.click(); await flushPromises();
	expect(s.chat).not.toHaveBeenCalled();
	const key = reason === "unknown" ? "mention-window-unknown" : reason === "budget" ? "mention-budget" : "mention-file-unavailable";
	expect(s.root.getText() + Notice.messages.join("\n")).toContain(t(key));
	expect(s.input.getText()).toBe("@План Объясни");
	expect(s.input.children.some(child => child.attributes.title === "Проекты/План.md")).toBe(true);
	expect(s.view.getMessages()).toEqual([]);
	await s.view.onClose();
});

it("ошибка восстанавливает упоминание; повтор читает свежую заметку", async () => {
	const s = await setup();
	s.chat.mockResolvedValueOnce({ ok: false, error: { message: "Сервер недоступен" } });
	s.mention(); s.input.createSpan({ text: " Объясни" }); s.send.click(); await flushPromises();
	expect(s.input.getText()).toBe("@План Объясни");
	expect(s.view.getMessages()).toEqual([]);
	s.edit("Версия для повтора"); s.send.click(); await flushPromises();
	expect(s.chat.mock.calls[1][2][0].content).toContain("Версия для повтора");
	expect(s.view.getMessages()).toHaveLength(2);
	await s.view.onClose();
});

it.each(["new-draft", "new-mention", "stop", "clear"])("неуспешный ход не попадает в историю: %s", async action => {
	const s = await setup();
	const { deferred } = await import("./helpers/obsidian");
	const pending = deferred<ServerClientResult<ChatCompletionResult>>();
	s.chat.mockReturnValueOnce(pending.promise);
	s.mention(); s.input.createSpan({ text: " Объясни" }); s.send.click(); await flushPromises();
	s.chat.mock.calls[0][3]?.onText?.("Частичный ответ"); await flushPromises();
	if (action === "new-draft") s.input.value = "Новый черновик";
	if (action === "new-mention") s.mention();
	if (action === "stop") s.send.click();
	if (action === "clear") { s.input.value = "Черновик при очистке"; s.root.find("ai-helper-clear-btn").click(); }
	pending.resolve(action === "clear" ? { ok: true, value: { content: "Поздний ответ" } } : { ok: false, error: { message: "Ошибка" } });
	await flushPromises();
	expect(s.view.getMessages()).toEqual([]);
	expect(s.input.getText()).toBe(action === "new-draft" ? "Новый черновик" : action === "new-mention" ? "@План" : action === "clear" ? "Черновик при очистке" : "");
	if (action === "stop") expect(s.root.getText()).toContain("Частичный ответ");
	s.input.value = "Продолжи"; s.send.click(); await flushPromises();
	expect(s.chat.mock.calls[1][2]).toEqual([{ role: "user", content: "Продолжи" }]);
	await s.view.onClose();
});

it("проверяет всё сообщение, историю, системный промпт, резерв и запас при известном окне с ручным приоритетом", async () => {
	const s = await setup();
	const countPromptTokens = vi.fn<Parameters<ServerClient["countPromptTokens"]>, ReturnType<ServerClient["countPromptTokens"]>>(async () => ({ tokens: 700, method: "bytes" as const }));
	s.view.plugin.serverClient.countPromptTokens = countPromptTokens;
	s.view.plugin.settings.systemPrompt = "Отвечай по-русски";
	s.view.plugin.settings.maxTokens = "100";
	s.view.plugin.settings.contextWindow = "1056";
	s.view.plugin.contextWindowConnection = { value: { tokens: 800, source: "авто" }, refresh: async () => {} } as any;
	s.mention(); s.input.createSpan({ text: " Объясни" }); s.send.click(); await flushPromises();
	expect(s.chat).toHaveBeenCalledOnce();
	expect(s.chat.mock.calls[0][3]?.maxTokens).toBe("100");
	expect(countPromptTokens.mock.calls[0][2][0]).toEqual({ role: "system", content: "Отвечай по-русски" });
	expect(countPromptTokens.mock.calls[0][2][1].content).toContain("Первоначальная метка");
	s.view.plugin.settings.contextWindow = "1055";
	s.input.value = "Продолжи"; s.send.click(); await flushPromises();
	expect(s.chat).toHaveBeenCalledOnce();
	expect(s.input.getText()).toBe("Продолжи");
	expect(countPromptTokens.mock.calls[1][2]).toHaveLength(4);
	expect(countPromptTokens.mock.calls[1][2][1].content).toContain("Первоначальная метка");
	s.view.plugin.settings.contextWindow = "";
	s.send.click(); await flushPromises();
	expect(s.chat).toHaveBeenCalledOnce();
	s.view.plugin.contextWindowConnection = { value: { tokens: 1056, source: "авто" }, refresh: async () => {} } as any;
	s.send.click(); await flushPromises();
	expect(s.chat).toHaveBeenCalledTimes(2);
	s.root.find("ai-helper-clear-btn").click();
	s.input.value = "После очистки"; s.send.click(); await flushPromises();
	expect(s.chat.mock.calls[2][2]).toEqual([{ role: "user", content: "После очистки" }]);
	await s.view.onClose();
});

it("без текущей заметки доступен обычный чат; локаль и очистка сохраняют упоминание", async () => {
	const s = await setup(); s.mention(); s.input.createSpan({ text: " Объясни" });
	setLanguage("en"); await s.view.refreshLocale();
	s.root.find("ai-helper-clear-btn").click();
	expect(s.input.getText()).toBe("@План Объясни");
	expect(s.input.children.some(child => child.attributes.title === s.file.path)).toBe(true);
	await s.view.onClose(); await s.view.onOpen();
	expect((s.view.contentEl as unknown as TestElement).find("ai-helper-input").getText()).toBe("@План Объясни");
	await s.view.onClose();
	const plain = await setup([]);
	plain.workspace.getActiveViewOfType = () => null as any;
	plain.type("Вопрос @"); plain.input.keydown("Tab"); plain.send.click(); await flushPromises();
	expect(plain.chat.mock.calls[0][2]).toEqual([{ role: "user", content: "Вопрос @" }]);
	await plain.view.onClose();
});

it("запоминает последнюю открытую заметку до перехода фокуса в чат", async () => {
	const s = await setup();
	const { AiHelperPlugin } = await import("../src/main");
	const callbacks = new Map<string, (...args: any[]) => void>();
	const workspace = { ...s.workspace, on: (event: string, callback: (...args: any[]) => void) => { callbacks.set(event, callback); return {} as any; } };
	const plugin = new AiHelperPlugin({ workspace } as any, {} as any);
	await plugin.onload();
	plugin.settings = s.view.plugin.settings; plugin.serverClient = s.view.plugin.serverClient;
	s.view.plugin = plugin; s.view.app.workspace = workspace as any;
	workspace.getActiveViewOfType = () => null as any;
	callbacks.get("active-leaf-change")?.();
	s.type("@"); s.input.keydown("Tab");
	expect(s.input.getText()).toBe("@План");
	const next = Object.assign(new TFile(), { basename: "Следующая", path: "Следующая.md", extension: "md" });
	s.files.push(next);
	callbacks.get("file-open")?.(next);
	s.input.value = "@"; s.input.dispatchEvent({ type: "input", inputType: "insertText", data: "@" } as any); s.input.keydown("Tab");
	expect(s.input.getText()).toBe("@Следующая");
	await s.view.onClose();
});

 it("связывает подсказку с полем для вспомогательных технологий и оставляет вставку нативной", async () => {
	const s = await setup();
	s.type("@");
	const popup = s.root.find("ai-helper-mention-suggest");
	expect(s.input.attributes["aria-controls"]).toBe(popup.attributes.id);
	expect(s.input.attributes["aria-activedescendant"]).toBe(popup.children[0].attributes.id);
	s.input.keydown("Escape");
	expect(s.input.attributes["aria-activedescendant"]).toBeUndefined();
	const preventDefault = vi.fn();
	s.input.dispatchEvent({ type: "paste", preventDefault } as any);
	expect(preventDefault).not.toHaveBeenCalled();
	await s.view.onClose();
 });


it.each(["без стрелок", "ArrowDown", "ArrowUp"])("Enter подтверждает подсказку без отправки (%s), следующий Enter отправляет снимок", async navigation => {
	const s = await setup();
	s.type("Объясни @");
	if (navigation !== "без стрелок") s.input.keydown(navigation);
	s.input.keydown("Enter"); await flushPromises();
	expect(s.chat).not.toHaveBeenCalled();
	expect(s.input.getText()).toBe("Объясни @План");
	expect(s.input.children.some(child => child.attributes.title === s.file.path)).toBe(true);
	expect(s.input.attributes["aria-expanded"]).toBe("false");
	s.input.keydown("Enter"); await flushPromises();
	expect(s.chat).toHaveBeenCalledOnce();
	expect(s.chat.mock.calls[0][2][0].content).toContain("Проекты/План.md");
	expect(s.chat.mock.calls[0][2][0].content).toContain("Первоначальная метка");
	await s.view.onClose();
});


it("Shift+Enter при открытой подсказке оставляет нативный перенос строки без выбора и отправки", async () => {
	const s = await setup();
	s.type("Объясни @");
	s.input.keydown("ArrowDown");
	const preventDefault = vi.fn();
	s.input.dispatchEvent({ type: "keydown", key: "Enter", shiftKey: true, preventDefault } as any);
	await flushPromises();
	expect(preventDefault).not.toHaveBeenCalled();
	expect(s.chat).not.toHaveBeenCalled();
	expect(s.input.getText()).toBe("Объясни @");
	expect(s.input.children.some(child => child.attributes.title === s.file.path)).toBe(false);
	s.type("Объясни @\nСледующая строка", "insertLineBreak");
	s.input.keydown("Enter"); await flushPromises();
	expect(s.chat.mock.calls[0][2]).toEqual([{ role: "user", content: "Объясни @\nСледующая строка" }]);
	await s.view.onClose();
});

it("предлагает текущую заметку первой и весь каталог по пути без индекса и embedding-модели", async () => {
	const s = await setup(["Я/План.md", "Исключённые/План.md", "Проекты/План.md", "Архив/План.md"]);
	s.view.plugin.settings.excludedFolders = ["Исключённые"];
	s.type("@");
	expect(s.root.find("ai-helper-mention-suggest").children.map(option => option.getText())).toEqual([
		"План — Проекты/План.md", "План — Архив/План.md", "План — Исключённые/План.md", "План — Я/План.md",
	]);
	await s.view.onClose();
});

it.each([
	["@ПЛАН", ["План — Архив/План.md", "План встречи — Новый проект/План встречи.md", "План — Проекты/План.md"]],
	["@аРхИв/пЛ", ["План — Архив/План.md"]],
	["@Новый проект/план", ["План встречи — Новый проект/План встречи.md"]],
	["@проект план", ["План встречи — Новый проект/План встречи.md", "План — Проекты/План.md"]],
])("фильтрует полный путь цельной подстрокой без регистра: %s", async (query, expected) => {
	const s = await setup(["Проекты/План.md", "Новый проект/План встречи.md", "Архив/План.md"], false);
	s.type(query);
	expect(s.root.find("ai-helper-mention-suggest").children.map(option => option.getText())).toEqual(expected);
	expect(s.input.getText()).toBe(query);
	await s.view.onClose();
});

it.each(["project monexa", "MONEXA PROJECT", "project   monexa"])("находит слова в любом порядке и отправляет выбранную заметку: %s", async query => {
	const s = await setup(["Projects/Another.md", "Monexa/Project.md", "Docs/ProjectDescriptionMonexa/README.md", "1.Projects/Monexa.md"], false);
	s.read.mockImplementation(async file => `Содержимое выбранной заметки: ${file.path}`);
	s.type(`Объясни @${query}`);
	expect(s.root.find("ai-helper-mention-suggest").children.map(option => option.getText())).toEqual([
		"Monexa — 1.Projects/Monexa.md", "README — Docs/ProjectDescriptionMonexa/README.md", "Project — Monexa/Project.md",
	]);
	expect(s.input.getText()).toBe(`Объясни @${query}`);
	expect(s.input.children.some(child => child.attributes.title)).toBe(false);
	s.root.find("ai-helper-mention-suggest").children[1].click();
	s.input.keydown("Enter"); await flushPromises();
	expect(s.chat.mock.calls[0][2][0].content).toContain("Содержимое выбранной заметки: Docs/ProjectDescriptionMonexa/README.md");
	expect(s.chat.mock.calls[0][2][0].content).not.toContain("1.Projects/Monexa.md");
	await s.view.onClose();
});


it.each([
	["projemonex", ["1.Projects/Monexa.md", "Docs/ProjectDescriptionMonexa/README.md"]],
	["ПРКТПЛН", ["Проекты/План.md"]],
	["плн пркт", ["Проекты/План.md"]],
	["monexproje", ["Monexa/Project.md"]],
	["projeznex", []],
])("находит сокращения с сохранением порядка букв: %s", async (query, paths) => {
	const s = await setup(["Проекты/План.md", "Projects/Another.md", "Monexa/Project.md", "Docs/ProjectDescriptionMonexa/README.md", "1.Projects/Monexa.md"], false);
	s.read.mockImplementation(async file => `Снимок: ${file.path}`);
	s.type(`Объясни @${query}`);
	const options = s.root.find("ai-helper-mention-suggest").children;
	expect(options.map(option => option.getText())).toEqual(paths.length ? paths.map(path => `${path.split("/").pop()!.slice(0, -3)} — ${path}`) : [t("mention-no-results")]);
	if (paths.length) {
		s.input.keydown("Tab");
		s.input.keydown("Enter"); await flushPromises();
		expect(s.chat.mock.calls[0][2][0].content).toContain(`Снимок: ${paths[0]}`);
	} else {
		s.input.keydown("Escape");
		expect(s.input.getText()).toBe(`Объясни @${query}`);
		s.input.keydown("Enter"); await flushPromises();
		expect(s.chat.mock.calls[0][2]).toEqual([{ role: "user", content: `Объясни @${query}`.trim() }]);
	}
	await s.view.onClose();
});

it.each(["план", "ПЛАН", "  план  "])("ранжирует цельное совпадение, затем компактность, затем путь: %s", async query => {
	const s = await setup(["Проекты/План.md", "Я/План.md", "Б/Пл-ан.md", "А/Пл-ан.md", "0/П---л---а---н.md", "1/П----------л/Пл-ан.md"]);
	s.type("@");
	expect(s.root.find("ai-helper-mention-suggest").children[0].getText()).toBe("План — Проекты/План.md");
	s.type(`Объясни @${query}`);
	expect(s.root.find("ai-helper-mention-suggest").children.map(option => option.getText())).toEqual([
		"План — Проекты/План.md", "План — Я/План.md", "Пл-ан — 1/П----------л/Пл-ан.md",
		"Пл-ан — А/Пл-ан.md", "Пл-ан — Б/Пл-ан.md", "П---л---а---н — 0/П---л---а---н.md",
	]);
	s.input.keydown("Escape");
	expect(s.input.getText()).toBe(`Объясни @${query}`);
	s.input.keydown("Enter"); await flushPromises();
	expect(s.chat.mock.calls[0][2]).toEqual([{ role: "user", content: `Объясни @${query}`.trim() }]);
	await s.view.onClose();
});

it("релевантность фильтра важнее текущей заметки", async () => {
	const s = await setup(["Проекты/План.md", "А/ПрктПлн.md"]);
	s.type("Объясни @прктплн");
	expect(s.root.find("ai-helper-mention-suggest").children.map(option => option.getText())).toEqual([
		"ПрктПлн — А/ПрктПлн.md", "План — Проекты/План.md",
	]);
	s.read.mockResolvedValue("Выбрана точная заметка");
	s.input.keydown("Enter"); s.input.keydown("Enter"); await flushPromises();
	expect(s.chat.mock.calls[0][2][0].content).toContain("А/ПрктПлн.md");
	expect(s.chat.mock.calls[0][2][0].content).toContain("Выбрана точная заметка");
	expect(s.chat.mock.calls[0][2][0].content).not.toContain("Проекты/План.md");
	await s.view.onClose();
});

it.each([
	["promo", "Project/Monexa.md", ["Pro", "Mo"], ["Mo"]],
	["MONEXA project", "Project/Monexa.md", ["Project", "Monexa"], ["Monexa"]],
	["прктплн", "Проекты/План.md", ["Пр", "кт", "Пл", "н"], ["Пл", "н"]],
	["план", "П---л/План.md", ["План"], ["План"]],
	["плн", "П----------л/Пл-ан.md", ["Пл", "н"], ["Пл", "н"]],
	["план", "İ/План.md", ["План"], ["План"]],
])("подсвечивает совпавшие части имени и пути для %s", async (query, path, pathMatches, nameMatches) => {
	const s = await setup([path], false);
	s.type(`Объясни @${query}`);
	const option = s.root.find("ai-helper-mention-suggest").children[0];
	const highlights = (element: TestElement): string[] => element.children.flatMap(child => child.classes.has("ai-helper-mention-match") ? [child.getText()] : highlights(child));
	expect(highlights(option.children[0])).toEqual(nameMatches);
	expect(highlights(option.children[1])).toEqual(pathMatches);
	expect(option.getText()).toBe(`${path.split("/").pop()!.slice(0, -3)} — ${path}`);
	s.input.keydown("ArrowDown");
	expect(highlights(s.root.find("ai-helper-mention-suggest").children[0].children[1])).toEqual(pathMatches);
	s.input.keydown("Enter"); s.input.keydown("Enter"); await flushPromises();
	expect(s.chat.mock.calls[0][2][0].content).toContain(path);
	s.type("@");
	expect(highlights(s.root.find("ai-helper-mention-suggest"))).toEqual([]);
	await s.view.onClose();
});

it.each(["Enter", "Tab", "click"])("выбирает исключённую заметку без текущей вкладки через %s и сохраняет её снимок", async action => {
	const s = await setup(["Исключённые/План.md", "Архив/План.md"], false);
	s.view.plugin.settings.excludedFolders = ["Исключённые"];
	s.type("Объясни @ИСКЛЮЧЁННЫЕ");
	if (action === "click") s.root.find("ai-helper-mention-suggest").children[0].click();
	else s.input.keydown(action);
	expect(s.chat).not.toHaveBeenCalled();
	expect(s.input.children.some(child => child.attributes.title === "Исключённые/План.md")).toBe(true);
	s.edit("Свежий текст исключённой заметки");
	s.input.keydown("Enter"); await flushPromises();
	expect(s.chat.mock.calls[0][2][0].content).toContain("Исключённые/План.md");
	expect(s.chat.mock.calls[0][2][0].content).toContain("Свежий текст исключённой заметки");
	expect(s.chat.mock.calls[0][2][0].content).not.toContain("Архив/План.md");
	s.edit("Изменение после ответа");
	s.type("Продолжи"); s.send.click(); await flushPromises();
	expect(s.chat.mock.calls[1][2][0].content).toContain("Свежий текст исключённой заметки");
	expect(s.chat.mock.calls[1][2][0].content).not.toContain("Изменение после ответа");
	await s.view.onClose();
});

it.each(["ArrowDown", "ArrowUp"])("навигация %s выбирает другой путь; удаление позволяет заменить заметку без остаточного контекста", async key => {
	const s = await setup(["Проекты/План.md", "Архив/План.md"]);
	s.type("Объясни @"); s.input.keydown(key);
	const options = s.root.find("ai-helper-mention-suggest").children;
	expect(options[1].attributes["aria-selected"]).toBe("true");
	expect(s.input.attributes["aria-activedescendant"]).toBe(options[1].attributes.id);
	s.input.keydown("Enter");
	expect(s.input.children.some(child => child.attributes.title === "Архив/План.md")).toBe(true);
	s.workspace.getActiveViewOfType = () => null;
	s.edit("Текст выбранной архивной заметки");
	s.input.children.find(child => child.attributes.title === "Архив/План.md")!.remove();
	s.input.createSpan({ text: "@Проекты" });
	s.input.dispatchEvent({ type: "input", inputType: "insertText" } as any);
	s.input.keydown("Tab");
	s.send.click(); await flushPromises();
	expect(s.chat.mock.calls[0][2][0].content).toContain("Проекты/План.md");
	expect(s.chat.mock.calls[0][2][0].content).not.toContain("Архив/План.md");
	await s.view.onClose();
});

it.each(["ru", "en"] as const)("нет совпадений: локализованная подсказка, Enter сохраняет текст, Escape закрывает список (%s)", async locale => {
	const s = await setup(["Архив/План.md"], false);
	setLanguage(locale);
	s.type("Объясни @Несуществующая");
	expect(s.root.find("ai-helper-mention-suggest").getText()).toBe(locale === "ru" ? "Подходящие заметки не найдены." : "No matching notes.");
	s.input.keydown("Enter"); await flushPromises();
	expect(s.chat).not.toHaveBeenCalled();
	expect(s.input.getText()).toBe("Объясни @Несуществующая");
	s.input.keydown("Escape");
	expect(s.root.find("ai-helper-mention-suggest").style.display).toBe("none");
	s.input.keydown("Enter"); await flushPromises();
	expect(s.chat.mock.calls[0][2]).toEqual([{ role: "user", content: "Объясни @Несуществующая" }]);
	await s.view.onClose();
});


it("ввод вопроса после выбранной заметки не открывает подсказку повторно и отправляет выбранный файл при другой вкладке", async () => {
	const s = await setup(["Проекты/План.md", "Архив/План.md"]);
	s.read.mockImplementation(async file => file.path === "Архив/План.md" ? "Архивный текст" : "Другой текст");
	s.type("@Архив"); s.input.keydown("Enter");
	s.input.createSpan({ text: " Объясни" });
	s.input.dispatchEvent({ type: "input", inputType: "insertText" } as any);
	expect(s.input.attributes["aria-expanded"]).toBe("false");
	s.input.keydown("Enter"); await flushPromises();
	expect(s.chat.mock.calls[0][2][0].content).toContain("Архивный текст");
	expect(s.chat.mock.calls[0][2][0].content).not.toContain("Первоначальная метка");
	await s.view.onClose();
});


it.each(["deleteContentBackward", "deleteContentForward"])("исправление фильтра через %s обновляет список и позволяет отправить снимок", async inputType => {
	const s = await setup(["Архив/План.md"], false);
	s.type("Объясни @Планы");
	expect(s.root.find("ai-helper-mention-suggest").getText()).toBe("Подходящие заметки не найдены.");
	s.type("Объясни @План", inputType);
	expect(s.root.find("ai-helper-mention-suggest").getText()).toBe("План — Архив/План.md");
	s.input.keydown("Enter"); await flushPromises();
	expect(s.chat).not.toHaveBeenCalled();
	s.input.keydown("Enter"); await flushPromises();
	expect(s.chat.mock.calls[0][2][0].content).toContain("Архив/План.md");
	await s.view.onClose();
});


it("переименование обновляет все упоминания; новый файл на прежнем пути не подменяет закрытую заметку", async () => {
	const s = await setup(["Личное/План.md", "Знания/План.md"], false);
	appendMention(s, "Сравни @Личное"); appendMention(s, " и @Личное"); appendMention(s, " с @Знания");
	const original = s.files.find(file => file.path === "Личное/План.md")!;
	s.rename(original, "Личное/План выходных.md");
	expect(s.input.getText()).toBe("Сравни @План выходных и @План выходных с @План");
	s.rename(original, "Проверка/План выходных.md");
	expect(s.input.children.filter(child => child.attributes.title).map(child => child.attributes.title)).toEqual([
		"Проверка/План выходных.md", "Проверка/План выходных.md", "Знания/План.md",
	]);
	const replacement = Object.assign(new TFile(), { path: "Личное/План.md", basename: "План", extension: "md" });
	s.files.push(replacement); s.emit("create", replacement);
	s.workspace.getActiveViewOfType = () => null; s.workspace.getLeavesOfType = () => [];
	s.read.mockImplementation(async file => file === original ? "Свежий исходный план" : file === replacement ? "Подмена" : "Учебный план");
	s.send.click(); await flushPromises();
	expect(attachments(s.chat.mock.calls[0][2][0].content)).toEqual([
		{ title: "План выходных", path: "Проверка/План выходных.md", markdown: "Свежий исходный план" },
		{ title: "План", path: "Знания/План.md", markdown: "Учебный план" },
	]);
	await s.view.onClose();
});


it("открытый каталог сразу отражает создание, переименование и удаление текущей заметки", async () => {
	const s = await setup();
	s.view.plugin.currentNote = s.file;
	s.type("@");
	const options = () => s.root.find("ai-helper-mention-suggest").children.map(option => option.getText());
	s.rename(s.file, "Проекты/Новый план.md");
	expect(options()).toEqual(["Новый план — Проекты/Новый план.md"]);
	const added = Object.assign(new TFile(), { path: "Архив/Справка.md", basename: "Справка", extension: "md" });
	s.files.push(added); s.emit("create", added);
	expect(options()).toEqual(["Новый план — Проекты/Новый план.md", "Справка — Архив/Справка.md"]);
	s.files.splice(s.files.indexOf(s.file), 1); s.emit("delete", s.file);
	expect(options()).toEqual(["Справка — Архив/Справка.md"]);
	s.input.keydown("Enter"); s.input.createSpan({ text: " Объясни" }); s.send.click(); await flushPromises();
	expect(attachments(s.chat.mock.calls[0][2][0].content)[0].path).toBe("Архив/Справка.md");
	await s.view.onClose();
});

it("новый файл по удалённому пути требует нового выбора; последнее повторение управляет вложением", async () => {
	const s = await setup(["Личное/План.md", "Знания/План.md"], false);
	appendMention(s, "Сравни @Личное"); appendMention(s, " и @Личное"); appendMention(s, " с @Знания");
	const original = s.files.find(file => file.path === "Личное/План.md")!;
	s.rename(original, "Личное/Выходные.md");
	s.files.splice(s.files.indexOf(original), 1); s.emit("delete", original);
	const replacement = Object.assign(new TFile(), { path: "Личное/Выходные.md", basename: "Выходные", extension: "md" });
	s.files.push(replacement); s.emit("create", replacement);
	s.send.click(); await flushPromises();
	expect(s.chat).not.toHaveBeenCalled();
	expect(s.root.getText()).toContain("Личное/Выходные.md");
	const chips = s.input.children.filter(child => child.attributes.title === "Личное/Выходные.md");
	chips[0].remove(); s.send.click(); await flushPromises();
	expect(s.chat).not.toHaveBeenCalled();
	s.input.children.find(child => child.attributes.title === "Личное/Выходные.md")!.remove();
	appendMention(s, " и новый @Выходные");
	s.read.mockImplementation(async file => file === replacement ? "Новый явный выбор" : "Учебный план");
	s.send.click(); await flushPromises();
	expect(attachments(s.chat.mock.calls[0][2][0].content)).toEqual([
		{ title: "План", path: "Знания/План.md", markdown: "Учебный план" },
		{ title: "Выходные", path: "Личное/Выходные.md", markdown: "Новый явный выбор" },
	]);
	await s.view.onClose();
});

it("закрытие освобождает события; повторное открытие сохраняет черновик и обновляет его после переименования", async () => {
	const s = await setup(); s.mention(); s.input.createSpan({ text: " Объясни" });
	await s.view.onClose();
	expect([...s.listeners.values()].every(callbacks => callbacks.size === 0)).toBe(true);
	s.rename(s.file, "Архив/Переименованный план.md");
	await s.view.onOpen();
	const input = (s.view.contentEl as unknown as TestElement).find("ai-helper-input");
	expect(input.getText()).toBe("@Переименованный план Объясни");
	expect([...s.listeners.values()].map(callbacks => callbacks.size)).toEqual([1, 1, 1]);
	s.rename(s.file, "Архив/Итог.md");
	expect(input.getText()).toBe("@Итог Объясни");
	await s.view.onClose();
});

it("переименование и удаление после ответа сохраняют снимок и отображение истории после смены языка", async () => {
	const s = await setup(); s.mention(); s.input.createSpan({ text: " Объясни" });
	s.send.click(); await flushPromises();
	const originalRequest = s.chat.mock.calls[0][2][0].content;
	s.rename(s.file, "Архив/Новый план.md");
	s.files.splice(s.files.indexOf(s.file), 1); s.emit("delete", s.file);
	setLanguage("en"); await s.view.refreshLocale();
	expect(s.root.find("ai-helper-messages").getText()).toContain("@План Объясни");
	expect(s.root.find("ai-helper-messages").getText()).not.toContain("@Новый план");
	s.type("Продолжи"); s.send.click(); await flushPromises();
	expect(s.chat.mock.calls[1][2][0].content).toBe(originalRequest);
	await s.view.onClose();
});

it("переименование во время проверки контекста обновляет снимок и повторно проверяет бюджет до запроса", async () => {
	const s = await setup(); s.mention(); s.input.createSpan({ text: " Объясни" });
	const count = deferred<{ tokens: number; method: "bytes" }>();
	const counter = vi.fn().mockImplementationOnce(() => count.promise).mockResolvedValue({ tokens: 200, method: "bytes" });
	s.view.plugin.serverClient.countPromptTokens = counter;
	s.send.click(); await flushPromises();
	s.rename(s.file, "Архив/Актуальный план.md"); s.edit("Актуальный текст после перемещения");
	count.resolve({ tokens: 200, method: "bytes" }); await flushPromises();
	expect(attachments(s.chat.mock.calls[0][2][0].content)).toEqual([
		{ title: "Актуальный план", path: "Архив/Актуальный план.md", markdown: "Актуальный текст после перемещения" },
	]);
	expect(counter.mock.calls[1][2][0].content).toBe(s.chat.mock.calls[0][2][0].content);
	await s.view.onClose();
});


it("передаёт точный выделенный Markdown и сохраняет снимок при правках и следующем вопросе", async () => {
	const s = await setup();
	s.edit("Снаружи\nДо **важного** [[План]] после\nХвост");
	Object.assign(s.editor.editor, {
		listSelections: () => [{ anchor: { line: 1, ch: 3 }, head: { line: 1, ch: 22 } }],
		getRange: () => "**важного** [[План]]",
	});
	s.type("Объясни @");
	expect(s.root.find("ai-helper-mention-suggest").getText()).toContain("План");
	s.type("Объясни @@");
	expect(s.root.find("ai-helper-mention-suggest").getText()).toContain("**важного** [[План]]");
	s.input.keydown("Tab");
	expect(s.input.getText()).toBe("Объясни План[2]");
	expect(s.chat).not.toHaveBeenCalled();
	s.edit("Уже изменённая заметка");
	s.send.click(); await flushPromises();
	const request = s.chat.mock.calls[0][2][0].content;
	expect(attachments(request)).toEqual([{
		title: "План", path: "Проекты/План.md", markdown: "**важного** [[План]]",
		range: { from: { line: 1, ch: 3 }, to: { line: 1, ch: 22 } },
	}]);
	expect(s.root.find("ai-helper-messages").getText()).toContain("Объясни План[2]");
	s.type("Продолжи"); s.send.click(); await flushPromises();
	expect(s.chat.mock.calls[1][2][0].content).toBe(request);
	await s.view.onClose();
});

it("после переноса фокуса подтверждает показанный текст последнего редактора", async () => {
	const s = await setup(["Проекты/План.md", "Архив/Другая.md"]);
	const selected = "Новый **выбор**\nдо границы\n";
	Object.assign(s.editor.editor, {
		listSelections: () => [{ anchor: { line: 11, ch: 4 }, head: { line: 16, ch: 0 } }],
		getRange: () => selected,
	});
	s.view.plugin.currentMarkdownView = s.editor;
	s.view.plugin.currentNote = s.files[1];
	s.workspace.getActiveViewOfType = () => null;
	s.type("Объясни @@");
	s.root.find("ai-helper-mention-suggest").children[0].click();
	expect(s.input.getText()).toBe("Объясни План[12-16]");
	expect(s.input.children.find(child => child.attributes.contenteditable === "false")?.attributes.title).toBe("Проекты/План.md");
	s.send.click(); await flushPromises();
	expect(attachments(s.chat.mock.calls[0][2][0].content)).toEqual([{
		title: "План", path: "Проекты/План.md", markdown: "Новый **выбор**\nдо границы\n",
		range: { from: { line: 11, ch: 4 }, to: { line: 16, ch: 0 } },
	}]);
	await s.view.onClose();
});

it.each(["Enter", "Tab", "click"])("подтверждает фрагмент через %s без отправки; Escape сохраняет текст", async action => {
	const s = await setup();
	Object.assign(s.editor.editor, {
		listSelections: () => [{ anchor: { line: 2, ch: 8 }, head: { line: 1, ch: 2 } }],
		getRange: () => "Часть строки\nконец",
	});
	s.type("@@");
	if (action === "click") s.root.find("ai-helper-mention-suggest").children[0].click();
	else s.input.keydown(action);
	expect(s.input.getText()).toBe("План[2-3]");
	expect(s.input.children.find(child => child.attributes.contenteditable === "false")).toBeDefined();
	s.send.click(); await flushPromises();
	expect(s.chat).not.toHaveBeenCalled();
	expect(Notice.messages).toContain(t("mention-question-required"));
	s.input.children.find(child => child.attributes.contenteditable === "false")!.remove();
	s.type("Объясни @@"); s.input.keydown("Escape");
	expect(s.input.getText()).toBe("Объясни @@");
	s.input.keydown("Enter", true); await flushPromises();
	expect(s.chat).not.toHaveBeenCalled();
	s.input.keydown("Enter"); await flushPromises();
	expect(s.chat.mock.calls[0][2]).toEqual([{ role: "user", content: "Объясни @@" }]);
	await s.view.onClose();
});

it.each(["нет выделения", "пробелы", "несмежные", "чтение", "закрыт", "другая заметка"])("не предлагает старое или неподходящее выделение: %s", async scenario => {
	const s = await setup();
	const selection = { anchor: { line: 0, ch: 0 }, head: { line: 0, ch: 4 } };
	Object.assign(s.editor.editor, {
		listSelections: () => scenario === "нет выделения" ? [] : scenario === "несмежные" ? [selection, selection] : [selection],
		getRange: () => scenario === "пробелы" ? " \n\t " : "Старый текст",
	});
	s.view.plugin.currentMarkdownView = s.editor;
	if (scenario === "чтение") s.editor.getMode = () => "preview";
	if (scenario === "закрыт") { s.workspace.getActiveViewOfType = () => null; s.workspace.getLeavesOfType = () => []; }
	if (scenario === "другая заметка") {
		const other = Object.assign(new MarkdownView({} as WorkspaceLeaf), { file: s.file, getMode: () => "source", editor: { listSelections: () => [] } });
		s.workspace.getActiveViewOfType = () => other;
	}
	s.type("Объясни @@");
	expect(s.root.find("ai-helper-mention-suggest").getText()).toBe(t(scenario === "несмежные" ? "mention-multiple-selections" : "mention-no-selection"));
	s.input.keydown("Tab"); s.input.keydown("Enter"); await flushPromises();
	expect(s.chat).not.toHaveBeenCalled();
	expect(s.input.getText()).toBe("Объясни @@");
	await s.view.onClose();
});

it.each([
	["Почта@@", "insertText", false], ["`@@", "insertText", false],
	["```md\n@@", "insertText", false], ["    @@", "insertText", false],
	["@@", "insertFromPaste", false], ["@@", "insertText", true],
])("обычный текст, код, вставка и IME не предлагают фрагмент: %s/%s/%s", async (text, inputType, isComposing) => {
	const s = await setup();
	Object.assign(s.editor.editor, {
		listSelections: () => [{ anchor: { line: 0, ch: 0 }, head: { line: 0, ch: 4 } }],
		getRange: () => "Снимок",
	});
	s.input.value = text;
	s.input.dispatchEvent({ type: "input", inputType, isComposing } as any);
	expect(s.input.attributes["aria-expanded"]).toBe("false");
	expect(s.input.children.some(child => child.attributes.contenteditable === "false")).toBe(false);
	await s.view.onClose();
});

it.each(["неизвестен", "мал", "история"])("сохраняет снимок и черновик, когда лимит %s", async scenario => {
	const s = await setup();
	Object.assign(s.editor.editor, {
		listSelections: () => [{ anchor: { line: 0, ch: 0 }, head: { line: 0, ch: 6 } }],
		getRange: () => "Снимок",
	});
	if (scenario === "история") {
		s.type("Предыдущий вопрос"); s.send.click(); await flushPromises();
	}
	s.view.plugin.settings.contextWindow = scenario === "неизвестен" ? "" : "100";
	s.type("Объясни @@"); s.input.keydown("Tab"); s.send.click(); await flushPromises();
	expect(s.chat.mock.calls).toHaveLength(scenario === "история" ? 1 : 0);
	expect(s.input.getText()).toBe("Объясни План[1]");
	expect(s.root.getText()).toContain(t(scenario === "неизвестен" ? "mention-window-unknown" : "mention-budget"));
	s.edit("Новое содержимое"); s.view.plugin.settings.contextWindow = "20000";
	s.send.click(); await flushPromises();
	expect(attachments(s.chat.mock.calls.at(-1)![2].at(-1)!.content)[0].markdown).toBe("Снимок");
	await s.view.onClose();
});

it("удаление последнего упоминания исключает снимок из запроса", async () => {
	const s = await setup();
	Object.assign(s.editor.editor, {
		listSelections: () => [{ anchor: { line: 0, ch: 0 }, head: { line: 0, ch: 6 } }],
		getRange: () => "Снимок",
	});
	s.type("Объясни @@"); s.input.keydown("Tab");
	s.input.children.find(child => child.attributes.contenteditable === "false")!.remove();
	s.send.click(); await flushPromises();
	expect(s.chat.mock.calls[0][2]).toEqual([{ role: "user", content: "Объясни" }]);
	await s.view.onClose();
});

it.each(["ru", "en"] as const)("копирует видимую подпись без снимка; вставка и смена языка сохраняют текст (%s)", async locale => {
	const s = await setup();
	const writeText = vi.fn().mockResolvedValue(undefined);
	vi.stubGlobal("navigator", { clipboard: { writeText } });
	try {
		Object.assign(s.editor.editor, {
			listSelections: () => [{ anchor: { line: 0, ch: 0 }, head: { line: 0, ch: 6 } }],
			getRange: () => "Скрытый снимок",
		});
		s.type("Объясни @@"); s.input.keydown("Tab");
		setLanguage(locale); await s.view.refreshLocale();
		expect(s.input.getText()).toBe("Объясни План[1]");
		s.send.click(); await flushPromises();
		s.root.find("ai-helper-message-user").find("ai-helper-copy-message").click(); await flushPromises();
		expect(writeText).toHaveBeenCalledWith("Объясни План[1]");
		s.type("Объясни План[1]", "insertFromPaste"); s.send.click(); await flushPromises();
		expect(s.chat.mock.calls[1][2].at(-1)).toEqual({ role: "user", content: "Объясни План[1]" });
		await s.view.onClose();
	} finally { vi.unstubAllGlobals(); }
});

it("сохраняет происхождение фрагмента после переименования, удаления и повторного открытия чата", async () => {
	const s = await setup();
	Object.assign(s.editor.editor, {
		listSelections: () => [{ anchor: { line: 0, ch: 0 }, head: { line: 0, ch: 6 } }],
		getRange: () => "Снимок",
	});
	s.type("Объясни @@"); s.input.keydown("Tab");
	s.rename(s.file, "Архив/Итог.md");
	s.files.splice(s.files.indexOf(s.file), 1); s.emit("delete", s.file);
	await s.view.onClose(); await s.view.onOpen();
	const input = s.root.find("ai-helper-input");
	expect(input.getText()).toBe("Объясни План[1]");
	expect(input.children.find(child => child.attributes.contenteditable === "false")?.attributes.title).toBe("Проекты/План.md");
	s.root.find("ai-helper-send").click(); await flushPromises();
	expect(attachments(s.chat.mock.calls[0][2][0].content)[0]).toMatchObject({ title: "План", path: "Проекты/План.md", markdown: "Снимок" });
	await s.view.onClose();
});

it("не подтверждает отсутствующее предложение после обычного текста @@", async () => {
	const s = await setup();
	Object.assign(s.editor.editor, {
		listSelections: () => [{ anchor: { line: 0, ch: 0 }, head: { line: 0, ch: 6 } }],
		getRange: () => "Снимок",
	});
	s.type("Объясни @@обычный текст"); s.input.keydown("Tab");
	expect(s.input.getText()).toBe("Объясни @@обычный текст");
	expect(s.input.children.some(child => child.attributes.contenteditable === "false")).toBe(false);
	await s.view.onClose();
});


it("не подменяет показанный фрагмент изменённым выделением и позволяет выбрать его заново", async () => {
	const s = await setup();
	let selected = "Первый выбор";
	Object.assign(s.editor.editor, {
		listSelections: () => [{ anchor: { line: 0, ch: 0 }, head: { line: 0, ch: 12 } }],
		getRange: () => selected,
	});
	s.type("Объясни @@");
	expect(s.root.find("ai-helper-mention-suggest").getText()).toContain("Первый выбор");
	selected = "Второй выбор";
	s.input.keydown("Tab");
	expect(s.input.getText()).toBe("Объясни @@");
	expect(s.input.attributes["aria-expanded"]).toBe("false");
	expect(s.chat).not.toHaveBeenCalled();
	s.type("Объясни @@"); s.input.keydown("Enter");
	selected = "Третий выбор";
	s.send.click(); await flushPromises();
	expect(attachments(s.chat.mock.calls[0][2][0].content)[0].markdown).toBe("Второй выбор");
	await s.view.onClose();
});


// Drive the public workspace/editor boundary, including the plugin's real event handlers.
async function setupEditors() {
	const s = await setup(["Проекты/План.md", "Итоги.md"]);
	const callbacks = new Map<string, ((...args: any[]) => void)[]>();
	let active: MarkdownView | null = s.editor;
	const workspace = {
		getActiveViewOfType: () => active,
		getLeavesOfType: () => editors.map(view => ({ view })),
		on: (event: string, callback: (...args: any[]) => void) => {
			callbacks.set(event, [...(callbacks.get(event) ?? []), callback]);
			return {} as any;
		},
	};
	function editor(file: TFile, initial: string) {
		let text = initial;
		let ranges = [{ anchor: { line: 0, ch: 0 }, head: { line: 0, ch: 0 } }];
		let mode: "source" | "preview" = "source";
		const view = Object.assign(new MarkdownView({} as WorkspaceLeaf), {
			file, getMode: () => mode,
			editor: {
				getValue: () => text,
				listSelections: () => ranges,
				getRange: (from: { line: number; ch: number }, to: { line: number; ch: number }) => {
					const lines = text.split("\n");
					const offset = (p: typeof from) => lines.slice(0, p.line).reduce((sum, line) => sum + line.length + 1, 0) + p.ch;
					return text.slice(offset(from), offset(to));
				},
			},
		});
		return { view, select: (next: typeof ranges) => { ranges = next; }, edit: (next: string) => { text = next; }, mode: (next: typeof mode) => { mode = next; } };
	}
	const a = editor(s.file, "Лишнее: первый выбор. Хвост");
	const b = editor(s.files[1], "Заголовок\nДо: второй выбор. Хвост\nСледующая строка");
	const editors = [a.view, b.view];
	active = a.view;
	const { AiHelperPlugin } = await import("../src/main");
	const plugin = new AiHelperPlugin({ workspace } as any, {} as any);
	await plugin.onload();
	plugin.settings = s.view.plugin.settings; plugin.serverClient = s.view.plugin.serverClient;
	s.view.plugin = plugin; s.view.app.workspace = workspace as any;
	const focus = (view: MarkdownView | null) => {
		s.input.dispatchEvent({ type: "blur" });
		active = view;
		callbacks.get("active-leaf-change")?.forEach(callback => callback(view ? { view } : null));
	};
	return { ...s, a, b, focus };
}

function appendFragment(s: Awaited<ReturnType<typeof setupEditors>>, editor: typeof s.a, from: { line: number; ch: number }, to: typeof from, text = " @@"): void {
	s.focus(editor.view); editor.select([{ anchor: from, head: to }]); s.focus(null);
	appendMention(s, text);
}

it.each(["result", "throw"] as const)("%s: ошибка не возвращает старый вопрос после ввода и удаления нового черновика", async failure => {
	const s = await setupEditors();
	appendFragment(s, s.a, { line: 0, ch: 8 }, { line: 0, ch: 20 }, "Объясни @@");
	const response = deferred<ServerClientResult<ChatCompletionResult>>();
	s.chat.mockImplementationOnce(async () => {
		const result = await response.promise;
		if (failure === "throw") throw new Error("Нет соединения");
		return result;
	});
	s.send.click(); await flushPromises();
	s.type("Новый вопрос"); s.type("", "deleteContentBackward");
	response.resolve({ ok: false, error: { message: "Нет соединения" } });
	await flushPromises();
	expect(s.root.find("ai-helper-messages").getText()).toContain("Нет соединения");
	expect(s.input.getText()).toBe("");
	expect(s.view.getMessages()).toEqual([]);
	await s.view.onClose();
});

it("повтор после ошибки сохраняет фрагменты удалённого оригинала, перечитывает целую заметку и проверяет бюджет с прежней историей", async () => {
	const s = await setupEditors();
	appendFragment(s, s.a, { line: 0, ch: 8 }, { line: 0, ch: 20 }, "Объясни @@");
	s.send.click(); await flushPromises();
	const successful = s.chat.mock.calls[0][2][0].content;
	appendFragment(s, s.b, { line: 1, ch: 4 }, { line: 1, ch: 16 }, "Сравни @@");
	appendMention(s, " с @План");
	appendFragment(s, s.a, { line: 0, ch: 8 }, { line: 0, ch: 20 }, " и @@");
	const draft = s.input.getText();
	const response = deferred<ServerClientResult<ChatCompletionResult>>();
	s.chat.mockImplementationOnce(() => response.promise);
	s.send.click(); await flushPromises();
	s.chat.mock.calls[1][3]?.onText?.("Частичное сравнение");
	response.resolve({ ok: false, error: { message: "Нет соединения" } });
	await flushPromises();
	expect(s.root.find("ai-helper-messages").getText()).toContain("Частичное сравнение");
	expect(s.root.find("ai-helper-messages").getText()).toContain("Нет соединения");
	expect(s.input.getText()).toBe(draft);
	expect(s.view.getMessages()).toHaveLength(2);
	s.rename(s.files[1], "Архив/Итоги.md");
	s.files.splice(1, 1); s.emit("delete", s.b.view.file);
	s.a.edit("Новый полный План"); s.b.edit("Стертый оригинал Итогов");
	Object.assign(s.view.plugin.settings, { contextWindow: "1000", maxTokens: "100" });
	const count = vi.fn<Parameters<ServerClient["countPromptTokens"]>, ReturnType<ServerClient["countPromptTokens"]>>(async () => ({ tokens: 645, method: "lmstudio" }));
	s.view.plugin.serverClient.countPromptTokens = count;
	s.send.click(); await flushPromises();
	expect(s.chat).toHaveBeenCalledTimes(2);
	expect(s.root.getText()).toContain(t("mention-budget"));
	expect(s.input.getText()).toBe(draft);
	expect(attachments(count.mock.calls[0][2].at(-1)!.content)).toEqual([
		{ title: "Итоги", path: "Итоги.md", markdown: "второй выбор", range: { from: { line: 1, ch: 4 }, to: { line: 1, ch: 16 } } },
		{ title: "План", path: "Проекты/План.md", markdown: "Новый полный План" },
		{ title: "План", path: "Проекты/План.md", markdown: "первый выбор", range: { from: { line: 0, ch: 8 }, to: { line: 0, ch: 20 } } },
	]);
	count.mockResolvedValue({ tokens: 644, method: "lmstudio" });
	s.send.click(); await flushPromises();
	const retried = s.chat.mock.calls[2][2];
	expect(retried.slice(0, 2)).toEqual([{ role: "user", content: successful }, { role: "assistant", content: "Ответ" }]);
	expect(retried.at(-1)!.content).toBe(count.mock.calls[0][2].at(-1)!.content);
	s.a.edit("Ещё более новый План");
	s.type("Продолжи"); s.send.click(); await flushPromises();
	expect(s.chat.mock.calls[3][2]).toEqual([...retried, { role: "assistant", content: "Ответ" }, { role: "user", content: "Продолжи" }]);
	await s.view.onClose();
});

it("ошибка сохраняет порядок и привязки смешанного нового черновика при смене языка", async () => {
	const s = await setupEditors();
	appendFragment(s, s.a, { line: 0, ch: 8 }, { line: 0, ch: 20 }, "Старый вопрос @@");
	const response = deferred<ServerClientResult<ChatCompletionResult>>();
	s.chat.mockImplementationOnce(() => response.promise);
	s.send.click(); await flushPromises();
	appendFragment(s, s.b, { line: 1, ch: 4 }, { line: 1, ch: 16 }, "Новый вопрос @@");
	appendMention(s, " с @План");
	appendFragment(s, s.a, { line: 0, ch: 8 }, { line: 0, ch: 20 }, " и @@");
	const draft = s.input.getText();
	setLanguage("en"); await s.view.refreshLocale();
	expect(s.send.attributes["aria-label"]).toBe("Stop");
	expect(s.input.getText()).toBe(draft);
	response.resolve({ ok: false, error: { message: "Нет соединения" } }); await flushPromises();
	expect(s.input.getText()).toBe(draft);
	expect(s.send.attributes["aria-label"]).toBe("Send");
	s.send.click(); await flushPromises();
	expect(s.chat.mock.calls[1][2]).toHaveLength(1);
	expect(attachments(s.chat.mock.calls[1][2][0].content).map(snapshot => [snapshot.path, snapshot.markdown])).toEqual([
		["Итоги.md", "второй выбор"], ["Проекты/План.md", "Лишнее: первый выбор. Хвост"], ["Проекты/План.md", "первый выбор"],
	]);
	await s.view.onClose();
});

it.each(["stop-empty", "stop-draft", "clear"] as const)("%s: отмена при смене языка сохраняет черновик с фрагментами и исключает поздний результат", async action => {
	const s = await setupEditors();
	appendFragment(s, s.a, { line: 0, ch: 8 }, { line: 0, ch: 20 }, "Успешный вопрос @@");
	s.send.click(); await flushPromises();
	const successful = s.chat.mock.calls[0][2][0].content;
	appendFragment(s, s.b, { line: 1, ch: 4 }, { line: 1, ch: 16 }, "Прерванный вопрос @@");
	const response = deferred<ServerClientResult<ChatCompletionResult>>();
	s.chat.mockImplementationOnce(() => response.promise);
	s.send.click(); await flushPromises();
	const params = s.chat.mock.calls[1][3]!;
	params.onText?.("Частичный ответ"); await flushPromises();
	if (action !== "stop-empty") {
		appendFragment(s, s.b, { line: 1, ch: 4 }, { line: 1, ch: 16 }, "Следующий вопрос @@");
		appendMention(s, " с @План");
	}
	const draft = s.input.getText();
	setLanguage("en"); await s.view.refreshLocale();
	expect(s.send.attributes["aria-label"]).toBe("Stop");
	expect(s.input.getText()).toBe(draft);
	if (action === "clear") s.root.find("ai-helper-clear-btn").click();
	else s.send.click();
	await flushPromises();
	expect(params.signal?.aborted).toBe(true);
	expect(s.input.getText()).toBe(draft);
	expect(s.send.attributes["aria-label"]).toBe("Send");
	const messages = s.root.find("ai-helper-messages");
	if (action === "clear") { expect(messages.getText()).toBe(""); expect(s.view.getMessages()).toEqual([]); }
	else {
		expect(messages.getText()).toContain("Частичный ответ");
		expect(messages.getText()).toContain("Stopped");
		expect(s.view.getMessages()).toHaveLength(2);
	}
	if (action === "stop-empty") s.type("Продолжи");
	const next = deferred<ServerClientResult<ChatCompletionResult>>();
	s.chat.mockImplementationOnce(() => next.promise);
	s.send.click(); await flushPromises();
	params.onText?.("Поздний текст");
	response.resolve({ ok: true, value: { content: "Поздний ответ" } }); await flushPromises();
	expect(messages.getText()).not.toContain("Поздний");
	expect(s.send.attributes["aria-label"]).toBe("Stop");
	const request = s.chat.mock.calls[2][2];
	expect(request.slice(0, -1)).toEqual(action === "clear" ? [] : [{ role: "user", content: successful }, { role: "assistant", content: "Ответ" }]);
	if (action !== "stop-empty") expect(attachments(request.at(-1)!.content).map(snapshot => snapshot.markdown)).toEqual(["второй выбор", "Лишнее: первый выбор. Хвост"]);
	next.resolve({ ok: true, value: { content: "Новый ответ" } }); await flushPromises();
	expect(s.view.getMessages()).toHaveLength(action === "clear" ? 2 : 4);
	expect(messages.getText()).toContain("Новый ответ");
	await s.view.onClose();
});

it("повтор точного выделения передаёт один снимок, сохраняя оба упоминания", async () => {
	const s = await setupEditors();
	appendFragment(s, s.a, { line: 0, ch: 8 }, { line: 0, ch: 20 }, "Сравни @@");
	appendFragment(s, s.a, { line: 0, ch: 8 }, { line: 0, ch: 20 });
	expect(s.input.getText()).toBe("Сравни План[1] План[1]");
	s.send.click(); await flushPromises();
	expect(attachments(s.chat.mock.calls[0][2][0].content)).toEqual([{
		title: "План", path: "Проекты/План.md", markdown: "первый выбор",
		range: { from: { line: 0, ch: 8 }, to: { line: 0, ch: 20 } },
	}]);
	await s.view.onClose();
});

it("сохраняет порядок смешанных вложений и различает прежний фрагмент и актуальную целую заметку", async () => {
	const s = await setupEditors();
	appendFragment(s, s.a, { line: 0, ch: 8 }, { line: 0, ch: 20 }, "Сравни @@");
	appendMention(s, " и @План");
	s.a.edit("Изменённая целая заметка");
	appendFragment(s, s.b, { line: 1, ch: 4 }, { line: 1, ch: 16 });
	expect(s.input.getText()).toBe("Сравни План[1] и @План Итоги[2]");
	s.send.click(); await flushPromises();
	expect(attachments(s.chat.mock.calls[0][2][0].content)).toEqual([
		{ title: "План", path: "Проекты/План.md", markdown: "первый выбор", range: { from: { line: 0, ch: 8 }, to: { line: 0, ch: 20 } } },
		{ title: "План", path: "Проекты/План.md", markdown: "Изменённая целая заметка" },
		{ title: "Итоги", path: "Итоги.md", markdown: "второй выбор", range: { from: { line: 1, ch: 4 }, to: { line: 1, ch: 16 } } },
	]);
	await s.view.onClose();
});

it("собирает точные фрагменты Плана и Итогов и использует прежние снимки в следующем вопросе", async () => {
	const s = await setupEditors();
	s.a.edit([...Array.from({ length: 11 }, () => "Лишняя строка"), "До: первый", "второй", "третий", "четвёртый", "пятый: хвост", "Лишний конец"].join("\n"));
	s.b.edit([...Array.from({ length: 7 }, () => "Лишняя строка"), "До: другой выбор. Хвост"].join("\n"));
	appendFragment(s, s.a, { line: 11, ch: 4 }, { line: 15, ch: 5 }, "Сравни эти предложения @@");
	appendFragment(s, s.b, { line: 7, ch: 4 }, { line: 7, ch: 16 }, " и @@");
	expect(s.input.getText()).toBe("Сравни эти предложения План[12-16] и Итоги[8]");
	s.a.edit("Изменённый План"); s.b.edit("Изменённые Итоги");
	s.send.click(); await flushPromises();
	const request = s.chat.mock.calls[0][2][0].content;
	expect(attachments(request)).toEqual([
		{ title: "План", path: "Проекты/План.md", markdown: "первый\nвторой\nтретий\nчетвёртый\nпятый", range: { from: { line: 11, ch: 4 }, to: { line: 15, ch: 5 } } },
		{ title: "Итоги", path: "Итоги.md", markdown: "другой выбор", range: { from: { line: 7, ch: 4 }, to: { line: 7, ch: 16 } } },
	]);
	s.type("Продолжи сравнение"); s.send.click(); await flushPromises();
	expect(s.chat.mock.calls[1][2]).toEqual([
		{ role: "user", content: request }, { role: "assistant", content: "Ответ" }, { role: "user", content: "Продолжи сравнение" },
	]);
	await s.view.onClose();
});

it.each([0, 1, 2])("удаление %i повторений фрагмента сохраняет остальные вложения смешанного черновика", async removed => {
	const s = await setupEditors();
	appendFragment(s, s.a, { line: 0, ch: 8 }, { line: 0, ch: 20 }, "Сравни @@");
	appendFragment(s, s.a, { line: 0, ch: 8 }, { line: 0, ch: 20 }, " и @@");
	appendMention(s, " с @Итоги");
	const repeated = s.input.children.filter(child => child.getText() === "План[1]");
	for (const chip of repeated.slice(0, removed)) chip.remove();
	s.input.dispatchEvent({ type: "input", inputType: "deleteContentBackward" } as any);
	s.send.click(); await flushPromises();
	const sent = attachments(s.chat.mock.calls[0][2][0].content);
	expect(sent.map(snapshot => snapshot.path)).toEqual(removed === 2 ? ["Итоги.md"] : ["Проекты/План.md", "Итоги.md"]);
	if (removed < 2) expect(sent[0].markdown).toBe("первый выбор");
	await s.view.onClose();
});

it("не объединяет пересечения, части одной строки, одинаковый текст разных диапазонов и заметок", async () => {
	const s = await setupEditors();
	s.a.edit("выбор выбор"); s.b.edit("выбор выбор");
	// Even the same basename and line labels cannot identify a snapshot.
	Object.assign(s.files[1], { path: "Архив/План.md", basename: "План" });
	appendFragment(s, s.a, { line: 0, ch: 0 }, { line: 0, ch: 5 }, "Сравни @@");
	appendFragment(s, s.a, { line: 0, ch: 6 }, { line: 0, ch: 11 });
	appendFragment(s, s.a, { line: 0, ch: 3 }, { line: 0, ch: 9 });
	appendFragment(s, s.b, { line: 0, ch: 0 }, { line: 0, ch: 5 });
	s.send.click(); await flushPromises();
	expect(attachments(s.chat.mock.calls[0][2][0].content)).toEqual([
		{ title: "План", path: "Проекты/План.md", markdown: "выбор", range: { from: { line: 0, ch: 0 }, to: { line: 0, ch: 5 } } },
		{ title: "План", path: "Проекты/План.md", markdown: "выбор", range: { from: { line: 0, ch: 6 }, to: { line: 0, ch: 11 } } },
		{ title: "План", path: "Проекты/План.md", markdown: "ор выб", range: { from: { line: 0, ch: 3 }, to: { line: 0, ch: 9 } } },
		{ title: "План", path: "Архив/План.md", markdown: "выбор", range: { from: { line: 0, ch: 0 }, to: { line: 0, ch: 5 } } },
	]);
	await s.view.onClose();
});

it("сохраняет разные версии одного диапазона и не дедуплицирует снимки между сообщениями", async () => {
	const s = await setupEditors();
	s.a.edit("Старый");
	appendFragment(s, s.a, { line: 0, ch: 0 }, { line: 0, ch: 6 }, "Сравни @@");
	s.a.edit("Новый!");
	appendFragment(s, s.a, { line: 0, ch: 0 }, { line: 0, ch: 6 });
	s.send.click(); await flushPromises();
	const first = s.chat.mock.calls[0][2][0].content;
	expect(attachments(first).map(snapshot => snapshot.markdown)).toEqual(["Старый", "Новый!"]);
	appendFragment(s, s.a, { line: 0, ch: 0 }, { line: 0, ch: 6 }, "Объясни @@");
	s.a.edit("Третий");
	s.send.click(); await flushPromises();
	expect(s.chat.mock.calls[1][2][0].content).toBe(first);
	expect(attachments(s.chat.mock.calls[1][2].at(-1)!.content).map(snapshot => snapshot.markdown)).toEqual(["Новый!"]);
	await s.view.onClose();
});

it("проверяет весь смешанный набор с историей и резервом ответа, восстанавливая черновик целиком", async () => {
	const s = await setupEditors();
	s.type("Первый вопрос"); s.send.click(); await flushPromises();
	Object.assign(s.view.plugin.settings, { contextWindow: "1000", maxTokens: "100", systemPrompt: "Обсуди заметки" });
	const count = vi.fn<Parameters<ServerClient["countPromptTokens"]>, ReturnType<ServerClient["countPromptTokens"]>>(async () => ({ tokens: 645, method: "lmstudio" }));
	s.view.plugin.serverClient.countPromptTokens = count;
	appendFragment(s, s.a, { line: 0, ch: 8 }, { line: 0, ch: 20 }, "Сравни @@");
	appendMention(s, " с @План");
	appendFragment(s, s.b, { line: 1, ch: 4 }, { line: 1, ch: 16 }, " и @@");
	const draft = s.input.getText();
	s.send.click(); await flushPromises();
	expect(s.chat).toHaveBeenCalledTimes(1);
	expect(s.input.getText()).toBe(draft);
	expect(s.root.getText()).toContain(t("mention-budget"));
	const counted = count.mock.calls[0][2];
	expect(counted.slice(0, 3)).toEqual([
		{ role: "system", content: "Обсуди заметки" }, { role: "user", content: "Первый вопрос" }, { role: "assistant", content: "Ответ" },
	]);
	expect(attachments(counted[3].content).map(snapshot => snapshot.markdown)).toEqual([
		"первый выбор", "Лишнее: первый выбор. Хвост", "второй выбор",
	]);
	// 644 + 100 reserved + 256 safety margin exactly fits the window.
	count.mockResolvedValue({ tokens: 644, method: "lmstudio" });
	s.send.click(); await flushPromises();
	expect(s.chat).toHaveBeenCalledTimes(2);
	expect(s.chat.mock.calls[1][2].at(-1)!.content).toBe(counted[3].content);
	expect(s.chat.mock.calls[1][3]?.maxTokens).toBe("100");
	await s.view.onClose();
});

it("ошибка чтения целой заметки блокирует весь набор и сохраняет точные фрагменты для повтора", async () => {
	const s = await setupEditors();
	appendFragment(s, s.a, { line: 0, ch: 8 }, { line: 0, ch: 20 }, "Сравни @@");
	appendMention(s, " с @Итоги");
	appendFragment(s, s.b, { line: 1, ch: 4 }, { line: 1, ch: 16 });
	const draft = s.input.getText();
	s.view.app.workspace.getLeavesOfType = () => [];
	s.read.mockRejectedValueOnce(new Error("Нет доступа"));
	s.send.click(); await flushPromises();
	expect(s.chat).not.toHaveBeenCalled();
	expect(s.input.getText()).toBe(draft);
	expect(s.root.getText()).toContain(t("mention-file-unavailable"));
	s.a.edit("Новый текст Плана"); s.b.edit("Новый текст Итогов");
	s.read.mockResolvedValue("Новая целая заметка");
	s.send.click(); await flushPromises();
	expect(attachments(s.chat.mock.calls[0][2][0].content).map(snapshot => snapshot.markdown)).toEqual([
		"первый выбор", "Новая целая заметка", "второй выбор",
	]);
	await s.view.onClose();
});

it("переименование смешанного вложения при подсчёте обновляет целую заметку, сохраняя происхождение фрагмента", async () => {
	const s = await setupEditors();
	const pending = deferred<{ tokens: number; method: "bytes" }>();
	const count = vi.fn<Parameters<ServerClient["countPromptTokens"]>, ReturnType<ServerClient["countPromptTokens"]>>(async () => ({ tokens: 100, method: "bytes" }));
	count.mockImplementationOnce(() => pending.promise);
	s.view.plugin.serverClient.countPromptTokens = count;
	appendFragment(s, s.a, { line: 0, ch: 8 }, { line: 0, ch: 20 }, "Сравни @@");
	appendMention(s, " с @План");
	s.send.click(); await flushPromises();
	s.rename(s.file, "Архив/Новый план.md"); s.a.edit("Актуальный текст");
	pending.resolve({ tokens: 100, method: "bytes" }); await flushPromises();
	expect(attachments(s.chat.mock.calls[0][2][0].content)).toEqual([
		{ title: "План", path: "Проекты/План.md", markdown: "первый выбор", range: { from: { line: 0, ch: 8 }, to: { line: 0, ch: 20 } } },
		{ title: "Новый план", path: "Архив/Новый план.md", markdown: "Актуальный текст" },
	]);
	expect(count.mock.calls.at(-1)![2].at(-1)!.content).toBe(s.chat.mock.calls[0][2][0].content);
	await s.view.onClose();
});

it.each(["ru", "en"] as const)("%s: редактирование, удаление, смена локали и копирование сохраняют смысл смешанного сообщения", async locale => {
	const s = await setupEditors();
	const writeText = vi.fn().mockResolvedValue(undefined);
	vi.stubGlobal("navigator", { clipboard: { writeText } });
	try {
		appendFragment(s, s.a, { line: 0, ch: 8 }, { line: 0, ch: 20 }, "Сравни @@");
		appendMention(s, " и @План");
		appendFragment(s, s.b, { line: 1, ch: 4 }, { line: 1, ch: 16 });
		s.input.children.find(child => child.getText() === "План[1]")!.remove();
		s.input.children[0].setText("Объясни ");
		s.input.dispatchEvent({ type: "input", inputType: "deleteContentBackward" } as any);
		setLanguage(locale); await s.view.refreshLocale();
		expect(s.input.getText()).toBe("Объясни  и @План Итоги[2]");
		s.send.click(); await flushPromises();
		expect(attachments(s.chat.mock.calls[0][2][0].content).map(snapshot => snapshot.markdown)).toEqual([
			"Лишнее: первый выбор. Хвост", "второй выбор",
		]);
		s.root.find("ai-helper-message-user").find("ai-helper-copy-message").click(); await flushPromises();
		expect(writeText).toHaveBeenCalledWith("Объясни  и @План Итоги[2]");
		s.type("Объясни  и @План Итоги[2]", "insertFromPaste"); s.send.click(); await flushPromises();
		expect(s.chat.mock.calls[1][2].at(-1)).toEqual({ role: "user", content: "Объясни  и @План Итоги[2]" });
		await s.view.onClose();
	} finally { vi.unstubAllGlobals(); }
});

it.each(["ru", "en"] as const)("%s: после А и Б без подходящего выделения не возвращает А, объясняет причину и сохраняет вопрос", async locale => {
	const s = await setupEditors(); setLanguage(locale);
	s.a.select([{ anchor: { line: 0, ch: 8 }, head: { line: 0, ch: 20 } }]);
	s.focus(s.a.view); s.focus(null);
	s.type("Объясни @@");
	expect(s.root.find("ai-helper-mention-suggest").getText()).toContain("первый выбор");
	for (const invalid of ["курсор", "пробелы", "чтение", "несмежные"]) {
		s.focus(s.b.view);
		s.b.mode(invalid === "чтение" ? "preview" : "source");
		s.b.edit(invalid === "пробелы" ? "  \t" : "Текст");
		const range = { anchor: { line: 0, ch: 0 }, head: { line: 0, ch: invalid === "курсор" ? 0 : 3 } };
		s.b.select(invalid === "несмежные" ? [range, range] : [range]);
		s.focus(null); s.type("Объясни @@");
		expect(s.root.find("ai-helper-mention-suggest").getText()).toBe(locale === "ru"
			? invalid === "несмежные" ? "Оставьте одно выделение в редакторе заметки." : "Выделите фрагмент в редакторе заметки."
			: invalid === "несмежные" ? "Leave only one selection in the note editor." : "Select a fragment in the note editor.");
		s.input.keydown("Enter"); await flushPromises();
		expect(s.chat).not.toHaveBeenCalled(); expect(s.input.getText()).toBe("Объясни @@");
		s.input.keydown("Escape"); expect(s.input.attributes["aria-expanded"]).toBe("false");
	}
	s.focus(s.b.view); s.b.mode("source"); s.b.edit("Исправленный выбор");
	s.b.select([{ anchor: { line: 0, ch: 0 }, head: { line: 0, ch: 18 } }]);
	s.focus(null); s.type("Объясни @@"); s.input.keydown("Enter");
	expect(s.input.getText()).toBe("Объясни Итоги[1]");
	s.send.click(); await flushPromises();
	expect(attachments(s.chat.mock.calls[0][2][0].content)[0]).toMatchObject({ path: "Итоги.md", markdown: "Исправленный выбор" });
	await s.view.onClose();
});

it.each([false, true])("переходы редакторов сохраняют точные границы и снимок при обратном выделении: %s", async reverse => {
	const s = await setupEditors();
	const from = { line: 1, ch: 4 }, to = { line: 2, ch: 0 };
	s.focus(s.b.view); s.b.select([{ anchor: reverse ? to : from, head: reverse ? from : to }]);
	s.focus(null); s.type("Объясни @@");
	expect(s.root.find("ai-helper-mention-suggest").getText()).toContain("Итоги[2] — второй выбор. Хвост");
	s.input.keydown("Tab");
	s.focus(s.a.view); s.a.select([{ anchor: { line: 0, ch: 8 }, head: { line: 0, ch: 20 } }]);
	s.b.edit("Заменённый оригинал"); s.focus(null);
	s.send.click(); await flushPromises();
	expect(attachments(s.chat.mock.calls[0][2][0].content)[0]).toEqual({
		title: "Итоги", path: "Итоги.md", markdown: "второй выбор. Хвост\n", range: { from, to },
	});
	await s.view.onClose();
});

it("возврат в редактор закрывает старое предложение; новое @@ использует новое выделение", async () => {
	const s = await setupEditors();
	s.a.select([{ anchor: { line: 0, ch: 8 }, head: { line: 0, ch: 20 } }]);
	s.focus(null); s.type("Объясни @@");
	s.focus(s.b.view);
	expect(s.input.attributes["aria-expanded"]).toBe("false");
	expect(s.input.getText()).toBe("Объясни @@");
	s.b.select([{ anchor: { line: 1, ch: 4 }, head: { line: 1, ch: 16 } }]);
	s.focus(null); s.type("Объясни @@"); s.input.keydown("Tab");
	s.send.click(); await flushPromises();
	expect(attachments(s.chat.mock.calls[0][2][0].content)[0]).toMatchObject({ path: "Итоги.md", markdown: "второй выбор" });
	await s.view.onClose();
});


it("обновление файлов не заменяет уже показанное предложение другим фрагментом", async () => {
	const s = await setup();
	let selected = "Первый выбор";
	Object.assign(s.editor.editor, {
		listSelections: () => [{ anchor: { line: 0, ch: 0 }, head: { line: 0, ch: 12 } }],
		getRange: () => selected,
	});
	s.type("Объясни @@"); selected = "Второй выбор";
	s.rename(s.file, "Архив/План.md");
	expect(s.input.attributes["aria-expanded"]).toBe("false");
	expect(s.input.getText()).toBe("Объясни @@");
	expect(s.chat).not.toHaveBeenCalled();
	s.type("Объясни @@"); s.input.keydown("Tab"); s.send.click(); await flushPromises();
	expect(attachments(s.chat.mock.calls[0][2][0].content)[0]).toMatchObject({ path: "Архив/План.md", markdown: "Второй выбор" });
	await s.view.onClose();
});


it("открывает точный снимок из черновика и истории без изменения запроса", async () => {
	const s = await setup();
	const markdown = "часть **строки** [[Ссылка]] ![[Фото.png]]\n  конец\n";
	Object.assign(s.editor.editor, {
		listSelections: () => [{ anchor: { line: 11, ch: 3 }, head: { line: 13, ch: 0 } }],
		getRange: () => markdown,
	});
	s.type("Объясни @@"); s.input.keydown("Tab");
	const draft = s.input.getText();
	s.edit("Новый текст оригинала");
	s.input.find("ai-helper-mention").click();
	let modal = Modal.opened.at(-1)!;
	expect(modal).toBeDefined();
	expect(modal.contentEl.find("ai-helper-fragment-text").getText()).toBe(markdown);
	expect(modal.contentEl.getText()).toContain("Проекты/План.md");
	expect(modal.contentEl.getText()).toContain("План[12-13]");
	expect(modal.contentEl.find("ai-helper-fragment-text").children).toHaveLength(0);
	modal.contentEl.find("ai-helper-fragment-close").click();
	expect(s.input.getText()).toBe(draft);
	expect(s.view.getMessages()).toHaveLength(0);
	s.send.click(); await flushPromises();
	const request = s.chat.mock.calls[0][2][0].content;
	expect(attachments(request)[0].markdown).toBe(markdown);
	s.root.find("ai-helper-messages").find("ai-helper-mention").click();
	modal = Modal.opened.at(-1)!;
	expect(modal.contentEl.find("ai-helper-fragment-text").getText()).toBe(markdown);
	modal.close();
	s.type("Продолжи"); s.send.click(); await flushPromises();
	expect(s.chat.mock.calls[1][2][0].content).toBe(request);
	await s.view.onClose();
});

it.each(["правки", "закрытие", "переименование", "удаление", "замена файла"])("сохраняет просмотр и отправку после события: %s", async scenario => {
	const s = await setup(["Проекты/План.md", "Архив/План.md"]);
	Object.assign(s.editor.editor, {
		listSelections: () => [{ anchor: { line: 3, ch: 2 }, head: { line: 3, ch: 8 } }],
		getRange: () => "Снимок",
	});
	const openFile = vi.fn(async (_file: TFile) => {});
	Object.assign(s.workspace, { getLeaf: () => ({ openFile }) });
	s.type("Объясни @@"); s.input.keydown("Tab");
	s.input.find("ai-helper-mention").click();
	let modal = Modal.opened.at(-1)!;
	expect(modal.contentEl.find("ai-helper-fragment-open").disabled).toBe(false);
	if (scenario === "правки") { s.edit("Изменённый оригинал"); s.emit("modify", s.file); }
	if (scenario === "закрытие") { s.workspace.getActiveViewOfType = () => null; s.workspace.getLeavesOfType = () => []; }
	if (scenario === "переименование") s.rename(s.file, "Архив/Новое имя.md");
	if (scenario === "удаление" || scenario === "замена файла") {
		s.files.splice(s.files.indexOf(s.file), 1); s.emit("delete", s.file);
		if (scenario === "замена файла") {
			s.files.push(Object.assign(new TFile(), { path: "Проекты/План.md", basename: "План", extension: "md" }));
			s.emit("create", s.files.at(-1));
		}
	}
	const unavailable = scenario === "удаление" || scenario === "замена файла";
	expect(modal.contentEl.find("ai-helper-fragment-open").disabled).toBe(unavailable);
	expect(modal.contentEl.getText()).toContain("Проекты/План.md");
	expect(modal.contentEl.getText()).toContain("План[4]");
	expect(modal.contentEl.find("ai-helper-fragment-text").getText()).toBe("Снимок");
	modal.contentEl.find("ai-helper-fragment-open").click(); await flushPromises();
	if (unavailable) { expect(openFile).not.toHaveBeenCalled(); modal.close(); }
	else expect(openFile.mock.calls[0][0]).toBe(s.file);
	s.send.click(); await flushPromises();
	expect(attachments(s.chat.mock.calls[0][2][0].content)).toEqual([{
		title: "План", path: "Проекты/План.md", markdown: "Снимок",
		range: { from: { line: 3, ch: 2 }, to: { line: 3, ch: 8 } },
	}]);
	s.root.find("ai-helper-messages").find("ai-helper-mention").click();
	modal = Modal.opened.at(-1)!;
	expect(modal.contentEl.find("ai-helper-fragment-text").getText()).toBe("Снимок");
	expect(modal.contentEl.find("ai-helper-fragment-open").disabled).toBe(unavailable);
	modal.contentEl.find("ai-helper-fragment-open").click(); await flushPromises();
	if (unavailable) expect(openFile).not.toHaveBeenCalled();
	else expect(openFile.mock.calls.at(-1)![0]).toBe(s.file);
	await s.view.onClose();
});

it.each(["Enter", " "])("открывает просмотр клавишей %s и переводит его без изменения снимка", async key => {
	const s = await setup();
	Object.assign(s.editor.editor, {
		listSelections: () => [{ anchor: { line: 0, ch: 2 }, head: { line: 0, ch: 9 } }],
		getRange: () => "**Текст**",
	});
	s.type("Объясни @@"); s.input.keydown("Tab");
	const chip = s.input.find("ai-helper-mention");
	expect(chip.attributes.role).toBe("button"); expect(chip.attributes.tabindex).toBe("0");
	const focus = vi.spyOn(chip, "focus");
	chip.keydown(key);
	const modal = Modal.opened.at(-1)!;
	expect(modal.titleEl.getText()).toBe("Сохранённый фрагмент");
	setLanguage("en"); await s.view.refreshLocale();
	expect(modal.titleEl.getText()).toBe("Saved fragment");
	expect(modal.contentEl.find("ai-helper-fragment-open").getText()).toBe("Open original note");
	expect(modal.contentEl.find("ai-helper-fragment-close").getText()).toBe("Close");
	expect(modal.contentEl.find("ai-helper-fragment-text").getText()).toBe("**Текст**");
	expect(s.input.getText()).toBe("Объясни План[1]");
	modal.contentEl.find("ai-helper-fragment-close").click();
	expect(focus).toHaveBeenCalled();
	expect(s.chat).not.toHaveBeenCalled();
	await s.view.onClose();
});

it("различает одноимённые заметки полным путём и сохраняет просмотр при ошибке перехода", async () => {
	const s = await setup(["Проекты/План.md", "Архив/План.md"]);
	Object.assign(s.editor.editor, {
		listSelections: () => [{ anchor: { line: 0, ch: 0 }, head: { line: 0, ch: 6 } }], getRange: () => "Первый",
	});
	s.type("Сравни @@"); s.input.keydown("Tab");
	const first = s.input.find("ai-helper-mention");
	first.click(); let modal = Modal.opened.at(-1)!;
	expect(modal.contentEl.find("ai-helper-fragment-path").getText()).toBe("Проекты/План.md");
	modal.close();
	s.editor.file = s.files[1];
	Object.assign(s.editor.editor, { getRange: () => "Второй" });
	appendMention(s, " и @@");
	const chips = s.input.children.filter(child => child.classes.has("ai-helper-mention"));
	chips[1].click(); modal = Modal.opened.at(-1)!;
	expect(modal.contentEl.find("ai-helper-fragment-path").getText()).toBe("Архив/План.md");
	Object.assign(s.workspace, { getLeaf: () => ({ openFile: async () => { throw new Error("Недоступен"); } }) });
	modal.contentEl.find("ai-helper-fragment-open").click(); await flushPromises();
	expect(modal.contentEl.getText()).toContain("Исходная заметка недоступна");
	expect(modal.contentEl.find("ai-helper-fragment-text").getText()).toBe("Второй");
	modal.close();
	s.send.click(); await flushPromises();
	expect(attachments(s.chat.mock.calls[0][2][0].content).map(snapshot => snapshot.markdown)).toEqual(["Первый", "Второй"]);
	await s.view.onClose();
});

it("сохраняет цель возврата фокуса при переводе истории", async () => {
	const s = await setup();
	Object.assign(s.editor.editor, {
		listSelections: () => [{ anchor: { line: 0, ch: 0 }, head: { line: 0, ch: 6 } }], getRange: () => "Снимок",
	});
	s.type("Объясни @@"); s.input.keydown("Tab"); s.send.click(); await flushPromises();
	const chip = s.root.find("ai-helper-messages").find("ai-helper-mention");
	chip.click();
	const modal = Modal.opened.at(-1)!;
	setLanguage("en"); await s.view.refreshLocale();
	expect(s.root.find("ai-helper-messages").find("ai-helper-mention")).toBe(chip);
	const focus = vi.spyOn(chip, "focus");
	modal.close(); expect(focus).toHaveBeenCalled();
	await s.view.onClose();
});

it.each(["click", "Enter", " "])("восстановленное браузером упоминание открывает снимок через %s", async action => {
	const s = await setup();
	Object.assign(s.editor.editor, {
		listSelections: () => [{ anchor: { line: 0, ch: 0 }, head: { line: 0, ch: 6 } }], getRange: () => "Снимок",
	});
	s.type("Объясни @@"); s.input.keydown("Tab");
	const chip = s.input.find("ai-helper-mention");
	const restored = s.input.createSpan({ cls: "ai-helper-mention", text: chip.getText(), attr: { ...chip.attributes } });
	chip.remove();
	const event = { type: action === "click" ? "click" : "keydown", key: action, target: restored, preventDefault() {}, stopPropagation() {} };
	// A browser-restored node carries attributes, but no direct event listeners.
	s.input.dispatchEvent(event);
	const modal = Modal.opened.at(-1)!;
	expect(modal).toBeDefined();
	expect(modal.contentEl.find("ai-helper-fragment-text").getText()).toBe("Снимок");
	expect(s.chat).not.toHaveBeenCalled();
	modal.close();
	await s.view.onClose();
});
