import { afterEach, expect, it, vi } from "vitest";
import { type App, type PluginManifest, type WorkspaceLeaf, TFile, MarkdownView, FileSystemAdapter } from "obsidian";
import { IDBFactory } from "fake-indexeddb";
import { ChatView } from "../src/chat-view";
import { AiHelperPlugin } from "../src/main";
import { DEFAULT_SETTINGS } from "../src/settings";
import { Modal, Notice, deferred, type TestElement } from "./helpers/obsidian";
vi.mock("obsidian", async () => import("./helpers/obsidian"));
const plugins: AiHelperPlugin[] = [];
afterEach(() => { plugins.forEach(plugin => plugin.onunload()); plugins.length = 0; Modal.opened.slice().forEach(modal => modal.close()); Notice.messages.length = 0; vi.unstubAllGlobals(); vi.restoreAllMocks(); });
async function setup(options: { text?: string; settings?: Record<string, unknown>; embedding?: (body: any, signal?: AbortSignal | null) => Promise<Response>; completion?: (body: any, signal?: AbortSignal | null) => Promise<Response> } = {}) {
	if (options.embedding) vi.stubGlobal("indexedDB", new IDBFactory());
	const file = Object.assign(new TFile(), { path: "Заметки/Статья.md", basename: "Статья", extension: "md" });
	const files = new Map<string, string>([[file.path, "Сохранённый текст."]]);
	const view = Object.assign(Object.create(MarkdownView.prototype), { file, getMode: () => "source", editor: { getValue: () => options.text ?? "Видимый текст.\n\nВторой абзац." } });
	const opened: unknown[] = [];
	const leaf = { view, openFile: vi.fn(async (...args: unknown[]) => { opened.push(args); }) };
	const right = { openFile: vi.fn(async (...args: unknown[]) => { opened.push(args); }) };
	const commands = new Map<string, () => void>();
	const events = new Map<string, (...args: any[]) => void>();
	const requests: any[] = [];
	const network = vi.fn(async (url: string, init?: RequestInit) => {
		if (url.endsWith("/embeddings") && options.embedding) return options.embedding(JSON.parse(String(init?.body)), init?.signal);
		if (!url.endsWith("/chat/completions")) return new Response(JSON.stringify({ data: [] }));
		const body = JSON.parse(String(init?.body)); requests.push(body);
		if (options.completion) return options.completion(body, init?.signal);
		return new Response(JSON.stringify({ choices: [{ message: { content: JSON.stringify({ units: [{ id: "p1", text: "Visible text." }, { id: "p2", text: "Second paragraph." }] }) }, finish_reason: "stop" }] }));
	});
	vi.stubGlobal("fetch", network);
	const adapter = new FileSystemAdapter(); adapter.getBasePath = () => "/тест-перевода";
	const folders = new Set<string>(["Заметки"]);
	const app = { vault: { adapter, offref: () => {}, on: () => ({}), getFiles: () => [...files.keys()].map(path => Object.assign(new TFile(), { path })), createFolder: vi.fn(async (path: string) => { folders.add(path); }), getMarkdownFiles: () => [...files.keys()].map(path => Object.assign(new TFile(), { path, extension: "md" })), getFileByPath: (path: string) => files.has(path) ? path === file.path ? file : Object.assign(new TFile(), { path, extension: "md" }) : null,
		getAbstractFileByPath: (path: string) => files.has(path) ? file : folders.has(path) ? { path, children: [] } : null, read: vi.fn(async (note: TFile) => files.get(note.path)!),
		create: vi.fn(async (path: string, text: string) => { if (files.has(path)) throw Error("Занято"); files.set(path, text); return Object.assign(new TFile(), { path, extension: "md" }); }) },
		metadataCache: { getFileCache: () => null, getFirstLinkpathDest: () => null },
		workspace: { activeLeaf: leaf, getActiveViewOfType: (type: unknown) => type === MarkdownView ? view : null, getActiveFile: () => file, getLeavesOfType: (type: string) => type === "markdown" ? [leaf] : [],
			on: (name: string, callback: (...args: any[]) => void) => { events.set(name, callback); return {}; }, onLayoutReady: () => {}, detachLeavesOfType: () => {},
			createLeafBySplit: vi.fn(() => right), getLeaf: () => right, setActiveLeaf: vi.fn() } } as unknown as App;
	const plugin = new AiHelperPlugin(app, { id: "obsidian-ai-helper" } as PluginManifest); plugins.push(plugin);
	vi.spyOn(plugin, "loadData").mockResolvedValue({ ...DEFAULT_SETTINGS, serverUrl: "http://server/v1", model: "model", contextWindow: "32000", language: "ru", translationLanguage: "English", translationSuffix: " — en", systemPrompt: "СЕКРЕТ ЧАТА", ...options.settings });
	vi.spyOn(plugin, "addCommand").mockImplementation((command: any) => { commands.set(command.id, command.callback); return command; });
	const registerView = vi.spyOn(plugin, "registerView");
	await plugin.onload();
	const openChat = async () => {
		const factory = registerView.mock.calls.find(([type]) => type === "ai-helper-chat")![1];
		const chat = factory({} as WorkspaceLeaf) as ChatView; await chat.onOpen();
		return { chat, root: chat.contentEl as unknown as TestElement };
	};
	return { plugin, app, file, files, view, leaf, right, opened, commands, events, network, requests, openChat };
}
it("команда переводит видимые абзацы и открывает отдельную заметку рядом", async () => {
	const env = await setup();
	expect(env.commands.has("translate-current-note")).toBe(true);
	env.commands.get("translate-current-note")!();
	await vi.waitFor(() => expect(env.files.has("Заметки/Статья — en.md")).toBe(true));
	expect(env.files.get("Заметки/Статья — en.md")).toBe("[Оригинал](<./Статья.md>)\n\nVisible text.\n\nSecond paragraph.");
	expect(env.files.get(env.file.path)).toBe("Сохранённый текст.");
	expect(JSON.stringify(env.requests)).not.toContain("СЕКРЕТ ЧАТА");
	expect(JSON.stringify(env.requests)).toContain("Видимый текст.");
	expect(env.opened).toHaveLength(2);
	expect(env.leaf.openFile).toHaveBeenCalledWith(env.file, expect.objectContaining({ state: { mode: "preview" } }));
});

