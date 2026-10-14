import { afterEach, expect, it, vi } from "vitest";
import { MarkdownView, TFile, type WorkspaceLeaf } from "obsidian";
import { ChatView } from "../src/chat-view";
import type { AiHelperPlugin } from "../src/main";
import type { ServerClient, ServerClientResult, ChatCompletionResult } from "../src/server-client";
import { DEFAULT_SETTINGS } from "../src/settings";
import { setLanguage, t } from "../src/i18n";
import { Notice, TestElement, deferred, flushPromises } from "./helpers/obsidian";

vi.mock("obsidian", async () => import("./helpers/obsidian"));
afterEach(() => { vi.restoreAllMocks(); });

async function setup(paths?: string[], hasCurrent = true) {
	setLanguage("ru");
	Notice.messages = [];
	const file = Object.assign(new TFile(), { path: "Проекты/План.md", basename: "План", extension: "md" });
	let markdown = "---\nстатус: готов\n---\n# План\nПервоначальная метка\n[[Секрет]]\n![[Вложение]]";
	const editor = Object.assign(new MarkdownView({} as WorkspaceLeaf), { file, getMode: (): "source" | "preview" => "source", editor: { getValue: () => markdown } });
	const files = paths ? paths.map(path => Object.assign(new TFile(), { path, basename: path.split("/").pop()!.slice(0, -3), extension: "md" })) : [file];
	const workspace = { getActiveViewOfType: (): MarkdownView | null => hasCurrent ? editor : null, getLeavesOfType: (): { view: MarkdownView }[] => [{ view: editor }] };
	const read = vi.fn(async (_file: TFile) => markdown);
	const chat = vi.fn<Parameters<ServerClient["chat"]>, ReturnType<ServerClient["chat"]>>(async () => ({ ok: true as const, value: { content: "Ответ" } }));
	const plugin = { settings: { ...DEFAULT_SETTINGS, serverUrl: "http://s", model: "модель", contextWindow: "20000" }, serverClient: { chat }, t } as unknown as AiHelperPlugin;
	const view = new ChatView({} as WorkspaceLeaf, plugin);
	view.app = { workspace, vault: { getMarkdownFiles: () => files, getFileByPath: (path: string) => files.find(candidate => candidate.path === path) ?? null, read } } as any;
	await view.onOpen();
	const root = view.contentEl as unknown as TestElement;
	const input = root.find("ai-helper-input");
	const send = root.find("ai-helper-send");
	const type = (text: string, inputType = "insertText") => { input.value = text; input.dispatchEvent({ type: "input", inputType, data: text.slice(-1) } as any); };
	const mention = () => { type("@"); input.keydown("Tab"); };
	return { view, root, input, send, chat, file, workspace, read, type, mention, edit: (text: string) => { markdown = text; } };
}

// Append through the field so choosing another note preserves earlier elements.
function appendMention(s: Awaited<ReturnType<typeof setup>>, text: string): void {
	s.input.createSpan({ text });
	s.input.dispatchEvent({ type: "input", inputType: "insertText" } as any);
	s.input.keydown("Tab");
}

function attachments(content: string) {
	return JSON.parse(content.split("\n\nNote attachments (context data):\n")[1]) as { title: string; path: string; markdown: string }[];
}

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

it.each(["unknown", "budget", "unavailable", "search"])("блокирует %s и сохраняет весь черновик", async reason => {
	const s = await setup(); s.mention(); s.input.createSpan({ text: " Объясни" });
	if (reason === "unknown") s.view.plugin.settings.contextWindow = "";
	if (reason === "budget") s.view.plugin.settings.contextWindow = "100";
	if (reason === "unavailable") s.view.app.vault.getFileByPath = () => null;
	if (reason === "search") s.view.toggleSearch();
	s.send.click(); await flushPromises();
	expect(s.chat).not.toHaveBeenCalled();
	const key = reason === "unknown" ? "mention-window-unknown" : reason === "budget" ? "mention-budget" : reason === "unavailable" ? "mention-file-unavailable" : "mention-search-unavailable";
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
