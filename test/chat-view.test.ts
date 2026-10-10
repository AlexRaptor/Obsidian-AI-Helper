import { afterEach, describe, expect, it, vi } from "vitest";
import { MarkdownRenderer, type WorkspaceLeaf } from "obsidian";
import { ChatView } from "../src/chat-view";
import type { AiHelperPlugin } from "../src/main";
import { DEFAULT_SETTINGS } from "../src/settings";
import { t, setLanguage } from "../src/i18n";
import { createServerClient, type ClientFetch } from "../src/server-client";
import type { ServerClient, ServerClientResult, ChatCompletionResult } from "../src/server-client";
import { TestElement, deferred, flushPromises } from "./helpers/obsidian";
import { createContextWindowConnection } from "../src/context-window";

vi.mock("obsidian", async () => import("./helpers/obsidian"));

afterEach(() => { vi.restoreAllMocks(); });

type Result = ServerClientResult<ChatCompletionResult>;
const success = (content: string): Result => ({ ok: true, value: { content } });
const failure: Result = { ok: false, error: { message: "offline" } };

async function setup(chat: ServerClient["chat"]) {
	setLanguage("en");
	const plugin = {
		settings: { ...DEFAULT_SETTINGS, serverUrl: "http://s", model: "m" },
		serverClient: { chat }, t,
	} as unknown as AiHelperPlugin;
	const view = new ChatView({} as WorkspaceLeaf, plugin);
	await view.onOpen();
	const root = view.contentEl as unknown as TestElement;
	const input = root.find("ai-helper-input");
	const send = root.find("ai-helper-send");
	return { view, root, input, send };
}

it("uses the detected window for the progress bar and lets manual settings override it", async () => {
	const client = createServerClient(async () => new Response(JSON.stringify({ data: [{ id: "m", max_model_len: 4000 }] })));
	const { view, root, input, send } = await setup(async () => ({ ok: true, value: { content: "answer", usage: { promptTokens: 900, completionTokens: 100, totalTokens: 1000 } } }));
	const connection = createContextWindowConnection(client);
	view.plugin.contextWindowConnection = connection;
	connection.configure(view.plugin.settings);
	const unsubscribe = connection.subscribe(() => view.updateContextIndicators());
	await connection.refresh();
	input.value = "question"; send.click(); await flushPromises();
	expect(root.find("ai-helper-context-label").getText()).toBe("25% - 1,000 / 4,000");
	expect(root.find("ai-helper-context-bar-fill").style.width).toBe("25%");
	view.plugin.settings.contextWindow = "2000"; view.updateContextIndicators();
	expect(root.find("ai-helper-context-bar-fill").style.width).toBe("50%");
	view.plugin.settings.contextWindow = ""; view.updateContextIndicators();
	expect(root.find("ai-helper-context-bar-fill").style.width).toBe("25%");
	unsubscribe(); await view.onClose();
});

