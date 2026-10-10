import { afterEach, describe, expect, it, vi } from "vitest";
import { MarkdownRenderer, type WorkspaceLeaf } from "obsidian";
import { createServerClient } from "../src/server-client";
import { ChatView } from "../src/chat-view";
import type { AiHelperPlugin } from "../src/main";
import { DEFAULT_SETTINGS } from "../src/settings";
import { setLanguage, t } from "../src/i18n";
import { TestElement, deferred, flushPromises } from "./helpers/obsidian";

vi.mock("obsidian", async () => import("./helpers/obsidian"));
afterEach(() => { vi.restoreAllMocks(); vi.useRealTimers(); });

function stream() {
	let controller!: ReadableStreamDefaultController<Uint8Array>;
	const cancelled = vi.fn();
	const response = new Response(new ReadableStream<Uint8Array>({ start(value) { controller = value; }, cancel: cancelled }),
		{ headers: { "Content-Type": "text/event-stream" } });
	return { response, cancelled, send(data: unknown) {
		controller.enqueue(new TextEncoder().encode(`data: ${JSON.stringify(data)}\n\n`));
	}, text(content: string) { this.send({ choices: [{ delta: { content } }] }); }, finish() {
		controller.enqueue(new TextEncoder().encode("data: [DONE]\n\n"));
		controller.close();
	} };
}

describe("response idle wait", () => {
	it("waits indefinitely by default, removing the previous total timeout", async () => {
		vi.useFakeTimers();
		const pending = deferred<Response>();
		const fetch = vi.fn(() => pending.promise);
		const onText = vi.fn();
		const result = createServerClient(fetch).chat("http://s", "m", [], { onText });
		await vi.advanceTimersByTimeAsync(600_000);
		expect(fetch.mock.calls[0]).toBeDefined();
		pending.resolve(new Response(JSON.stringify({ choices: [{ message: { content: "late" } }] })));
		expect(await result).toMatchObject({ ok: true, value: { content: "late" } });
	});

	it("aborts a fetch that never sends response headers", async () => {
		vi.useFakeTimers();
		let signal: AbortSignal | undefined;
		const result = createServerClient((_url, init) => {
			signal = init?.signal as AbortSignal; return new Promise(() => {});
		}).chat("http://s", "m", [], { responseWait: "1" });
		await vi.advanceTimersByTimeAsync(1000);
		expect(await result).toMatchObject({ ok: false, error: { code: "timeout" } });
		expect(signal?.aborted).toBe(true);
	});

	it("aborts waiting for the first text including a pending JSON body", async () => {
		vi.useFakeTimers();
		const body = deferred<unknown>();
		let signal: AbortSignal | undefined;
		const client = createServerClient(async (_url, init) => {
			signal = init?.signal as AbortSignal;
			return { ok: true, headers: new Headers(), json: () => body.promise } as Response;
		});
		const onText = vi.fn();
		const result = client.chat("http://s", "m", [], { responseWait: "2", onText });
		await vi.advanceTimersByTimeAsync(2000);
		expect(await result).toMatchObject({ ok: false, error: { code: "timeout" } });
		expect(signal?.aborted).toBe(true);
		body.resolve({ choices: [{ message: { content: "too late" } }] });
		await flushPromises();
		expect(onText).not.toHaveBeenCalled();
	});

	it("resets only for new text and allows active generation beyond the interval", async () => {
		vi.useFakeTimers();
		const transport = stream();
		let signal: AbortSignal | undefined;
		const client = createServerClient(async (_url, init) => { signal = init?.signal as AbortSignal; return transport.response; });
		const params = { responseWait: "2", onText: vi.fn() };
		const result = client.chat("http://s", "m", [], params);
		await flushPromises();
		for (let i = 0; i < 5; i++) {
			await vi.advanceTimersByTimeAsync(1500);
			transport.text(String(i)); await flushPromises();
		}
		expect(signal?.aborted).toBe(false);
		params.responseWait = "";
		await vi.advanceTimersByTimeAsync(1500);
		transport.send({ choices: [{ delta: { role: "assistant", content: "" } }], usage: { total_tokens: 4 } });
		await flushPromises();
		await vi.advanceTimersByTimeAsync(500);
		expect(await result).toMatchObject({ ok: false, error: { code: "timeout" } });
		expect(signal?.aborted).toBe(true);
		expect(transport.cancelled).toHaveBeenCalled();
		expect(params.onText).toHaveBeenLastCalledWith("01234");
	});

	it("completes and clears the idle timer", async () => {
		vi.useFakeTimers();
		const transport = stream();
		const result = createServerClient(async () => transport.response).chat("http://s", "m", [], { responseWait: "1" });
		await flushPromises(); transport.text("done"); transport.finish();
		expect(await result).toMatchObject({ ok: true, value: { content: "done" } });
		expect(vi.getTimerCount()).toBe(0);
	});

	it("keeps the model-list timeout", async () => {
		vi.useFakeTimers();
		let signal: AbortSignal | undefined;
		const result = createServerClient((_url, init) => { signal = init?.signal as AbortSignal; return new Promise(() => {}); }).listModels("http://s");
		await vi.advanceTimersByTimeAsync(15_000);
		expect(await result).toMatchObject({ ok: false });
		expect(signal?.aborted).toBe(true);
	});

	it("flushes all partial text on timeout and preserves draft and request setting snapshot", async () => {
		vi.useFakeTimers(); setLanguage("ru");
		const transport = stream();
		const next = stream();
		const fetch = vi.fn().mockResolvedValueOnce(transport.response).mockResolvedValueOnce(next.response);
		const plugin = { settings: { ...DEFAULT_SETTINGS, serverUrl: "http://s", model: "m", responseWait: "1" },
			serverClient: createServerClient(fetch), t } as unknown as AiHelperPlugin;
		const view = new ChatView({} as WorkspaceLeaf, plugin); await view.onOpen();
		const root = view.contentEl as unknown as TestElement;
		const input = root.find("ai-helper-input"); const send = root.find("ai-helper-send");
		input.value = "question"; send.click(); await flushPromises();
		transport.text("first"); await flushPromises();
		await vi.advanceTimersByTimeAsync(990);
		const slowRender = deferred<void>();
		vi.spyOn(MarkdownRenderer, "render").mockImplementationOnce(async (_app, content, element) => {
			await slowRender.promise; element.setText(content);
		});
		transport.text(" pending"); await flushPromises();
		plugin.settings.responseWait = ""; input.value = "next draft";
		await vi.advanceTimersByTimeAsync(1000);
		expect(root.getText()).toContain("first pending");
		expect(root.getText()).toContain("Время ожидания текста модели истекло");
		expect(transport.cancelled).toHaveBeenCalled();
		expect(view.getMessages()).toEqual([]);
		expect(input.value).toBe("next draft");
		slowRender.resolve(); await flushPromises();
		expect(root.getText()).toContain("Время ожидания текста модели истекло");
		send.click(); await flushPromises();
		expect(JSON.parse(fetch.mock.calls[1][1].body).messages).toEqual([{ role: "user", content: "next draft" }]);
		await vi.advanceTimersByTimeAsync(5000);
		expect(fetch.mock.calls[1][1].signal.aborted).toBe(false);
		next.text("answer"); next.finish(); await flushPromises(); await view.onClose();
	});
});
