import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { MarkdownRenderer, type WorkspaceLeaf } from "obsidian";
import { ChatView } from "../src/chat-view";
import type { AiHelperPlugin } from "../src/main";
import { DEFAULT_SETTINGS } from "../src/settings";
import { t, setLanguage } from "../src/i18n";
import type { ServerClient, ServerClientResult, ChatCompletionResult } from "../src/server-client";
import { Notice, TestElement, deferred, flushPromises } from "./helpers/obsidian";

vi.mock("obsidian", async () => import("./helpers/obsidian"));

type Result = ServerClientResult<ChatCompletionResult>;
const success = (content: string): Result => ({ ok: true, value: { content } });
const failure: Result = { ok: false, error: { message: "offline" } };
const writeText = vi.fn<[string], Promise<void>>();
let views: ChatView[];

beforeEach(() => {
	setLanguage("en");
	views = [];
	writeText.mockReset().mockResolvedValue(undefined);
	Notice.messages = [];
	vi.stubGlobal("navigator", { clipboard: { writeText } });
});

afterEach(async () => {
	for (const view of views) await view.onClose();
	vi.restoreAllMocks();
	vi.unstubAllGlobals();
	vi.useRealTimers();
});

async function setup(chat: ServerClient["chat"]) {
	const plugin = {
		settings: { ...DEFAULT_SETTINGS, serverUrl: "http://s", model: "m" },
		serverClient: { chat }, t,
	} as unknown as AiHelperPlugin;
	const view = new ChatView({} as WorkspaceLeaf, plugin);
	views.push(view);
	await view.onOpen();
	const root = view.contentEl as unknown as TestElement;
	const input = root.find("ai-helper-input");
	const send = root.find("ai-helper-send");
	return { view, root, input, send };
}

const copyButton = (root: TestElement, role: "user" | "model") =>
	root.find(`ai-helper-message-${role}`).find("ai-helper-copy-message");