describe("chat view request lifecycle", () => {
	it.each([
		["en", "Generation parameters must be numbers. Correct the settings and try again."],
		["ru", "Параметры генерации должны быть числами. Исправьте настройки и повторите запрос."],
	] as const)("localizes invalid generation parameters and retries in %s", async (locale, message) => {
		const fetch = vi.fn<Parameters<ClientFetch>, ReturnType<ClientFetch>>(async () => new Response(JSON.stringify({ choices: [{ message: { content: "answer" } }] })));
		const { view, root, input, send } = await setup(createServerClient(fetch).chat);
		setLanguage(locale);
		await view.refreshLocale();
		view.plugin.settings.temperature = "abc";
		view.plugin.settings.maxTokens = "bad";
		view.plugin.settings.topP = "oops";
		input.value = "question";
		send.click();
		await flushPromises();
		expect(root.getText()).toContain(message);
		expect(root.getText()).not.toContain("Invalid generation parameters:");
		expect(fetch).not.toHaveBeenCalled();
		expect(input.value).toBe("question");
		expect(view.getMessages()).toEqual([]);
		view.plugin.settings.temperature = "0.7";
		view.plugin.settings.maxTokens = "100";
		view.plugin.settings.topP = "0.9";
		send.click();
		await flushPromises();
		expect(fetch).toHaveBeenCalledTimes(1);
		expect(JSON.parse(String(fetch.mock.calls[0][1]?.body)).messages).toEqual([{ role: "user", content: "question" }]);
		expect(view.getMessages()).toEqual([{ role: "user", content: "question" }, { role: "model", content: "answer" }]);
		await view.onClose();
	});

	it("ignores an old response after clearing and starting a new conversation", async () => {
		const old = deferred<Result>();
		const next = deferred<Result>();
		const chat = vi.fn<Parameters<ServerClient["chat"]>, ReturnType<ServerClient["chat"]>>()
			.mockReturnValueOnce(old.promise).mockReturnValueOnce(next.promise);
		const { view, root, input, send } = await setup(chat);
		input.value = "old question";
		send.click();
		await flushPromises();
		root.find("ai-helper-clear-btn").click();
		await flushPromises();
		expect(chat.mock.calls[0][3]?.signal?.aborted).toBe(true);
		expect(view.getMessages()).toEqual([]);
		expect(send.disabled).toBe(false);
		input.value = "new question";
		send.click();
		await flushPromises();
		old.resolve(success("old answer"));
		await flushPromises();
		expect(send.text).toBe("Stop");
		expect(root.getText()).not.toContain("old answer");
		next.resolve(success("new answer"));
		await flushPromises();
		expect(view.getMessages()).toEqual([
			{ role: "user", content: "new question" },
			{ role: "model", content: "new answer" },
		]);
		expect(root.getText()).toContain("new answer");
	});

	it("retries a failed message once without duplicating request history", async () => {
		const chat = vi.fn<Parameters<ServerClient["chat"]>, ReturnType<ServerClient["chat"]>>()
			.mockResolvedValueOnce(success("first answer"))
			.mockResolvedValueOnce(failure).mockResolvedValueOnce(success("retry answer"));
		const { view, input, send } = await setup(chat);
		input.value = "first question";
		send.click();
		await flushPromises();
		input.value = "retry question";
		send.click();
		await flushPromises();
		expect(input.value).toBe("retry question");
		send.click();
		await flushPromises();
		expect(chat.mock.calls[2][2]).toEqual([
			{ role: "user", content: "first question" },
			{ role: "assistant", content: "first answer" },
			{ role: "user", content: "retry question" },
		]);
		expect(view.getMessages()).toHaveLength(4);
	});

	it("preserves a draft and the active request when changing language", async () => {
		const pending = deferred<Result>();
		const chat = vi.fn(() => pending.promise);
		const { view, root, input } = await setup(chat);
		input.value = "question";
		root.find("ai-helper-send").click();
		await flushPromises();
		input.value = "next draft";
		setLanguage("ru");
		await view.refreshLocale();
		expect(root.find("ai-helper-input").value).toBe("next draft");
		expect(root.find("ai-helper-send").disabled).toBe(false);
		expect(root.find("ai-helper-send").text).toBe("Остановить");
		input.keydown("Enter");
		await flushPromises();
		expect(chat).toHaveBeenCalledTimes(1);
		pending.resolve(success("answer"));
		await flushPromises();
		expect(view.getMessages()).toHaveLength(2);
		expect(root.find("ai-helper-send").disabled).toBe(false);
		expect(root.find("ai-helper-input").value).toBe("next draft");
	});

	it("does not overwrite a new draft when the previous request fails", async () => {
		const pending = deferred<Result>();
		const { input, send } = await setup(() => pending.promise);
		input.value = "question";
		send.click();
		await flushPromises();
		input.value = "new draft";
		pending.resolve(failure);
		await flushPromises();
		expect(input.value).toBe("new draft");
	});

	it("cancels the request when the view closes and ignores its late response", async () => {
		const pending = deferred<Result>();
		const chat = vi.fn<Parameters<ServerClient["chat"]>, ReturnType<ServerClient["chat"]>>(() => pending.promise);
		const { view, input, send } = await setup(chat);
		input.value = "question";
		send.click();
		await flushPromises();
		await view.onClose();
		expect(chat.mock.calls[0][3]?.signal?.aborted).toBe(true);
		pending.resolve(success("late answer"));
		await flushPromises();
		expect(view.getMessages()).toEqual([]);
	});

	it("discards an old Markdown render after clearing without rerendering previous messages", async () => {
		const chat = vi.fn(async () => success("first answer"));
		const { view, root, input, send } = await setup(chat);
		input.value = "first question";
		send.click();
		await flushPromises();
		const rendering = deferred<void>();
		vi.spyOn(MarkdownRenderer, "render").mockReturnValueOnce(rendering.promise);
		input.value = "second question";
		send.click();
		await flushPromises();
		root.find("ai-helper-clear-btn").click();
		rendering.resolve();
		await flushPromises();
		expect(view.getMessages()).toEqual([]);
		expect(root.find("ai-helper-messages").getText()).toBe("");
		expect(chat).toHaveBeenCalledTimes(2);
	});
});