function button(text: string): TestElement {
	const find = (element: TestElement): TestElement | undefined => element.tagName === "BUTTON" && element.text === text ? element : element.children.map(find).find(Boolean);
	const found = Modal.opened.map(modal => find(modal.contentEl)).find(Boolean);
	if (!found) throw Error(`Нет кнопки ${text}`);
	return found;
}
function response(units: unknown, reason?: string): Response {
	return new Response(JSON.stringify({ choices: [{ message: { content: JSON.stringify({ units }) }, finish_reason: reason }] }));
}
it("меню открытой заметки использует её редактор даже при другой активной заметке", async () => {
	const env = await setup();
	const other = Object.assign(new TFile(), { path: "Другая.md", extension: "md" });
	Object.assign(env.app.workspace, { getActiveViewOfType: () => null, getActiveFile: () => other });
	const actions = new Map<string, () => void>();
	env.events.get("file-menu")!({ addItem: (render: (item: any) => void) => {
		let title = ""; const item = { setTitle: (value: string) => { title = value; return item; }, setIcon: () => item, onClick: (action: () => void) => { actions.set(title, action); return item; } }; render(item);
	} }, env.file);
	actions.get("Перевести текущую заметку")!();
	await vi.waitFor(() => expect(env.opened).toHaveLength(2));
	expect(JSON.stringify(env.requests)).toContain("Видимый текст.");
	expect(env.app.vault.read).not.toHaveBeenCalled();
});
it("снимок закрытой заметки сохраняет имя, текст и настройки после переименования и удаления", async () => {
	const reading = deferred<string>();
	const env = await setup({ completion: async () => response([{ id: "p1", text: "Saved text." }], "stop") });
	Object.assign(env.app.workspace, { getLeavesOfType: () => [], getActiveViewOfType: () => null });
	vi.mocked(env.app.vault.read).mockReturnValueOnce(reading.promise);
	env.commands.get("translate-current-note")!();
	env.files.delete(env.file.path); env.file.path = "Переименовано.md";
	env.plugin.settings.translationSuffix = " — другой"; env.plugin.settings.translationLanguage = "Deutsch"; env.plugin.settings.model = "другая";
	reading.resolve("Сохранённый текст.");
	await vi.waitFor(() => expect(env.files.has("Заметки/Статья — en.md")).toBe(true));
	expect(env.requests[0].model).toBe("model");
	expect(JSON.stringify(env.requests[0])).toContain("English");
	expect(env.files.get("Заметки/Статья — en.md")).toContain("Статья.md");
});
it("скрытие окна и повторная команда из другой заметки не запускают второй запрос", async () => {
	const pending = deferred<Response>(); const env = await setup({ completion: () => pending.promise });
	env.commands.get("translate-current-note")!();
	await vi.waitFor(() => expect(env.requests).toHaveLength(1));
	button("Скрыть").click();
	env.file.path = "Другая.md";
	env.commands.get("translate-current-note")!();
	expect(Modal.opened).toHaveLength(1); expect(env.requests).toHaveLength(1);
	pending.resolve(response([{ id: "p2", text: "Second paragraph." }, { id: "p1", text: "Visible text." }], "stop"));
	await vi.waitFor(() => expect(env.files.has("Заметки/Статья — en.md")).toBe(true));
	expect(env.files.get("Заметки/Статья — en.md")).toContain("Visible text.\n\nSecond paragraph.");
});
it.each(["stop", "unload"])("%s отменяет запрос и игнорирует поздний ответ", async action => {
	const pending = deferred<Response>(); let signal: AbortSignal | null | undefined;
	const env = await setup({ completion: (_body, requestSignal) => { signal = requestSignal; return pending.promise; } });
	env.commands.get("translate-current-note")!();
	await vi.waitFor(() => expect(env.requests).toHaveLength(1));
	if (action === "stop") button("Остановить").click(); else env.plugin.onunload();
	expect(signal?.aborted).toBe(true);
	pending.resolve(response([{ id: "p1", text: "Visible text." }, { id: "p2", text: "Second paragraph." }], "stop"));
	await new Promise(resolve => setTimeout(resolve, 10));
	expect(env.app.vault.create).not.toHaveBeenCalled();
});
it.each(["length", "content_filter", "tool_calls", "unknown"])("не сохраняет ответ с причиной %s", async reason => {
	const env = await setup({ completion: async () => response([{ id: "p1", text: "One" }, { id: "p2", text: "Two" }], reason) });
	env.commands.get("translate-current-note")!();
	await vi.waitFor(() => expect(button("Завершить")).toBeDefined());
	expect(env.app.vault.create).not.toHaveBeenCalled();
	expect(Modal.opened[0].contentEl.getText()).toContain("Ответ модели обрезан");
});
it.each([
	[{ id: "p1", text: "Один" }],
	[{ id: "p1", text: "Один" }, { id: "p1", text: "Два" }],
	[{ id: "p1", text: "Один" }, { id: "чужой", text: "Два" }],
	[{ id: "p1", text: "Один" }, { id: "p2", text: " " }],
])("не сохраняет неверный набор единиц: %j", async (...units) => {
	const env = await setup({ completion: async () => response(units, "stop") });
	env.commands.get("translate-current-note")!();
	await vi.waitFor(() => expect(button("Завершить")).toBeDefined());
	expect(env.app.vault.create).not.toHaveBeenCalled();
});
it.each(["<div>Текст</div>"])("отклоняет неподдерживаемую разметку до запроса: %s", async text => {
	const env = await setup({ text }); env.commands.get("translate-current-note")!();
	await vi.waitFor(() => expect(button("Завершить")).toBeDefined());
	expect(env.requests).toHaveLength(0); expect(env.app.vault.create).not.toHaveBeenCalled();
	expect(Modal.opened[0].contentEl.getText()).toContain("неподдерживаемая");
});
it("показывает сообщение без Markdown-заметки", async () => {
	const env = await setup(); Object.assign(env.app.workspace, { getActiveFile: () => null });
	env.commands.get("translate-current-note")!();
	expect(Notice.messages.at(-1)).toContain("Выберите Markdown"); expect(env.requests).toHaveLength(0);
});
it("не перезаписывает занятый путь", async () => {
	const env = await setup(); env.files.set("Заметки/Статья — en.md", "Существующая заметка");
	env.commands.get("translate-current-note")!();
	await vi.waitFor(() => expect(button("Завершить")).toBeDefined());
	expect(env.files.get("Заметки/Статья — en.md")).toBe("Существующая заметка");
	expect(Modal.opened[0].contentEl.getText()).toContain("Путь результата занят");
});
it.each([{ maxTokens: "1" }, { contextWindow: "512" }])("отклоняет превышение бюджета %j", async settings => {
	const env = await setup({ settings }); env.commands.get("translate-current-note")!();
	await vi.waitFor(() => expect(button("Завершить")).toBeDefined());
	expect(env.requests).toHaveLength(0); expect(env.app.vault.create).not.toHaveBeenCalled();
	expect(Modal.opened[0].contentEl.getText()).toContain("бюджет запроса");
});

it("чат сохраняет черновик и не отправляет второй запрос во время перевода", async () => {
	const pending = deferred<Response>(); const env = await setup({ completion: () => pending.promise });
	const chat = new ChatView({} as WorkspaceLeaf, env.plugin); Object.assign(chat, { app: env.app }); await chat.onOpen();
	try {
		env.commands.get("translate-current-note")!(); await vi.waitFor(() => expect(env.requests).toHaveLength(1));
		const root = chat.contentEl as unknown as TestElement;
		root.find("ai-helper-input").value = "Вопрос после перевода"; root.find("ai-helper-send").click();
		await new Promise(resolve => setTimeout(resolve, 10));
		expect(env.requests).toHaveLength(1); expect(chat.getMessages()).toHaveLength(0);
		expect(root.find("ai-helper-input").value).toBe("Вопрос после перевода");
	} finally { await chat.onClose(); }
});

it.each(["Текст с ==выделением==", "Текст %%скрытый комментарий%%", ":::блок\nСодержимое\n:::"])("не переводит неподдерживаемый синтаксис Obsidian: %s", async text => {
	const env = await setup({ text }); env.commands.get("translate-current-note")!();
	await vi.waitFor(() => expect(button("Завершить")).toBeDefined());
	expect(env.requests).toHaveLength(0);
});
it("учитывает явно заданный большой резерв ответа в бюджете", async () => {
	const env = await setup({ settings: { maxTokens: "32000" } }); env.commands.get("translate-current-note")!();
	await vi.waitFor(() => expect(button("Завершить")).toBeDefined());
	expect(env.requests).toHaveLength(0);
});
it.each(["json", "sse", "fallback"])("принимает полный ответ без причины завершения: %s", async transport => {
	let attempts = 0;
	const env = await setup({ completion: async () => {
		if (transport === "fallback" && attempts++ === 0) return new Response(JSON.stringify({ error: { message: "streaming is not supported" } }), { status: 400 });
		const content = JSON.stringify({ units: [{ id: "p1", text: "Visible text." }, { id: "p2", text: "Second paragraph." }] });
		return transport === "sse" ? new Response(`data: ${JSON.stringify({ choices: [{ delta: { content } }] })}\n\ndata: [DONE]\n\n`, { headers: { "content-type": "text/event-stream" } }) : response(JSON.parse(content).units);
	} });
	env.commands.get("translate-current-note")!(); await vi.waitFor(() => expect(env.files.has("Заметки/Статья — en.md")).toBe(true));
	if (transport === "fallback") { expect(env.requests).toHaveLength(2); expect(env.requests[1].stream).toBe(false); }
});
it.each(["обрыв", "неверный JSON", "ошибка модели"])("не сохраняет результат после ошибки: %s", async failure => {
	const env = await setup({ completion: async () => {
		if (failure === "обрыв") return new Response('data: {"choices":[{"delta":{"content":"часть"}}]}\n\n', { headers: { "content-type": "text/event-stream" } });
		if (failure === "ошибка модели") return new Response("Недоступно", { status: 503 });
		return new Response(JSON.stringify({ choices: [{ message: { content: "Не JSON" }, finish_reason: "stop" }] }));
	} });
	env.commands.get("translate-current-note")!(); await vi.waitFor(() => expect(button("Завершить")).toBeDefined());
	expect(env.app.vault.create).not.toHaveBeenCalled();
});
it("открывает только перевод при отключённом открытии рядом", async () => {
	const env = await setup({ settings: { translationOpenSideBySide: false } }); env.commands.get("translate-current-note")!();
	await vi.waitFor(() => expect(env.opened).toHaveLength(1));
	expect(env.app.workspace.createLeafBySplit).not.toHaveBeenCalled();
	expect(env.leaf.openFile).toHaveBeenCalledWith(expect.objectContaining({ path: "Заметки/Статья — en.md" }), expect.objectContaining({ state: { mode: "preview" }, active: true }));
});

it("после отмены чтения закрытой заметки сразу разрешает новую операцию", async () => {
	const reading = deferred<string>();
	const env = await setup();
	Object.assign(env.app.workspace, { getLeavesOfType: () => [], getActiveViewOfType: () => null });
	vi.mocked(env.app.vault.read).mockReturnValueOnce(reading.promise);
	env.commands.get("translate-current-note")!();
	button("Остановить").click();
	Object.assign(env.app.workspace, { getActiveViewOfType: (type: unknown) => type === MarkdownView ? env.view : null });
	env.commands.get("translate-current-note")!();
	await vi.waitFor(() => expect(env.files.has("Заметки/Статья — en.md")).toBe(true));
	reading.resolve("Поздно прочитанный текст.");
	expect(env.requests).toHaveLength(1);
});
it("не предлагает отмену уже начатой записи и сообщает путь сохранённого файла", async () => {
	const writing = deferred<void>();
	const env = await setup();
	vi.mocked(env.app.vault.create).mockImplementation(async (path, text) => {
		await writing.promise; env.files.set(path, text); return Object.assign(new TFile(), { path, extension: "md" });
	});
	env.commands.get("translate-current-note")!();
	await vi.waitFor(() => expect(env.app.vault.create).toHaveBeenCalled());
	expect(button("Остановить").disabled).toBe(true);
	button("Остановить").click();
	writing.resolve();
	await vi.waitFor(() => expect(Modal.opened[0].contentEl.getText()).toContain("Перевод сохранён"));
	expect(Modal.opened[0].contentEl.getText()).toContain("Заметки/Статья — en.md");
});

