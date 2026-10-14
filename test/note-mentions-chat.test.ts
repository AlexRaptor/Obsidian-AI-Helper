import { afterEach, expect, it, vi } from "vitest";
import { MarkdownView, TFile, type WorkspaceLeaf } from "obsidian";
import { ChatView } from "../src/chat-view";
import type { AiHelperPlugin } from "../src/main";
import type { ServerClient, ServerClientResult, ChatCompletionResult } from "../src/server-client";
import { DEFAULT_SETTINGS } from "../src/settings";
import { setLanguage, t } from "../src/i18n";
import { Notice, TestElement, flushPromises } from "./helpers/obsidian";

vi.mock("obsidian", async () => import("./helpers/obsidian"));
afterEach(() => { vi.restoreAllMocks(); });

async function setup() {
	setLanguage("ru");
	Notice.messages = [];
	const file = Object.assign(new TFile(), { path: "Проекты/План.md", basename: "План", extension: "md" });
	let markdown = "---\nстатус: готов\n---\n# План\nПервоначальная метка\n[[Секрет]]\n![[Вложение]]";
	const editor = Object.assign(new MarkdownView({} as WorkspaceLeaf), { file, getMode: (): "source" | "preview" => "source", editor: { getValue: () => markdown } });
	const workspace = { getActiveViewOfType: () => editor, getLeavesOfType: () => [{ view: editor }] };
	const read = vi.fn(async () => markdown);
	const chat = vi.fn<Parameters<ServerClient["chat"]>, ReturnType<ServerClient["chat"]>>(async () => ({ ok: true as const, value: { content: "Ответ" } }));
	const plugin = { settings: { ...DEFAULT_SETTINGS, serverUrl: "http://s", model: "модель", contextWindow: "20000" }, serverClient: { chat }, t } as unknown as AiHelperPlugin;
	const view = new ChatView({} as WorkspaceLeaf, plugin);
	view.app = { workspace, vault: { getFileByPath: () => file, read } } as any;
	await view.onOpen();
	const root = view.contentEl as unknown as TestElement;
	const input = root.find("ai-helper-input");
	const send = root.find("ai-helper-send");
	const type = (text: string, inputType = "insertText") => { input.value = text; input.dispatchEvent({ type: "input", inputType, data: text.slice(-1) } as any); };
	const mention = () => { type("@"); input.keydown("Tab"); };
	return { view, root, input, send, chat, file, workspace, read, type, mention, edit: (text: string) => { markdown = text; } };
}

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
	const original = s.workspace.getActiveViewOfType();
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
	const plain = await setup();
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
