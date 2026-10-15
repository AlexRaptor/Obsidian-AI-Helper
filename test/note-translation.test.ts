import { afterEach, expect, it, vi } from "vitest";
import { type App, type PluginManifest, type WorkspaceLeaf, TFile, MarkdownView } from "obsidian";
import { ChatView } from "../src/chat-view";
import { AiHelperPlugin } from "../src/main";
import { DEFAULT_SETTINGS } from "../src/settings";
import { Modal, Notice, deferred, type TestElement } from "./helpers/obsidian";
vi.mock("obsidian", async () => import("./helpers/obsidian"));
const plugins: AiHelperPlugin[] = [];
afterEach(() => { plugins.forEach(plugin => plugin.onunload()); plugins.length = 0; Modal.opened.slice().forEach(modal => modal.close()); Notice.messages.length = 0; vi.unstubAllGlobals(); vi.restoreAllMocks(); });
async function setup(options: { text?: string; settings?: Record<string, unknown>; completion?: (body: any, signal?: AbortSignal | null) => Promise<Response> } = {}) {
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
		if (!url.endsWith("/chat/completions")) return new Response(JSON.stringify({ data: [] }));
		const body = JSON.parse(String(init?.body)); requests.push(body);
		if (options.completion) return options.completion(body, init?.signal);
		return new Response(JSON.stringify({ choices: [{ message: { content: JSON.stringify({ units: [{ id: "p1", text: "Visible text." }, { id: "p2", text: "Second paragraph." }] }) }, finish_reason: "stop" }] }));
	});
	vi.stubGlobal("fetch", network);
	const app = { vault: { adapter: {}, offref: () => {}, on: () => ({}), getMarkdownFiles: () => [file], getFileByPath: (path: string) => files.has(path) ? file : null,
		getAbstractFileByPath: (path: string) => files.has(path) ? file : null, read: vi.fn(async () => files.get(file.path)!),
		create: vi.fn(async (path: string, text: string) => { if (files.has(path)) throw Error("Занято"); files.set(path, text); return Object.assign(new TFile(), { path, extension: "md" }); }) },
		workspace: { activeLeaf: leaf, getActiveViewOfType: (type: unknown) => type === MarkdownView ? view : null, getActiveFile: () => file, getLeavesOfType: (type: string) => type === "markdown" ? [leaf] : [],
			on: (name: string, callback: (...args: any[]) => void) => { events.set(name, callback); return {}; }, onLayoutReady: () => {}, detachLeavesOfType: () => {},
			createLeafBySplit: vi.fn(() => right), getLeaf: () => right, setActiveLeaf: vi.fn() } } as unknown as App;
	const plugin = new AiHelperPlugin(app, { id: "obsidian-ai-helper" } as PluginManifest); plugins.push(plugin);
	vi.spyOn(plugin, "loadData").mockResolvedValue({ ...DEFAULT_SETTINGS, serverUrl: "http://server/v1", model: "model", contextWindow: "32000", language: "ru", translationLanguage: "English", translationSuffix: " — en", systemPrompt: "СЕКРЕТ ЧАТА", ...options.settings });
	vi.spyOn(plugin, "addCommand").mockImplementation((command: any) => { commands.set(command.id, command.callback); return command; });
	await plugin.onload();
	return { plugin, app, file, files, view, leaf, right, opened, commands, events, network, requests };
}
it("команда переводит видимые абзацы и открывает отдельную заметку рядом", async () => {
	const env = await setup();
	expect(env.commands.has("translate-current-note")).toBe(true);
	env.commands.get("translate-current-note")!();
	await vi.waitFor(() => expect(env.files.has("Заметки/Статья — en.md")).toBe(true));
	expect(env.files.get("Заметки/Статья — en.md")).toBe("[Оригинал](<Статья.md>)\n\nVisible text.\n\nSecond paragraph.");
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
it.each(["# Заголовок", "Текст со [ссылкой](Цель.md)", "---\nсвойство: текст\n---", "Текст\n\n- Список", "Текст\n\n$$\nформула\n$$", "<div>Текст</div>"])("отклоняет неподдерживаемую разметку до запроса: %s", async text => {
	const env = await setup({ text }); env.commands.get("translate-current-note")!();
	await vi.waitFor(() => expect(button("Завершить")).toBeDefined());
	expect(env.requests).toHaveLength(0); expect(env.app.vault.create).not.toHaveBeenCalled();
	expect(Modal.opened[0].contentEl.getText()).toContain("только обычные абзацы");
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