it("режим отладки позволяет скопировать отклонённый ответ модели из окна перевода", async () => {
	const raw = '{"units":[{"id":"чужой","text":"Перевод"}]}';
	const writeText = vi.fn(async (_text: string) => {});
	vi.stubGlobal("navigator", { clipboard: { writeText } });
	const env = await setup({ settings: { translationDebugMode: true }, completion: async () => new Response(JSON.stringify({ choices: [{ message: { content: raw }, finish_reason: "stop" }] })) });
	const actions = new Map<string, () => void>();
	env.events.get("file-menu")!({ addItem: (render: (item: any) => void) => {
		let title = ""; const item = { setTitle: (value: string) => { title = value; return item; }, setIcon: () => item, onClick: (action: () => void) => { actions.set(title, action); return item; } }; render(item);
	} }, env.file);
	actions.get("Перевести текущую заметку")!();
	await vi.waitFor(() => expect(button("Завершить")).toBeDefined());
	expect(Modal.opened[0].contentEl.getText()).toContain("неправильный или неполный");
	button("Копировать ответ модели").click();
	await vi.waitFor(() => expect(writeText).toHaveBeenCalledWith(raw));
	expect(env.app.vault.create).not.toHaveBeenCalled();
});
it("по умолчанию ответ не сохраняется для отладки", async () => {
	const env = await setup({ completion: async () => response([{ id: "чужой", text: "Ответ" }], "stop") });
	env.commands.get("translate-current-note")!();
	await vi.waitFor(() => expect(button("Завершить")).toBeDefined());
	expect(() => button("Копировать ответ модели")).toThrow();
	env.plugin.settings.translationDebugMode = true;
	env.commands.get("translate-current-note")!();
	expect(button("Копировать ответ модели").disabled).toBe(true);
});
it("ответ отладки остаётся после скрытия окна и очищается после завершения операции", async () => {
	const pending = deferred<Response>();
	const env = await setup({ settings: { translationDebugMode: true }, completion: () => pending.promise });
	env.commands.get("translate-current-note")!();
	expect(button("Копировать ответ модели").disabled).toBe(true);
	pending.resolve(response([{ id: "чужой", text: "Ответ" }], "stop"));
	await vi.waitFor(() => expect(button("Завершить")).toBeDefined());
	button("Скрыть").click(); env.commands.get("translate-current-note")!();
	expect(button("Копировать ответ модели").disabled).toBe(false);
	button("Завершить").click();
	env.commands.get("translate-current-note")!();
	expect(button("Копировать ответ модели").disabled).toBe(true);
});
it("копирует принятый текст оборванного SSE-ответа для отладки", async () => {
	const raw = '{"units":[{"id":"p1","text":"Часть';
	const writeText = vi.fn(async (_text: string) => {});
	vi.stubGlobal("navigator", { clipboard: { writeText } });
	const env = await setup({ settings: { translationDebugMode: true }, completion: async () => new Response(`data: ${JSON.stringify({ choices: [{ delta: { content: raw } }] })}\n\n`, { headers: { "content-type": "text/event-stream" } }) });
	env.commands.get("translate-current-note")!();
	await vi.waitFor(() => expect(button("Завершить")).toBeDefined());
	button("Копировать ответ модели").click();
	await vi.waitFor(() => expect(writeText).toHaveBeenCalledWith(raw));
	expect(env.app.vault.create).not.toHaveBeenCalled();
});
it("сообщает об ошибке буфера обмена и сохраняет возможность повторить копирование", async () => {
	const writeText = vi.fn().mockRejectedValueOnce(new Error("Буфер недоступен")).mockResolvedValueOnce(undefined);
	vi.stubGlobal("navigator", { clipboard: { writeText } });
	const env = await setup({ settings: { translationDebugMode: true }, completion: async () => response([{ id: "чужой", text: "Ответ" }], "stop") });
	env.commands.get("translate-current-note")!();
	await vi.waitFor(() => expect(button("Завершить")).toBeDefined());
	button("Копировать ответ модели").click();
	await vi.waitFor(() => expect(Notice.messages.at(-1)).toBe("Не удалось скопировать ответ модели."));
	button("Копировать ответ модели").click();
	await vi.waitFor(() => expect(Notice.messages.at(-1)).toBe("Ответ модели скопирован"));
});

it.each([false, true])("принимает ответ из отчёта пользователя, Markdown-обрамление: %s", async wrapped => {
	const raw = String.raw`{"units":[{"id":"p1","text":"Хорошие заметки сохраняют контекст. Полезный перевод сохраняет смысл оригинала."},{"id":"p2","text":"Этот абзац уже написан на русском языке и должен остаться без изменений.\n"}]}`;
	const content = wrapped ? "```json\n" + raw + "\n```" : raw;
	const env = await setup({ text: "Good notes preserve context. A useful translation preserves the meaning of the original.\n\nЭтот абзац уже написан на русском языке и должен остаться без изменений.\n", settings: { translationLanguage: "Русский" }, completion: async () => new Response(JSON.stringify({ choices: [{ message: { content }, finish_reason: "stop" }] })) });
	const actions = new Map<string, () => void>();
	env.events.get("file-menu")!({ addItem: (render: (item: any) => void) => {
		let title = ""; const item = { setTitle: (value: string) => { title = value; return item; }, setIcon: () => item, onClick: (action: () => void) => { actions.set(title, action); return item; } }; render(item);
	} }, env.file);
	actions.get("Перевести текущую заметку")!();
	await vi.waitFor(() => expect(button("Завершить")).toBeDefined());
	expect(Modal.opened[0].contentEl.getText()).not.toContain("неправильный или неполный");
	expect(env.files.get("Заметки/Статья — en.md")).toBe("[Оригинал](<./Статья.md>)\n\nХорошие заметки сохраняют контекст. Полезный перевод сохраняет смысл оригинала.\n\nЭтот абзац уже написан на русском языке и должен остаться без изменений.\n");
});
it.each([
	'Пояснение перед ответом\n```json\n{"units":[{"id":"p1","text":"Первый"},{"id":"p2","text":"Второй"}]}\n```',
	'```json\n{"units":[{"id":"p1","text":"Первый"},{"id":"p2","text":"Второй"}]}',
	'```json\n{"units":[{"id":"p1","text":"Первый"}]}\n```',
	'```json\n{"units":[{"id":"p1","text":"Первый"},{"id":"p1","text":"Повтор"}]}\n```',
	'```json\n{"units":[{"id":"p1","text":"Первый"},{"id":"p2","text":"Второй"}]}\n```\n```json\n{}\n```',
])("обрамление не позволяет принять неоднозначный или неполный ответ: %s", async content => {
	const env = await setup({ completion: async () => new Response(JSON.stringify({ choices: [{ message: { content }, finish_reason: "stop" }] })) });
	env.commands.get("translate-current-note")!();
	await vi.waitFor(() => expect(button("Завершить")).toBeDefined());
	expect(Modal.opened[0].contentEl.getText()).toContain("неправильный или неполный");
	expect(env.app.vault.create).not.toHaveBeenCalled();
});