describe("copying chat messages", () => {
	it("copies original Markdown for both roles rather than rendered text", async () => {
		const content = "# Title\n[link](https://example.com)\n```ts\nconst x = 1;\n```";
		vi.spyOn(MarkdownRenderer, "render").mockImplementation(async (_app, _text, el) => {
			el.setText("rendered text without Markdown");
		});
		const { root, input, send } = await setup(async () => success(content));
		input.value = "**Question**\nsecond line";
		send.click(); await flushPromises();
		const user = copyButton(root, "user");
		const model = copyButton(root, "model");
		expect(model.attributes["aria-label"]).toBe("Copy message");
		expect(model.attributes.type).toBe("button");
		expect(root.find("ai-helper-message-model").getText()).toContain("rendered text");
		user.click(); await flushPromises();
		model.click(); await flushPromises();
		expect(writeText.mock.calls).toEqual([["**Question**\nsecond line"], [content]]);
	});

	it("has no waiting button, disables streaming copy and enables unchanged final content", async () => {
		const pending = deferred<Result>();
		let params: Parameters<ServerClient["chat"]>[3];
		const { root, input, send } = await setup(async (_url, _model, _messages, value) => {
			params = value;
			return pending.promise;
		});
		input.value = "question"; send.click(); await flushPromises();
		expect(() => copyButton(root, "model")).toThrow();
		copyButton(root, "user").click(); await flushPromises();
		expect(writeText).toHaveBeenCalledWith("question");
		params?.onText?.("partial"); await flushPromises();
		const button = copyButton(root, "model");
		expect(button.disabled).toBe(true);
		button.click(); expect(writeText).toHaveBeenCalledTimes(1);
		pending.resolve(success("partial")); await flushPromises();
		expect(copyButton(root, "model")).toBe(button);
		expect(button.disabled).toBe(false);
		button.click(); await flushPromises();
		expect(writeText).toHaveBeenLastCalledWith("partial");
	});

	it.each(["stop", "error"])("copies partial model text after %s without service labels", async (ending) => {
		const pending = deferred<Result>();
		let params: Parameters<ServerClient["chat"]>[3];
		const { view, root, input, send } = await setup(async (_url, _model, _messages, value) => {
			params = value;
			return pending.promise;
		});
		input.value = "question"; send.click(); await flushPromises();
		params?.onText?.("**partial**\ntext"); await flushPromises();
		if (ending === "stop") send.click();
		else pending.resolve(failure);
		await flushPromises();
		expect(view.getMessages()).toEqual([]);
		expect(root.getText()).toContain(ending === "stop" ? "Stopped" : "offline");
		copyButton(root, "model").click(); await flushPromises();
		expect(writeText).toHaveBeenCalledWith("**partial**\ntext");
	});

	it.each(["stop", "error", "empty"])("omits copy for %s without model text", async (ending) => {
		const pending = deferred<Result>();
		const { root, input, send } = await setup(() => pending.promise);
		input.value = "question"; send.click(); await flushPromises();
		if (ending === "stop") send.click();
		else pending.resolve(ending === "error" ? failure : success(""));
		await flushPromises();
		expect(() => copyButton(root, "model")).toThrow();
	});

	it("shows success only after writing and restores the icon after two seconds", async () => {
		vi.useFakeTimers();
		const writing = deferred<void>();
		writeText.mockReturnValueOnce(writing.promise);
		const { view, root, input, send } = await setup(async () => success("answer"));
		input.value = "question"; send.click(); await flushPromises();
		const button = copyButton(root, "model");
		button.click(); button.click(); await flushPromises();
		expect(writeText).toHaveBeenCalledTimes(1);
		expect(button.attributes["data-icon"]).toBe("copy");
		expect(button.disabled).toBe(true);
		writing.resolve(); await flushPromises();
		expect(button.disabled).toBe(false);
		expect(button.attributes["data-icon"]).toBe("check");
		setLanguage("ru"); await view.refreshLocale();
		expect(copyButton(root, "model")).toBe(button);
		expect(button.attributes["aria-label"]).toBe("Сообщение скопировано");
		await vi.advanceTimersByTimeAsync(1999);
		expect(button.attributes["data-icon"]).toBe("check");
		await vi.advanceTimersByTimeAsync(1);
		expect(button.attributes["data-icon"]).toBe("copy");
		expect(button.attributes.title).toBe("Копировать сообщение");
	});

	it.each(["en", "ru"] as const)("reports clipboard rejection in %s and allows retry", async (locale) => {
		writeText.mockRejectedValueOnce(new Error("denied"));
		const { view, root, input, send } = await setup(async () => success("answer"));
		setLanguage(locale); await view.refreshLocale();
		input.value = "question"; send.click(); await flushPromises();
		const button = copyButton(root, "model");
		button.click(); await flushPromises();
		expect(Notice.messages).toEqual([locale === "ru" ? "Не удалось скопировать сообщение" : "Could not copy message"]);
		expect(button.disabled).toBe(false);
		expect(button.attributes["data-icon"]).toBe("copy");
		button.click(); await flushPromises();
		expect(button.attributes["data-icon"]).toBe("check");
		expect(writeText).toHaveBeenCalledTimes(2);
	});

	it("handles an unavailable clipboard with a notification", async () => {
		vi.stubGlobal("navigator", {});
		const { root, input, send } = await setup(async () => success("answer"));
		input.value = "question"; send.click(); await flushPromises();
		const button = copyButton(root, "model");
		button.click(); await flushPromises();
		expect(Notice.messages).toEqual(["Could not copy message"]);
		expect(button.disabled).toBe(false);
	});

	it("does not restore cleared rows when a clipboard write resolves late", async () => {
		vi.useFakeTimers();
		const writing = deferred<void>();
		writeText.mockReturnValueOnce(writing.promise);
		const { root, input, send } = await setup(async () => success("answer"));
		input.value = "question"; send.click(); await flushPromises();
		copyButton(root, "model").click(); await flushPromises();
		root.find("ai-helper-clear-btn").click(); await flushPromises();
		writing.resolve(); await flushPromises();
		expect(root.find("ai-helper-messages").getText()).toBe("");
		expect(vi.getTimerCount()).toBe(0);
	});

	it("cleans up success timers on close and recreates copy buttons on reopen", async () => {
		vi.useFakeTimers();
		const { view, root, input, send } = await setup(async () => success("answer"));
		input.value = "question"; send.click(); await flushPromises();
		copyButton(root, "model").click(); await flushPromises();
		expect(vi.getTimerCount()).toBe(1);
		await view.onClose();
		expect(vi.getTimerCount()).toBe(0);
		await view.onOpen();
		const button = copyButton(root, "model");
		expect(button.attributes["data-icon"]).toBe("copy");
		button.click(); await flushPromises();
		expect(writeText).toHaveBeenCalledTimes(2);
	});
});