describe("chat streaming with the real client", () => {
	function controlledStream() {
		let controller!: ReadableStreamDefaultController<Uint8Array>;
		const response = new Response(new ReadableStream<Uint8Array>({ start(value) { controller = value; } }),
			{ headers: { "Content-Type": "text/event-stream" } });
		return { response, text(content: string) {
			controller.enqueue(new TextEncoder().encode(`data: ${JSON.stringify({ choices: [{ delta: { content } }] })}\n\n`));
		}, finish(usage?: unknown) {
			controller.enqueue(new TextEncoder().encode(`data: ${JSON.stringify({ choices: [], usage })}\n\ndata: [DONE]\n\n`));
			controller.close();
		}, close() { controller.close(); } };
	}
	it("shows first text, coalesces updates, flushes final Markdown and sends each completed pair once", async () => {
		vi.useFakeTimers();
		try {
			const first = controlledStream();
			const second = controlledStream();
			const fetch = vi.fn().mockResolvedValueOnce(first.response).mockResolvedValueOnce(second.response);
			const client = createServerClient(fetch);
			const { view, root, input, send } = await setup(client.chat);
			input.value = "first"; send.click(); await flushPromises();
			input.value = "draft";
			first.text("- item"); await flushPromises();
			expect(root.getText()).toContain("- item");
			expect(view.getMessages()).toEqual([]);
			first.text("\n```ts\nconst x"); await flushPromises();
			expect(root.getText()).not.toContain("const x");
			await vi.advanceTimersByTimeAsync(100);
			expect(root.getText()).toContain("const x");
			const previousRow = root.find("ai-helper-message-model");
			first.text(" = 1;\n```"); first.finish({ total_tokens: 15 }); await flushPromises();
			expect(root.getText()).toContain(" = 1;\n```");
			expect(input.value).toBe("draft");
			input.value = "next"; send.click(); await flushPromises();
			second.text("second"); await flushPromises();
			expect(root.find("ai-helper-message-model")).toBe(previousRow);
			expect(JSON.parse(fetch.mock.calls[1][1].body).messages).toEqual([
				{ role: "user", content: "first" }, { role: "assistant", content: "- item\n```ts\nconst x = 1;\n```" },
				{ role: "user", content: "next" },
			]);
			second.finish(); await flushPromises();
			expect(root.getText()).toContain("No data");
			await view.onClose();
		} finally { vi.useRealTimers(); }
	});
	it("preserves partial text on EOF and excludes failed history", async () => {
		const stream = controlledStream();
		const fetch = vi.fn().mockResolvedValueOnce(stream.response).mockResolvedValueOnce(new Response(JSON.stringify({ choices: [{ message: { content: "next answer" } }] })));
		const { view, root, input, send } = await setup(createServerClient(fetch).chat);
		input.value = "failed question"; send.click(); await flushPromises();
		stream.text("partial answer"); await flushPromises();
		stream.close(); await flushPromises();
		expect(root.getText()).toContain("partial answer");
		expect(root.getText()).toContain("Connection closed");
		expect(view.getMessages()).toEqual([]);
		input.value = "next question"; send.click(); await flushPromises();
		expect(JSON.parse(fetch.mock.calls[1][1].body).messages).toEqual([{ role: "user", content: "next question" }]);
		await view.onClose();
	});
});

it("keeps the final message when an older streaming Markdown render resolves late", async () => {
	const pending = deferred<Result>();
	let params: Parameters<ServerClient["chat"]>[3];
	const { view, root, input, send } = await setup(async (_url, _model, _messages, value) => {
		params = value;
		return pending.promise;
	});
	input.value = "question"; send.click(); await flushPromises();
	const older = deferred<void>();
	vi.spyOn(MarkdownRenderer, "render").mockImplementationOnce(async (_app, _content, element) => {
		await older.promise;
		element.setText("stale content");
	});
	params?.onText?.("early text"); await flushPromises();
	pending.resolve(success("final text")); await flushPromises();
	expect(root.getText()).toContain("final text");
	older.resolve(); await flushPromises();
	expect(root.getText()).not.toContain("stale content");
	expect(root.getText()).toContain("final text");
	await view.onClose();
});