it("после ошибки освобождает чат, а повтор при занятом чате не ставит перевод в очередь", async () => {
	const pending = deferred<Response>();
	let attempts = 0;
	const env = await setup({ completion: async body => {
		if (!body.messages[0].content.includes("Translate every")) return pending.promise;
		attempts++;
		return attempts === 1 ? new Response("{}", { status: 503 }) : response([{ id: "p1", text: "Первый перевод." }, { id: "p2", text: "Второй перевод." }], "stop");
	} });
	const { chat, root } = await env.openChat();
	try {
		env.commands.get("translate-current-note")!();
		await vi.waitFor(() => expect(button("Повторить").disabled).toBe(false));
		root.find("ai-helper-input").value = "Обсудим статью"; root.find("ai-helper-send").click();
		await vi.waitFor(() => expect(env.requests).toHaveLength(2));
		button("Повторить").click();
		expect(Notice.messages.at(-1)).toContain("Дождитесь");
		pending.resolve(new Response(JSON.stringify({ choices: [{ message: { content: "Обсудим." } }] })));
		await vi.waitFor(() => expect(chat.isGenerating()).toBe(false));
		expect(attempts).toBe(1);
		env.view.editor.getValue = () => "Изменённый оригинал";
		env.plugin.settings.translationLanguage = "Deutsch";
		button("Повторить").click(); button("Повторить").click();
		await vi.waitFor(() => expect(env.files.has("Заметки/Статья — en.md")).toBe(true));
		expect(attempts).toBe(2);
		expect(JSON.stringify(env.requests.at(-1))).toContain("Видимый текст.");
		expect(JSON.stringify(env.requests.at(-1))).toContain("English");
	} finally { await chat.onClose(); }
});
it.each(["чат", "перевод"])("атомарно отклоняет конкурирующие действия: первым запущен %s", async first => {
	const pending = deferred<Response>();
	const env = await setup({ completion: () => pending.promise });
	const one = await env.openChat(); const two = await env.openChat();
	try {
		one.root.find("ai-helper-input").value = "Первый вопрос";
		two.root.find("ai-helper-input").value = "Второй вопрос";
		if (first === "чат") {
			one.root.find("ai-helper-send").click();
			env.commands.get("translate-current-note")!();
		} else {
			env.commands.get("translate-current-note")!();
			one.root.find("ai-helper-send").click();
		}
		two.root.find("ai-helper-send").click();
		await vi.waitFor(() => expect(env.requests).toHaveLength(1));
		expect(two.root.find("ai-helper-input").value).toBe("Второй вопрос");
		expect(Notice.messages.at(-1)).toContain("Дождитесь");
		if (first === "чат") one.root.find("ai-helper-send").click(); else button("Остановить").click();
		two.root.find("ai-helper-send").click();
		await vi.waitFor(() => expect(env.requests).toHaveLength(2));
		pending.resolve(new Response(JSON.stringify({ choices: [{ message: { content: "Поздний ответ" } }] })));
		await vi.waitFor(() => expect(two.chat.isGenerating()).toBe(false));
		expect(env.requests).toHaveLength(2);
		expect(env.app.vault.create).not.toHaveBeenCalled();
	} finally { await one.chat.onClose(); await two.chat.onClose(); }
});
it.each(["завершение", "ожидание", "отмена", "выгрузка"])("перевод сохраняет готовый запрос индекса и освобождает приоритет: %s", async outcome => {
	const index = deferred<Response>(); const translation = deferred<Response>();
	const inputs: string[] = []; let indexSignal: AbortSignal | null | undefined;
	const env = await setup({ settings: { embeddingServerUrl: "http://server/v1", embeddingModel: "поиск", noteUpdateDelaySeconds: 0.01 },
		embedding: async (body, signal) => {
			inputs.push(...body.input);
			if (inputs.length === 1) { indexSignal = signal; return index.promise; }
			return new Response(JSON.stringify({ data: body.input.map((_: string, i: number) => ({ index: i, embedding: [1, 0] })) }));
		}, completion: () => translation.promise });
	env.files.set("Заметки/Следующая.md", "Следующая заметка.");
	env.commands.get("index-vault")!();
	await vi.waitFor(() => expect(inputs).toHaveLength(1));
	env.commands.get("translate-current-note")!();
	await new Promise(resolve => setTimeout(resolve, 20));
	expect(env.requests).toHaveLength(0); expect(indexSignal?.aborted).toBe(false);
	index.resolve(new Response(JSON.stringify({ data: [{ index: 0, embedding: [1, 0] }] })));
	await vi.waitFor(() => expect(env.requests).toHaveLength(1));
	expect(inputs).toHaveLength(1);
	if (outcome === "отмена") button("Остановить").click();
	else if (outcome === "выгрузка") env.plugin.onunload();
	else translation.resolve(outcome === "ожидание" ? new Response("{}", { status: 503 }) : response([{ id: "p1", text: "Первый." }, { id: "p2", text: "Второй." }], "stop"));
	if (outcome === "выгрузка") {
		await new Promise(resolve => setTimeout(resolve, 40)); expect(inputs).toHaveLength(1);
	} else {
		await vi.waitFor(() => expect(inputs).toHaveLength(2));
		expect(inputs[1]).toContain("Следующая заметка.");
		expect(inputs.filter(input => input.includes("Сохранённый текст."))).toHaveLength(1);
	}
	if (outcome === "отмена" || outcome === "выгрузка") {
		translation.resolve(response([{ id: "p1", text: "Поздний." }, { id: "p2", text: "Ответ." }], "stop"));
		await new Promise(resolve => setTimeout(resolve, 20));
		expect(env.app.vault.create).not.toHaveBeenCalled(); expect(env.requests).toHaveLength(1);
	}
});
it.each(["пауза", "ошибка"])("освобождение перевода сохраняет состояние индекса: %s", async state => {
	const index = deferred<Response>(); const translation = deferred<Response>(); let embeddings = 0;
	const env = await setup({ settings: { embeddingServerUrl: "http://server/v1", embeddingModel: "поиск", noteUpdateDelaySeconds: 0.01 },
		embedding: async () => { embeddings++; return index.promise; }, completion: () => translation.promise });
	env.files.set("Заметки/Следующая.md", "Следующая заметка.");
	const { chat, root } = await env.openChat();
	try {
		root.find("ai-helper-search-toggle").click();
		env.commands.get("index-vault")!();
		await vi.waitFor(() => expect(embeddings).toBe(1));
		if (state === "пауза") root.find("ai-helper-index-pause").click();
		index.resolve(state === "ошибка" ? new Response("{}", { status: 503 }) : new Response(JSON.stringify({ data: [{ index: 0, embedding: [1, 0] }] })));
		await vi.waitFor(() => expect(root.find("ai-helper-index-reason").getText()).toContain(state === "пауза" ? "Индексация приостановлена" : "Ошибка"));
		const before = root.find("ai-helper-index-reason").getText();
		env.commands.get("translate-current-note")!();
		await vi.waitFor(() => expect(env.requests).toHaveLength(1));
		translation.resolve(new Response("{}", { status: 503 }));
		await vi.waitFor(() => expect(button("Повторить").disabled).toBe(false));
		await new Promise(resolve => setTimeout(resolve, 40));
		expect(embeddings).toBe(1);
		expect(root.find("ai-helper-index-reason").getText()).toBe(before);
	} finally { await chat.onClose(); }
});
it("позднее завершение отменённой попытки не освобождает модель новой операции", async () => {
	const old = deferred<Response>(); const current = deferred<Response>(); let attempts = 0;
	const env = await setup({ completion: () => ++attempts === 1 ? old.promise : current.promise });
	const { chat, root } = await env.openChat();
	try {
		env.commands.get("translate-current-note")!();
		await vi.waitFor(() => expect(env.requests).toHaveLength(1));
		button("Остановить").click(); env.commands.get("translate-current-note")!();
		await vi.waitFor(() => expect(env.requests).toHaveLength(2));
		old.resolve(response([{ id: "p1", text: "Поздний." }, { id: "p2", text: "Ответ." }], "stop"));
		await new Promise(resolve => setTimeout(resolve, 20));
		root.find("ai-helper-input").value = "Новый вопрос"; root.find("ai-helper-send").click();
		expect(Notice.messages.at(-1)).toContain("Дождитесь"); expect(env.requests).toHaveLength(2);
		button("Остановить").click();
		current.resolve(response([{ id: "p1", text: "Второй." }, { id: "p2", text: "Ответ." }], "stop"));
		await new Promise(resolve => setTimeout(resolve, 20));
		expect(env.app.vault.create).not.toHaveBeenCalled();
	} finally { await chat.onClose(); }
});

// The model translates only visible prose; the expected document is authored
// independently, including its original whitespace and protected source text.
it("сохраняет каркас статьи, код, формулы и свойства при переводе через команду", async () => {
	const source = ["---", "title: Секретное свойство", "tags: [секрет]", "---", "# Заголовок #", "", "Раздел", "=======", "", "Абзац **важный** и *курсив*, ~~старый~~.", "", "- [x] Задача", "  1. Вложенный", "     продолжение", "", "> Цитата", ">", "> - Элемент", "", "---", "", "Код `секретный код` и $секретная формула$ #секрет ^блок", "", "```ts", "// Секретный комментарий", "const x = 1;", "```", "", "    Секретный отступный код", "", "$$", "Секретная блочная формула", "$$", ""].join("\n");
	const expected = ["---", "title: Секретное свойство", "tags: [секрет]", "---", "[Оригинал](<./Статья.md>)", "", "# Heading #", "", "Section", "=======", "", "Paragraph **important** and *italic*, ~~old~~.", "", "- [x] Task", "  1. Nested", "     continuation", "", "> Quote", ">", "> - Item", "", "---", "", "Code `секретный код` and $секретная формула$ #секрет ^блок", "", "```ts", "// Секретный комментарий", "const x = 1;", "```", "", "    Секретный отступный код", "", "$$", "Секретная блочная формула", "$$", ""].join("\n");
	const words: Record<string, string> = { Заголовок: "Heading", Раздел: "Section", Абзац: "Paragraph", важный: "important", и: "and", курсив: "italic", старый: "old", Задача: "Task", Вложенный: "Nested", продолжение: "continuation", Цитата: "Quote", Элемент: "Item", Код: "Code" };
	const env = await setup({ text: source, completion: async body => {
		const { units } = JSON.parse(body.messages.at(-1).content);
		return response(units.map((unit: { id: string; text: string }) => ({ ...unit, text: unit.text.replace(/[А-Яа-яЁё]+/g, word => words[word] ?? word) })).reverse(), "stop");
	} });
	env.commands.get("translate-current-note")!();
	await vi.waitFor(() => expect(button("Завершить")).toBeDefined());
	expect(env.files.get("Заметки/Статья — en.md")).toBe(expected);
	const sent = JSON.stringify(env.requests);
	for (const secret of ["Секретное свойство", "секретный код", "секретная формула", "Секретный комментарий", "Секретный отступный код", "Секретная блочная формула", "#секрет", "^блок"]) expect(sent).not.toContain(secret);
});

