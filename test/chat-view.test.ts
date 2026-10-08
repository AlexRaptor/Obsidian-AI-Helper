import { afterEach, describe, expect, it, vi } from "vitest";
import { MarkdownRenderer, type WorkspaceLeaf } from "obsidian";
import { ChatView } from "../src/chat-view";
import type { AiHelperPlugin } from "../src/main";
import { DEFAULT_SETTINGS } from "../src/settings";
import { t, setLanguage } from "../src/i18n";
import type { ServerClient, ServerClientResult, ChatCompletionResult } from "../src/server-client";
import { TestElement, deferred, flushPromises } from "./helpers/obsidian";

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

describe("chat view request lifecycle", () => {
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
		expect(send.disabled).toBe(true);
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
		expect(root.find("ai-helper-send").disabled).toBe(true);
		expect(root.find("ai-helper-send").text).toBe("Думаю…");
		root.find("ai-helper-send").click();
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

	it("stops an old Markdown render after clearing before the next fetch", async () => {
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
		expect(chat).toHaveBeenCalledTimes(1);
	});
});
