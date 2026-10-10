import { afterEach, describe, expect, it, vi } from "vitest";
import type { WorkspaceLeaf } from "obsidian";
import { ChatView } from "../src/chat-view";
import type { AiHelperPlugin } from "../src/main";
import { DEFAULT_SETTINGS } from "../src/settings";
import { t, setLanguage } from "../src/i18n";
import { createServerClient, type ClientFetch } from "../src/server-client";
import { TestElement, deferred, flushPromises } from "./helpers/obsidian";

vi.mock("obsidian", async () => import("./helpers/obsidian"));
afterEach(() => { vi.restoreAllMocks(); });

const unsupported = () => error("The stream parameter is not supported.", 400);
function error(message: string, status: number) {
	return new Response(JSON.stringify({ error: { message } }), { status });
}
function answer(content = "ordinary answer") {
	return new Response(JSON.stringify({ choices: [{ message: { content } }], usage: { total_tokens: 8 } }));
}
function events(...values: unknown[]) {
	return new Response(values.map((value) => `data: ${JSON.stringify(value)}\n\n`).join(""), { headers: { "Content-Type": "text/event-stream" } });
}

describe("explicit streaming compatibility fallback", () => {
	it.each([
		"The stream parameter is not supported.",
		"Streaming is not implemented.",
		"This model does not support streaming.",
		"Unsupported parameter: 'stream'.",
		"Unknown argument: stream",
	])("retries once for explicit refusal: %s", async (message) => {
		const fetch = vi.fn().mockResolvedValueOnce(error(message, 400)).mockResolvedValueOnce(answer());
		const result = await createServerClient(fetch).chat("http://s", "m", [{ role: "user", content: "question" }]);
		expect(result).toEqual({ ok: true, value: { content: "ordinary answer", usage: { promptTokens: 0, completionTokens: 0, totalTokens: 8 } } });
		expect(fetch).toHaveBeenCalledTimes(2);
		expect(JSON.parse(fetch.mock.calls[0][1].body).stream).toBe(true);
		expect(JSON.parse(fetch.mock.calls[1][1].body).stream).toBe(false);
	});

	it("preserves model, system, history, parameters, authorization and cancellation signal", async () => {
		const fetch = vi.fn().mockResolvedValueOnce(unsupported()).mockResolvedValueOnce(answer());
		const controller = new AbortController();
		const onText = vi.fn();
		await createServerClient(fetch).chat("http://s", "selected", [
			{ role: "user", content: "previous" }, { role: "assistant", content: "reply" }, { role: "user", content: "next" },
		], { apiKey: "key", systemPrompt: "system", temperature: "0.4", maxTokens: "99", topP: "0.8", signal: controller.signal, onText });
		const initial = JSON.parse(fetch.mock.calls[0][1].body);
		const ordinary = JSON.parse(fetch.mock.calls[1][1].body);
		expect(ordinary).toEqual({ model: "selected", messages: [
			{ role: "system", content: "system" }, { role: "user", content: "previous" },
			{ role: "assistant", content: "reply" }, { role: "user", content: "next" },
		], temperature: 0.4, max_tokens: 99, top_p: 0.8, stream: false });
		delete initial.stream_options;
		expect({ ...initial, stream: false }).toEqual(ordinary);
		expect(fetch.mock.calls[1][1].headers).toEqual(fetch.mock.calls[0][1].headers);
		expect(fetch.mock.calls[1][1].signal).toBe(fetch.mock.calls[0][1].signal);
		expect(onText).toHaveBeenCalledTimes(1);
		expect(onText).toHaveBeenCalledWith("ordinary answer");
	});

	it.each([
		[400, "Invalid request"], [401, "Invalid API key"], [403, "Streaming access requires permission"],
		[404, "Model not found"], [422, "stream must be a boolean"], [429, "Rate limit reached"],
		[500, "Internal streaming error"], [501, "Not implemented"],
	])("does not retry ambiguous HTTP error %s: %s", async (status, message) => {
		const fetch = vi.fn().mockResolvedValue(error(message as string, status as number));
		expect(await createServerClient(fetch).chat("http://s", "m", [])).toEqual({ ok: false, error: { message } });
		expect(fetch).toHaveBeenCalledTimes(1);
	});

	it("does not retry network errors even if their text mentions unsupported streaming", async () => {
		const fetch = vi.fn().mockRejectedValue(new Error("streaming is not supported"));
		expect((await createServerClient(fetch).chat("http://s", "m", [])).ok).toBe(false);
		expect(fetch).toHaveBeenCalledTimes(1);
	});

	it("does not repeat again when the ordinary attempt fails", async () => {
		const fetch = vi.fn().mockResolvedValue(unsupported());
		expect((await createServerClient(fetch).chat("http://s", "m", [])).ok).toBe(false);
		expect(fetch).toHaveBeenCalledTimes(2);
	});

	it("accepts an ordinary JSON response directly without retrying", async () => {
		const fetch = vi.fn().mockResolvedValue(answer());
		expect((await createServerClient(fetch).chat("http://s", "m", [])).ok).toBe(true);
		expect(fetch).toHaveBeenCalledTimes(1);
	});

	it("allows an explicit stream error before text, but never after any text", async () => {
		const fetch = vi.fn().mockResolvedValueOnce(events({ error: { message: "Streaming is not supported" } })).mockResolvedValueOnce(answer());
		expect((await createServerClient(fetch).chat("http://s", "m", [])).ok).toBe(true);
		expect(fetch).toHaveBeenCalledTimes(2);
		const afterText = vi.fn().mockResolvedValue(events(
			{ choices: [{ delta: { content: "partial" } }] }, { error: { message: "Streaming is not supported" } },
		));
		const onText = vi.fn();
		expect((await createServerClient(afterText).chat("http://s", "m", [], { onText })).ok).toBe(false);
		expect(afterText).toHaveBeenCalledTimes(1);
		expect(onText).toHaveBeenCalledTimes(1);
		expect(onText).toHaveBeenCalledWith("partial");
	});
});