it("переводит явные подписи ссылок, изображений и встраиваний без чтения целей", async () => {
	const source = '[Подпись](<../Цели/Файл.md#Раздел> "Секретная подсказка") и [Подпись][ид].\n\n[ид]: ../Цели/Файл.md#Раздел\n\n[[Цели/Файл#Раздел|Подпись]] [[Секретная цель]] ![[Вложение#Раздел]] ![[Фото.png|200x100]] ![[Вложение|Подпись]]\n\n![Подпись](../Фото.png) <https://example.org/Секрет> https://example.org/секрет\n';
	const expected = '[Оригинал](<./Статья.md>)\n\n[Caption](<../Цели/Файл.md#Раздел> "Секретная подсказка") and [Caption][ид].\n\n[ид]: ../Цели/Файл.md#Раздел\n\n[[../Цели/Файл.md#Раздел|Caption]] [[../Секретная цель.md]] ![[../Вложение.md#Раздел]] ![[../Фото.png|200x100]] ![[../Вложение.md|Caption]]\n\n![Caption](../Фото.png) <https://example.org/Секрет> https://example.org/секрет\n';
	const env = await setup({ text: source, completion: async body => {
		const { units } = JSON.parse(body.messages.at(-1).content);
		return response(units.map((unit: { id: string; text: string }) => ({ ...unit, text: unit.text.replaceAll("Подпись", "Caption").replace(" и ", " and ") })), "stop");
	} });
	for (const path of ["Цели/Файл.md", "Секретная цель.md", "Вложение.md", "Фото.png"]) env.files.set(path, "Содержимое цели");
	env.commands.get("translate-current-note")!();
	await vi.waitFor(() => expect(button("Завершить")).toBeDefined());
	expect(env.files.get("Заметки/Статья — en.md")).toBe(expected);
	expect(env.app.vault.read).not.toHaveBeenCalled();
	for (const secret of ["Секретная подсказка", "Секретная цель", "Цели/Файл", "Вложение", "Фото.png", "example.org"]) expect(JSON.stringify(env.requests)).not.toContain(secret);
});
it.each(["удаление", "повтор", "перестановка", "чужая единица", "подделка", "новая разметка"])("отклоняет повреждение защищённых элементов: %s", async damage => {
	const env = await setup({ text: "Первый `секрет` и $формула$.\n\nВторой **важный**.", completion: async body => {
		const { units } = JSON.parse(body.messages.at(-1).content);
		const tokens = units[0].text.match(/⟦[^⟧]+⟧/g)!;
		if (damage === "удаление") units[0].text = units[0].text.replace(tokens[0], "");
		if (damage === "повтор") units[0].text += tokens[0];
		if (damage === "перестановка") units[0].text = `Текст ${tokens[1]} и ${tokens[0]}.`;
		if (damage === "чужая единица") units[1].text += tokens[0];
		if (damage === "подделка") units[0].text += "⟦AIH999:p1:0⟧";
		if (damage === "новая разметка") units[0].text += "\n# Новый раздел";
		return response(units, "stop");
	} });
	env.commands.get("translate-current-note")!();
	await vi.waitFor(() => expect(button("Завершить")).toBeDefined());
	expect(env.app.vault.create).not.toHaveBeenCalled();
	expect(Modal.opened[0].contentEl.getText()).toContain("неправильный или неполный");
});
it("сохраняет вложенное выделение, экранирование, жёсткие переносы и префиксы цитат", async () => {
	const source = "## **Важный *текст***\r\n\r\n- [ ] Первый\r\n  - Второй\r\n    Продолжение\r\n  Родитель\r\n\r\n> > ***Важный*** и __текст__  \r\n> > следующий\\\r\n> > конец\r\n\r\nПараграф\r\n    продолжение параграфа\r\n\r\nПуть \\*звезда\\* &amp; ⟦AIH0:p1:0⟧.\r\n";
	const expected = "[Оригинал](<./Статья.md>)\n\n## **Important *text***\r\n\r\n- [ ] First\r\n  - Second\r\n    Continuation\r\n  Parent\r\n\r\n> > ***Important*** и __text__  \r\n> > next\\\r\n> > end\r\n\r\nParagraph\r\n    paragraph continuation\r\n\r\nPath \\*star\\* &amp; ⟦AIH0:p1:0⟧.\r\n";
	const words: Record<string, string> = { Важный: "Important", текст: "text", Первый: "First", Второй: "Second", Продолжение: "Continuation", Родитель: "Parent", следующий: "next", конец: "end", Параграф: "Paragraph", "продолжение параграфа": "paragraph continuation", Путь: "Path", звезда: "star" };
	const env = await setup({ text: source, completion: async body => response(JSON.parse(body.messages.at(-1).content).units.map((unit: { id: string; text: string }) => ({ ...unit, text: unit.text.replace(/продолжение параграфа|[А-Яа-яЁё]+/g, word => words[word] ?? word) })), "stop") });
	env.commands.get("translate-current-note")!();
	await vi.waitFor(() => expect(button("Завершить")).toBeDefined());
	expect(env.files.get("Заметки/Статья — en.md")).toBe(expected);
});
it("не обращается к модели для заметки только с защищёнными данными", async () => {
	const source = "---\ntitle: Свойство\n---\n\n```\nСекретный код\n```\n\n$$x = 1$$\n";
	const env = await setup({ text: source }); env.commands.get("translate-current-note")!();
	await vi.waitFor(() => expect(button("Завершить")).toBeDefined());
	expect(env.files.get("Заметки/Статья — en.md")).toBe("---\ntitle: Свойство\n---\n[Оригинал](<./Статья.md>)\n\n\n```\nСекретный код\n```\n\n$$x = 1$$\n");
	expect(env.requests).toHaveLength(0);
});
it("не принимает пробелы, превращающие выделение в обычный текст", async () => {
	const env = await setup({ text: "Текст **важный**.", completion: async body => response(JSON.parse(body.messages.at(-1).content).units.map((unit: { id: string; text: string }) => ({ ...unit, text: unit.text.replace("важный", " important ") })), "stop") });
	env.commands.get("translate-current-note")!();
	await vi.waitFor(() => expect(button("Завершить")).toBeDefined());
	expect(env.app.vault.create).not.toHaveBeenCalled();
	expect(Modal.opened[0].contentEl.getText()).toContain("защищённые элементы");
});
it("сохраняет пустые свойства, разделители и определения reference-ссылок с переносами", async () => {
	const source = "---\n---\n\n[Подпись][] и [Короткая].\n\n[Подпись]:\n  <../Цель.md>\n  \"Секретная подсказка\"\n[Короткая]: ../Цель.md\n\n- - -\n\nMicrosoft Windows и Microsoft Word.\n";
	const expected = "---\n---\n[Оригинал](<./Статья.md>)\n\n\n[Caption][Подпись] and [Short][Короткая].\n\n[Подпись]:\n  <../Цель.md>\n  \"Секретная подсказка\"\n[Короткая]: ../Цель.md\n\n- - -\n\nMicrosoft Windows and Microsoft Word.\n";
	const env = await setup({ text: source, completion: async body => response(JSON.parse(body.messages.at(-1).content).units.map((unit: { id: string; text: string }) => ({ ...unit, text: unit.text.replaceAll("Подпись", "Caption").replaceAll("Короткая", "Short").replaceAll(" и ", " and ") })), "stop") });
	env.files.set("Цель.md", "Цель");
	env.commands.get("translate-current-note")!();
	await vi.waitFor(() => expect(button("Завершить")).toBeDefined());
	expect(env.files.get("Заметки/Статья — en.md")).toBe(expected);
	expect(JSON.stringify(env.requests)).not.toContain("Секретная подсказка");
});
it.each(["    - Секретный код\n", "\t1. Секретный код\n", "    # Секретный заголовок\n"])("не переводит отступный код, похожий на разметку: %j", async text => {
	const env = await setup({ text }); env.commands.get("translate-current-note")!();
	await vi.waitFor(() => expect(button("Завершить")).toBeDefined());
	expect(env.requests).toHaveLength(0);
	expect(env.files.get("Заметки/Статья — en.md")).toBe("[Оригинал](<./Статья.md>)\n\n" + text);
});
it.each(["Heading\n===", "Heading\r---"])("не позволяет модели создавать разметку одиночным переносом: %j", async text => {
	const env = await setup({ text: "Текст", completion: async () => response([{ id: "p1", text }], "stop") });
	env.commands.get("translate-current-note")!();
	await vi.waitFor(() => expect(button("Завершить")).toBeDefined());
	expect(env.app.vault.create).not.toHaveBeenCalled();
	expect(Modal.opened[0].contentEl.getText()).toContain("неправильный или неполный");
});
it("жёсткий перенос абзаца не зависит от нормализации пробелов моделью", async () => {
	const env = await setup({ text: "Первая строка  \nВторая строка", completion: async body => response(JSON.parse(body.messages.at(-1).content).units.map((unit: { id: string; text: string }) => ({ ...unit, text: unit.text.replaceAll("  ", " ").replace("Первая строка", "First line").replace("Вторая строка", "Second line") })), "stop") });
	env.commands.get("translate-current-note")!();
	await vi.waitFor(() => expect(button("Завершить")).toBeDefined());
	expect(env.files.get("Заметки/Статья — en.md")).toBe("[Оригинал](<./Статья.md>)\n\nFirst line  \nSecond line");
});
it.each(["разделитель после переноса", "пустая подпись"])("не принимает повреждение размещения защищённых элементов: %s", async damage => {
	const text = damage === "пустая подпись" ? "[Подпись](Цель.md)" : "Первая строка\nВторая строка";
	const env = await setup({ text, completion: async body => {
		const { units } = JSON.parse(body.messages.at(-1).content);
		units[0].text = units[0].text.replace(damage === "пустая подпись" ? "Подпись" : "Вторая строка", damage === "пустая подпись" ? "" : "===");
		return response(units, "stop");
	} });
	env.files.set("Заметки/Цель.md", "Цель");
	env.commands.get("translate-current-note")!();
	await vi.waitFor(() => expect(button("Завершить")).toBeDefined());
	expect(env.app.vault.create).not.toHaveBeenCalled();
	expect(Modal.opened[0].contentEl.getText()).toContain("неправильный или неполный");
});
it.each([["", "- ```"], ["> ", "> ```"], ["  ", "1. ```"]])("не распознаёт новые списки и цитаты внутри ограждённого кода: %j / %j", async (prefix, code) => {
	const block = ["```markdown", code, "Секретный код", "```"].map(line => prefix + line).join("\n");
	const source = (prefix === "  " ? "- Пункт\n" : "") + block + "\n\nТекст";
	const env = await setup({ text: source, completion: async body => response(JSON.parse(body.messages.at(-1).content).units.map((unit: { id: string; text: string }) => ({ ...unit, text: unit.text.replace("Текст", "Text").replace("Пункт", "Item") })), "stop") });
	env.commands.get("translate-current-note")!();
	await vi.waitFor(() => expect(button("Завершить")).toBeDefined());
	expect(env.files.get("Заметки/Статья — en.md")).toBe("[Оригинал](<./Статья.md>)\n\n" + (prefix === "  " ? "- Item\n" : "") + block + "\n\nText");
	expect(JSON.stringify(env.requests)).not.toContain("Секретный код");
});
it("сохраняет теги после знаков препинания и не отправляет их модели", async () => {
	const env = await setup({ text: "Текст (#секрет/вложенный).", completion: async body => response(JSON.parse(body.messages.at(-1).content).units.map((unit: { id: string; text: string }) => ({ ...unit, text: unit.text.replace("Текст", "Text") })), "stop") });
	env.commands.get("translate-current-note")!();
	await vi.waitFor(() => expect(button("Завершить")).toBeDefined());
	expect(env.files.get("Заметки/Статья — en.md")).toBe("[Оригинал](<./Статья.md>)\n\nText (#секрет/вложенный).");
	expect(JSON.stringify(env.requests)).not.toContain("секрет");
});
it("останавливается на неизвестном обозначении с потенциально переводимым текстом", async () => {
	const env = await setup({ text: "Начало ⟦плагин: Содержимое⟧." });
	env.commands.get("translate-current-note")!();
	await vi.waitFor(() => expect(button("Завершить")).toBeDefined());
	expect(env.requests).toHaveLength(0);
	expect(env.app.vault.create).not.toHaveBeenCalled();
	expect(Modal.opened[0].contentEl.getText()).toContain("неподдерживаемая");
});

it("переводит ячейки таблицы, сохраняя пустые ячейки, выравнивание и экранированные разделители", async () => {
	const source = "До таблицы.\n\n| Имя | Значение | Пусто |\n| :--- | ---: | :---: |\n| Текст | **Жирный** и `секрет` | |\n| Сноска | Путь \\| часть | |\n\nПосле таблицы.";
	const expected = "[Оригинал](<./Статья.md>)\n\nBefore table.\n\n| Name | Value | Empty |\n| :--- | ---: | :---: |\n| Text | **Bold** and `секрет` | |\n| Footnote | Path \\| part | |\n\nAfter table.";
	const words: Record<string, string> = { "До таблицы": "Before table", "После таблицы": "After table", Имя: "Name", Значение: "Value", Пусто: "Empty", Текст: "Text", Жирный: "Bold", и: "and", Сноска: "Footnote", Путь: "Path", часть: "part" };
	const env = await setup({ text: source, completion: async body => response(JSON.parse(body.messages.at(-1).content).units.map((unit: { id: string; text: string }) => ({ ...unit, text: unit.text.replace(/До таблицы|После таблицы|[А-Яа-яЁё]+/g, word => words[word] ?? word) })), "stop") });
	env.commands.get("translate-current-note")!();
	await vi.waitFor(() => expect(button("Завершить")).toBeDefined());
	expect(env.files.get("Заметки/Статья — en.md")).toBe(expected);
	expect(JSON.stringify(env.requests)).not.toContain("секрет");
});

it("переводит многострочные определения сносок один раз и сохраняет повторные упоминания", async () => {
	const source = "Текст[^ид] и снова[^ид].\n\n[^ид]: Определение **важное**.\n    Продолжение с `секретом`.\n\n    Второй абзац.\n\nКонец.";
	const expected = "[Оригинал](<./Статья.md>)\n\nText[^ид] and again[^ид].\n\n[^ид]: Definition **important**.\n    Continuation with `секретом`.\n\n    Second paragraph.\n\nEnd.";
	const words: Record<string, string> = { Текст: "Text", и: "and", снова: "again", Определение: "Definition", важное: "important", Продолжение: "Continuation", с: "with", "Второй абзац": "Second paragraph", Конец: "End" };
	const env = await setup({ text: source, completion: async body => response(JSON.parse(body.messages.at(-1).content).units.map((unit: { id: string; text: string }) => ({ ...unit, text: unit.text.replace(/Второй абзац|[А-Яа-яЁё]+/g, word => words[word] ?? word) })), "stop") });
	env.commands.get("translate-current-note")!();
	await vi.waitFor(() => expect(button("Завершить")).toBeDefined());
	expect(env.files.get("Заметки/Статья — en.md")).toBe(expected);
	const sent = JSON.parse(env.requests[0].messages.at(-1).content).units.map((unit: { text: string }) => unit.text).join(" ");
	expect(sent).not.toContain("ид");
	expect(sent.match(/Определение/g)).toHaveLength(1);
});

it("переводит вложенные callout с таблицей и сноской, сохраняя тип, сворачивание и код", async () => {
	const source = ["Начало[^источник].", "", "> [!TIP]- **Мой заголовок**", "> Описание.", ">", "> | Имя | Значение |", "> | --- | ---: |", "> | Текст[^источник] | `секрет` |", ">", "> > [!custom]+ Вложенный", "> > - **Пункт**", "> >", "> > ```md", "> > > [!warning] Секретный код", "> > ```", ">", "> [!note]", "> Конец.", "", "[^источник]: Источник.", "    Продолжение.", ""].join("\n");
	const expected = ["[Оригинал](<./Статья.md>)", "", "Start[^источник].", "", "> [!TIP]- **My title**", "> Description.", ">", "> | Name | Value |", "> | --- | ---: |", "> | Text[^источник] | `секрет` |", ">", "> > [!custom]+ Nested", "> > - **Item**", "> >", "> > ```md", "> > > [!warning] Секретный код", "> > ```", ">", "> [!note]", "> End.", "", "[^источник]: Source.", "    Continuation.", ""].join("\n");
	const words: Record<string, string> = { Начало: "Start", "Мой заголовок": "My title", Описание: "Description", Имя: "Name", Значение: "Value", Текст: "Text", Вложенный: "Nested", Пункт: "Item", Конец: "End", Источник: "Source", Продолжение: "Continuation" };
	const env = await setup({ text: source, completion: async body => response(JSON.parse(body.messages.at(-1).content).units.map((unit: { id: string; text: string }) => ({ ...unit, text: unit.text.replace(/Мой заголовок|[А-Яа-яЁё]+/g, word => words[word] ?? word) })), "stop") });
	env.commands.get("translate-current-note")!();
	await vi.waitFor(() => expect(button("Завершить")).toBeDefined());
	expect(env.files.get("Заметки/Статья — en.md")).toBe(expected);
	for (const secret of ["TIP", "custom", "warning", "Секретный код", "секрет", "источник"]) expect(JSON.stringify(env.requests)).not.toContain(secret);
});