async function setup(fetch: ClientFetch) {
	setLanguage("en");
	const plugin = { settings: { ...DEFAULT_SETTINGS, serverUrl: "http://s", model: "m" }, serverClient: createServerClient(fetch), t } as unknown as AiHelperPlugin;
	const view = new ChatView({} as WorkspaceLeaf, plugin);
	await view.onOpen();
	const root = view.contentEl as unknown as TestElement;
	const input = root.find("ai-helper-input");
	const send = root.find("ai-helper-send");
	input.value = "question"; send.click(); await flushPromises();
	return { view, root, input, send };
}

describe("ordinary fallback in the chat window", () => {
	it("uses one visible pair, preserves the draft, and includes the completed pair once in the next request", async () => {
		const fallback = deferred<Response>();
		const fetch = vi.fn().mockResolvedValueOnce(unsupported()).mockReturnValueOnce(fallback.promise).mockResolvedValueOnce(answer("next answer"));
		const { view, root, input, send } = await setup(fetch);
		input.value = "next draft";
		fallback.resolve(answer()); await flushPromises();
		expect(root.find("ai-helper-messages").children).toHaveLength(2);
		expect(root.getText()).toContain("ordinary answer");
		expect(input.value).toBe("next draft");
		expect(view.getMessages()).toEqual([{ role: "user", content: "question" }, { role: "model", content: "ordinary answer" }]);
		send.click(); await flushPromises();
		expect(JSON.parse(fetch.mock.calls[2][1].body).messages).toEqual([
			{ role: "user", content: "question" }, { role: "assistant", content: "ordinary answer" }, { role: "user", content: "next draft" },
		]);
		await view.onClose();
	});

	it.each(["clear", "close"])("cancels an ordinary fallback on %s and ignores a late response", async (action) => {
		const fallback = deferred<Response>();
		const fetch = vi.fn().mockResolvedValueOnce(unsupported()).mockReturnValueOnce(fallback.promise);
		const { view, root, input } = await setup(fetch);
		input.value = "draft";
		if (action === "clear") root.find("ai-helper-clear-btn").click();
		else await view.onClose();
		expect(fetch.mock.calls[1][1].signal.aborted).toBe(true);
		fallback.resolve(answer("late answer")); await flushPromises();
		expect(root.getText()).not.toContain("late answer");
		expect(view.getMessages()).toEqual([]);
		expect(input.value).toBe("draft");
		await view.onClose();
	});

	it("does not start the fallback if clearing occurs while the refusal body is still being read", async () => {
		const body = deferred<unknown>();
		const response = unsupported();
		vi.spyOn(response, "json").mockReturnValue(body.promise);
		const fetch = vi.fn().mockResolvedValue(response);
		const { view, root } = await setup(fetch);
		root.find("ai-helper-clear-btn").click();
		body.resolve({ error: { message: "Streaming is not supported" } }); await flushPromises();
		expect(fetch).toHaveBeenCalledTimes(1);
		expect(root.find("ai-helper-messages").children).toHaveLength(0);
		await view.onClose();
	});
});