it.each(["лишняя ячейка", "пропущенная ячейка", "дубль определения", "идентификатор сноски", "тип callout", "повреждённое выделение"])("не сохраняет повреждённую структуру сложных конструкций: %s", async damage => {
	const env = await setup({ text: "Текст[^ид].\n\n| Имя | Значение |\n| --- | --- |\n| Ячейка | **Важно** |\n\n> [!tip]- Заголовок\n> Содержимое.\n\n[^ид]: Определение.", completion: async body => {
		const { units } = JSON.parse(body.messages.at(-1).content);
		if (damage === "лишняя ячейка") units.find((unit: { text: string }) => unit.text === "Ячейка").text += " | Добавка";
		if (damage === "пропущенная ячейка") units.splice(units.findIndex((unit: { text: string }) => unit.text === "Ячейка"), 1);
		if (damage === "дубль определения") units.push({ ...units.at(-1) });
		if (damage === "идентификатор сноски") units[0].text = "Текст[^другой].";
		if (damage === "тип callout") units.find((unit: { text: string }) => unit.text === "Заголовок").text = "[!warning]+ Заголовок";
		if (damage === "повреждённое выделение") units.find((unit: { text: string }) => unit.text.includes("Важно")).text = "Важно";
		return response(units, "stop");
	} });
	env.commands.get("translate-current-note")!();
	await vi.waitFor(() => expect(button("Завершить")).toBeDefined());
	expect(env.requests).toHaveLength(1);
	expect(env.app.vault.create).not.toHaveBeenCalled();
	expect(Modal.opened[0].contentEl.getText()).toContain("неправильный или неполный");
});
it.each([
	"| Имя | Значение |\n| --- | --- |\n| Лишняя | Ячейка | Третья |",
	"| Имя | Значение |\n| --- |",
	"Текст[^ид].\n\n[^ид]: Первое.\n\n[^ид]: Второе.",
	"> [!tip]- Заголовок\n> :::расширение\n> Текст",
	"| Имя | Значение |\n| --- | --- |\n| Текст | <span>Неизвестное</span> |",
])("останавливает неизвестную или неоднозначную сложную разметку до запроса: %s", async text => {
	const env = await setup({ text }); env.commands.get("translate-current-note")!();
	await vi.waitFor(() => expect(button("Завершить")).toBeDefined());
	expect(env.requests).toHaveLength(0);
	expect(env.app.vault.create).not.toHaveBeenCalled();
	expect(Modal.opened[0].contentEl.getText()).toContain("неподдерживаемая");
});
it("сохраняет таблицу без внешних разделителей и определения сноски с кодом", async () => {
	const source = "Имя | Значение\r\n--- | ---\r\nТекст | [^ид]\r\n\r\n[^ид]:\r\n    Описание.\r\n\r\n    ```ts\r\n    // Секретный код\r\n    ```\r\n";
	const expected = "[Оригинал](<./Статья.md>)\n\nName | Value\r\n--- | ---\r\nText | [^ид]\r\n\r\n[^ид]:\r\n    Description.\r\n\r\n    ```ts\r\n    // Секретный код\r\n    ```\r\n";
	const words: Record<string, string> = { Имя: "Name", Значение: "Value", Текст: "Text", Описание: "Description" };
	const env = await setup({ text: source, completion: async body => response(JSON.parse(body.messages.at(-1).content).units.map((unit: { id: string; text: string }) => ({ ...unit, text: unit.text.replace(/[А-Яа-яЁё]+/g, word => words[word] ?? word) })), "stop") });
	env.commands.get("translate-current-note")!();
	await vi.waitFor(() => expect(button("Завершить")).toBeDefined());
	expect(env.files.get("Заметки/Статья — en.md")).toBe(expected);
	expect(JSON.stringify(env.requests)).not.toContain("Секретный код");
});

it.each(["", "---", "    Секретный код"])("не продолжает таблицу через границу блока: %j", async boundary => {
	const env = await setup({ text: "| Имя | Значение |\n| --- | --- |\n| Текст | Значение |\n" + boundary + "\n| Неизвестная | Конструкция |" });
	env.commands.get("translate-current-note")!();
	await vi.waitFor(() => expect(button("Завершить")).toBeDefined());
	expect(env.requests).toHaveLength(0);
	expect(env.app.vault.create).not.toHaveBeenCalled();
});

it("сохраняет ограждённый код непосредственно после маркера определения сноски", async () => {
	const source = "Текст[^ид].\n\n[^ид]: ```ts\n    const secret = 1;\n    ```\n\n    Описание.";
	const env = await setup({ text: source, completion: async body => response(JSON.parse(body.messages.at(-1).content).units.map((unit: { id: string; text: string }) => ({ ...unit, text: unit.text.replace("Текст", "Text").replace("Описание", "Description") })), "stop") });
	env.commands.get("translate-current-note")!();
	await vi.waitFor(() => expect(button("Завершить")).toBeDefined());
	expect(env.files.get("Заметки/Статья — en.md")).toBe("[Оригинал](<./Статья.md>)\n\nText[^ид].\n\n[^ид]: ```ts\n    const secret = 1;\n    ```\n\n    Description.");
	expect(JSON.stringify(env.requests)).not.toContain("secret");
});

it("сохраняет упоминание сноски в начале абзаца", async () => {
	const env = await setup({ text: "[^ид] Текст.\n\n[^ид]: Определение.", completion: async body => response(JSON.parse(body.messages.at(-1).content).units.map((unit: { id: string; text: string }) => ({ ...unit, text: unit.text.replace("Текст", "Text").replace("Определение", "Definition") })), "stop") });
	env.commands.get("translate-current-note")!();
	await vi.waitFor(() => expect(button("Завершить")).toBeDefined());
	expect(env.files.get("Заметки/Статья — en.md")).toBe("[Оригинал](<./Статья.md>)\n\n[^ид] Text.\n\n[^ид]: Definition.");
});


it("сохраняет в новой папке ссылки и встраивания по снимку, не читая вложения", async () => {
	const pending = deferred<Response>();
	const source = '---\ntitle: Статья\n---\n# Раздел\n\n[Подробности](../Материалы/Справка.md#История) ![Рисунок](../Ресурсы/схема.png) ![[Материалы/Справка#История]]\n\n[Описание][ист]\n\n[ист]: ../Материалы/Справка.md "Подсказка"\n';
	const env = await setup({ text: source, settings: { translationFolderMode: "custom", translationFolder: "Переводы/Готовые" }, completion: () => pending.promise });
	env.files.set("Материалы/Справка.md", "Секретное содержимое"); env.files.set("Ресурсы/схема.png", "Изображение");
	env.commands.get("translate-current-note")!();
	await vi.waitFor(() => expect(env.requests).toHaveLength(1));
	env.files.delete("Материалы/Справка.md"); env.files.set("Перенесено/Справка.md", "Другое");
	env.files.delete("Ресурсы/схема.png"); env.files.delete(env.file.path); env.file.path = "Перенесено/Статья.md";
	env.plugin.settings.translationFolder = "Изменено";
	const { units } = JSON.parse(env.requests[0].messages.at(-1).content);
	pending.resolve(response(units.map((unit: { id: string; text: string }) => ({ ...unit, text: unit.text.replace("Раздел", "Section").replace("Подробности", "Details").replace("Рисунок", "Picture").replace("Описание", "Description") })), "stop"));
	await vi.waitFor(() => expect(env.files.has("Переводы/Готовые/Статья — en.md")).toBe(true));
	expect(env.files.get("Переводы/Готовые/Статья — en.md")).toBe('---\ntitle: Статья\n---\n[Оригинал](<../../Заметки/Статья.md>)\n\n# Section\n\n[Details](../../Материалы/Справка.md#История) ![Picture](../../Ресурсы/схема.png) ![[../../Материалы/Справка.md#История]]\n\n[Description][ист]\n\n[ист]: ../../Материалы/Справка.md "Подсказка"\n');
	expect(env.app.vault.createFolder).toHaveBeenCalledWith("Переводы");
	expect(env.app.vault.createFolder).toHaveBeenCalledWith("Переводы/Готовые");
	expect(env.app.vault.read).not.toHaveBeenCalled();
	expect(JSON.stringify(env.requests)).not.toContain("Секретное содержимое");
});


it("обновляет самоссылки на переведённые ATX/Setext-заголовки и сохраняет чужие заголовки и блоки", async () => {
	const source = "# Раздел\n\nВторой раздел\n---\n\n[Начало](#Раздел) [[Статья#Второй раздел|Далее]] ![[#^блок]] [Снаружи](Справка.md#Раздел)\n\nТекст ^блок";
	const env = await setup({ text: source, settings: { translationFolderMode: "custom", translationFolder: "Переводы" }, completion: async body => response(JSON.parse(body.messages.at(-1).content).units.map((unit: { id: string; text: string }) => ({ ...unit, text: unit.text.replace("Второй раздел", "Second section").replace("Раздел", "Section").replace("Начало", "Start").replace("Далее", "Next").replace("Снаружи", "Outside").replace("Текст", "Text") })), "stop") });
	env.files.set("Заметки/Справка.md", "# Раздел");
	env.files.set("Обратная.md", "[[Заметки/Статья#Раздел]]");
	env.commands.get("translate-current-note")!();
	await vi.waitFor(() => expect(button("Завершить")).toBeDefined());
	expect(env.files.get("Переводы/Статья — en.md")).toBe("[Оригинал](<../Заметки/Статья.md>)\n\n# Section\n\nSecond section\n---\n\n[Start](#Section) [[./Статья — en.md#Second section|Next]] ![[#^блок]] [Outside](../Заметки/Справка.md#Раздел)\n\nText ^блок");
	expect(env.files.get("Обратная.md")).toBe("[[Заметки/Статья#Раздел]]");
});

it("сохраняет неразрешимые ссылки дословно с предупреждением даже при появлении целей после запуска", async () => {
	const pending = deferred<Response>();
	const source = "Текст [Неизвестная](Нет.md) [[Нет|Подпись]] ![Фото](Нет.png) [Справка][нет].\n\n[нет]: Нет.md\n\n[Сайт](https://example.org/a_(b)?q=%2F#секция)";
	const env = await setup({ text: source, settings: { translationFolderMode: "custom", translationFolder: "Переводы" }, completion: () => pending.promise });
	env.commands.get("translate-current-note")!();
	await vi.waitFor(() => expect(env.requests).toHaveLength(1));
	env.files.set("Заметки/Нет.md", "Случайная новая цель"); env.files.set("Нет.png", "Новая картинка");
	pending.resolve(response(JSON.parse(env.requests[0].messages.at(-1).content).units.map((unit: { id: string; text: string }) => ({ ...unit, text: unit.text.replace("Текст", "Text").replace("Справка", "Reference").replace("Сайт", "Website") })), "stop"));
	await vi.waitFor(() => expect(button("Завершить")).toBeDefined());
	expect(env.files.get("Переводы/Статья — en.md")).toBe("[Оригинал](<../Заметки/Статья.md>)\n\nText [Неизвестная](Нет.md) [[Нет|Подпись]] ![Фото](Нет.png) [Справка][нет].\n\n[нет]: Нет.md\n\n[Website](https://example.org/a_(b)?q=%2F#секция)");
	expect(Modal.opened[0].contentEl.getText()).toContain("сохранены дословно");
});

it.each(["", "   ", "../Вне", "/Абсолютный", "Папка/../Вне", "Папка\\Вне", "Папка//Вне"])("блокирует неподходящую папку до обращения к модели: %j", async folder => {
	const env = await setup({ settings: { translationFolderMode: "custom", translationFolder: folder } });
	env.commands.get("translate-current-note")!();
	await vi.waitFor(() => expect(button("Завершить")).toBeDefined());
	expect(env.requests).toHaveLength(0); expect(env.app.vault.create).not.toHaveBeenCalled();
	expect(Modal.opened[0].contentEl.getText()).toContain("путь папки");
});

it("не сохраняет неоднозначную самоссылку на повторяющиеся заголовки", async () => {
	const env = await setup({ text: "# Раздел\n\n# Раздел\n\n[[#Раздел|Далее]]", completion: async body => response(JSON.parse(body.messages.at(-1).content).units, "stop") });
	env.commands.get("translate-current-note")!();
	await vi.waitFor(() => expect(button("Завершить")).toBeDefined());
	expect(env.app.vault.create).not.toHaveBeenCalled();
	expect(Modal.opened[0].contentEl.getText()).toContain("неподдерживаемая");
});

it("фиксирует выбор Obsidian для короткой ссылки до чтения закрытой заметки", async () => {
	const reading = deferred<string>();
	const pending = deferred<Response>();
	const env = await setup({ settings: { translationFolderMode: "custom", translationFolder: "Переводы" }, completion: () => pending.promise });
	env.files.set("Архив/Справка.md", "Первая цель"); env.files.set("Материалы/Справка.md", "Выбранная цель");
	let target = "Материалы/Справка.md";
	const resolve = vi.fn((name: string) => name === "Справка" ? Object.assign(new TFile(), { path: target }) : null);
	Object.assign(env.app.metadataCache, { getFirstLinkpathDest: resolve });
	Object.assign(env.app.workspace, { getLeavesOfType: () => [], getActiveViewOfType: () => null });
	vi.mocked(env.app.vault.read).mockReturnValueOnce(reading.promise);
	env.commands.get("translate-current-note")!();
	target = "Архив/Справка.md"; env.files.delete("Материалы/Справка.md");
	reading.resolve("[Справка](Справка)");
	await vi.waitFor(() => expect(env.requests).toHaveLength(1));
	resolve.mockClear();
	pending.resolve(response(JSON.parse(env.requests[0].messages.at(-1).content).units.map((unit: { id: string; text: string }) => ({ ...unit, text: unit.text.replace("Справка", "Reference") })), "stop"));
	await vi.waitFor(() => expect(env.files.has("Переводы/Статья — en.md")).toBe(true));
	expect(env.files.get("Переводы/Статья — en.md")).toContain("[Reference](../Материалы/Справка.md)");
	expect(resolve).not.toHaveBeenCalled();
});

it("пересчитывает закодированные Markdown-пути, изображения с размером и reference-ссылки без явного идентификатора", async () => {
	const source = '[Фото](../Ресурсы/фото%20%281%29.png) ![[Ресурсы/фото (1).png|200x100]] [Короткая][] [Короткая]\n\n[Короткая]: <../Материалы/Справка.md> "Подсказка"';
	const env = await setup({ text: source, settings: { translationFolderMode: "custom", translationFolder: "Переводы/Статьи" }, completion: async body => response(JSON.parse(body.messages.at(-1).content).units.map((unit: { id: string; text: string }) => ({ ...unit, text: unit.text.replace("Фото", "Photo").replaceAll("Короткая", "Short") })), "stop") });
	env.files.set("Ресурсы/фото (1).png", "Картинка"); env.files.set("Материалы/Справка.md", "Справка");
	env.commands.get("translate-current-note")!();
	await vi.waitFor(() => expect(button("Завершить")).toBeDefined());
	expect(env.files.get("Переводы/Статьи/Статья — en.md")).toBe('[Оригинал](<../../Заметки/Статья.md>)\n\n[Photo](../../Ресурсы/фото%20%281%29.png) ![[../../Ресурсы/фото (1).png|200x100]] [Short][Короткая] [Short][Короткая]\n\n[Короткая]: <../../Материалы/Справка.md> "Подсказка"');
});

it("сохраняет назначение Markdown-ссылки на файл с закодированным знаком решётки", async () => {
	const env = await setup({ text: "[Справка](../Материалы/Файл%23один.md#Раздел)", settings: { translationFolderMode: "custom", translationFolder: "Переводы" }, completion: async body => response(JSON.parse(body.messages.at(-1).content).units.map((unit: { id: string; text: string }) => ({ ...unit, text: unit.text.replace("Справка", "Reference") })), "stop") });
	env.files.set("Материалы/Файл#один.md", "# Раздел");
	env.commands.get("translate-current-note")!();
	await vi.waitFor(() => expect(button("Завершить")).toBeDefined());
	expect(env.files.get("Переводы/Статья — en.md")).toContain("[Reference](../Материалы/Файл%23один.md#Раздел)");
});

it("закрепляет короткую ссылку по снимку и в папке оригинала при появлении новой одноимённой цели", async () => {
	const pending = deferred<Response>();
	const env = await setup({ text: "Текст [[Справка]]", completion: () => pending.promise });
	env.files.set("Материалы/Справка.md", "Исходная цель");
	Object.assign(env.app.metadataCache, { getFirstLinkpathDest: (name: string) => name === "Справка" ? Object.assign(new TFile(), { path: "Материалы/Справка.md" }) : null });
	env.commands.get("translate-current-note")!();
	await vi.waitFor(() => expect(env.requests).toHaveLength(1));
	env.files.set("Заметки/Справка.md", "Новая одноимённая цель");
	pending.resolve(response(JSON.parse(env.requests[0].messages.at(-1).content).units.map((unit: { id: string; text: string }) => ({ ...unit, text: unit.text.replace("Текст", "Text") })), "stop"));
	await vi.waitFor(() => expect(button("Завершить")).toBeDefined());
	expect(env.files.get("Заметки/Статья — en.md")).toContain("Text [[../Материалы/Справка.md]]");
});

it("сохраняет самоссылку на отсутствующий заголовок дословно с предупреждением", async () => {
	const env = await setup({ text: "# Раздел\n\n[Назад](#Отсутствует)", completion: async body => response(JSON.parse(body.messages.at(-1).content).units.map((unit: { id: string; text: string }) => ({ ...unit, text: unit.text.replace("Раздел", "Section").replace("Назад", "Back") })), "stop") });
	env.commands.get("translate-current-note")!();
	await vi.waitFor(() => expect(button("Завершить")).toBeDefined());
	expect(env.files.get("Заметки/Статья — en.md")).toBe("[Оригинал](<./Статья.md>)\n\n# Section\n\n[Назад](#Отсутствует)");
	expect(Modal.opened[0].contentEl.getText()).toContain("сохранены дословно");
});

it.each([
	["Первая\nвторая\n---", "Первая%20вторая", "First\nsecond\n---", "First%20second"],
	["> Раздел\n> ---", "Раздел", "> Section\n> ---", "Section"],
	["# [Раздел](Справка.md)", "Раздел", "# [Section](./Справка.md)", "Section"],
])("обновляет самоссылку на заголовок со сложным оформлением: %s", async (heading, anchor, expectedHeading, expectedAnchor) => {
	const env = await setup({ text: heading + "\n\n[Назад](#" + anchor + ")", completion: async body => response(JSON.parse(body.messages.at(-1).content).units.map((unit: { id: string; text: string }) => ({ ...unit, text: unit.text.replace("Раздел", "Section").replace("Первая", "First").replace("вторая", "second").replace("Назад", "Back") })), "stop") });
	env.files.set("Заметки/Справка.md", "Справка");
	env.commands.get("translate-current-note")!();
	await vi.waitFor(() => expect(button("Завершить")).toBeDefined());
	expect(env.files.get("Заметки/Статья — en.md")).toBe("[Оригинал](<./Статья.md>)\n\n" + expectedHeading + "\n\n[Back](#" + expectedAnchor + ")");
});

it("закрепляет Markdown-ссылку и ссылку на оригинал при удалении файлов с одноимёнными копиями в хранилище", async () => {
	const pending = deferred<Response>();
	const env = await setup({ text: "[Справка](Справка.md)", completion: () => pending.promise });
	env.files.set("Заметки/Справка.md", "Исходная цель"); env.files.set("Архив/Справка.md", "Другая цель"); env.files.set("Архив/Статья.md", "Другой оригинал");
	env.commands.get("translate-current-note")!();
	await vi.waitFor(() => expect(env.requests).toHaveLength(1));
	env.files.delete("Заметки/Справка.md"); env.files.delete("Заметки/Статья.md");
	pending.resolve(response(JSON.parse(env.requests[0].messages.at(-1).content).units.map((unit: { id: string; text: string }) => ({ ...unit, text: unit.text.replace("Справка", "Reference") })), "stop"));
	await vi.waitFor(() => expect(button("Завершить")).toBeDefined());
	expect(env.files.get("Заметки/Статья — en.md")).toBe("[Оригинал](<./Статья.md>)\n\n[Reference](./Справка.md)");
});
