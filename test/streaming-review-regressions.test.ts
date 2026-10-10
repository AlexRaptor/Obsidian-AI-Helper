import { afterEach, expect, it, vi } from "vitest";
import type { WorkspaceLeaf } from "obsidian";
import { ChatView } from "../src/chat-view";
import type { AiHelperPlugin } from "../src/main";
import { createServerClient } from "../src/server-client";
import { DEFAULT_SETTINGS } from "../src/settings";
import { t, setLanguage, ru } from "../src/i18n";
import { deferred, flushPromises, TestElement } from "./helpers/obsidian";

vi.mock("obsidian", async () => import("./helpers/obsidian"));
afterEach(() => { vi.useRealTimers(); setLanguage("en"); });
const data = (value: unknown, separator = "\n\n") => `data: ${JSON.stringify(value)}${separator}`;
const delta = (content: string, finish_reason?: string) => ({ choices: [{ index: 0, delta: { content }, finish_reason }] });

function controlled() {
	let controller!: ReadableStreamDefaultController<Uint8Array>;
	const handshake = deferred<void>();
	const cancel = vi.fn(() => handshake.promise);
	const response = new Response(new ReadableStream<Uint8Array>({ start(value) { controller = value; }, cancel }),
		{ headers: { "Content-Type": "text/event-stream" } });
	return { response, cancel, handshake, send(text: string) { controller.enqueue(new TextEncoder().encode(text)); } };
}

it.each([undefined, "1"])("finalizes a finish reason on an open connection with wait %s", async (responseWait) => {
	vi.useFakeTimers();
	const transport = controlled();
	let settled = false;
	const result = createServerClient(async () => transport.response).chat("http://s", "m", [], { responseWait }).then((value) => {
		settled = true; return value;
	});
	await flushPromises(); transport.send(data(delta("final", "stop"))); await flushPromises();
	expect(settled).toBe(true);
	expect(await result).toMatchObject({ ok: true, value: { content: "final", usage: undefined } });
	expect(transport.cancel).toHaveBeenCalled();
	expect(vi.getTimerCount()).toBe(0);
	await vi.advanceTimersByTimeAsync(5000);
	transport.handshake.resolve();
});

it("retains terminal usage in the finishing transport chunk", async () => {
	const transport = controlled();
	const result = createServerClient(async () => transport.response).chat("http://s", "m", []);
	transport.send(data(delta("answer", "stop")) + data({ choices: [], usage: { prompt_tokens: 2, completion_tokens: 3, total_tokens: 5 } }) + "data: [DONE]\n\n");
	expect(await result).toEqual({ ok: true, value: { content: "answer", usage: { promptTokens: 2, completionTokens: 3, totalTokens: 5 } } });
	transport.handshake.resolve();
});

it("ignores extra text after a confirmed finish", async () => {
	const transport = controlled();
	const onText = vi.fn();
	const result = createServerClient(async () => transport.response).chat("http://s", "m", [], { onText });
	transport.send(data(delta("answer", "stop")) + data(delta("duplicate")));
	expect(await result).toMatchObject({ ok: true, value: { content: "answer" } });
	expect(onText).toHaveBeenCalledTimes(1);
	transport.handshake.resolve();
});

it.each(["\n\r", "\r\n\r", "\r\n\n", "\r\r\n", "\n\r\n"])("accepts mixed SSE line endings %j split at every byte", async (separator) => {
	const bytes = new TextEncoder().encode(data(delta("Привет 🌍"), separator) +
		data({ choices: [], usage: { total_tokens: 8 } }, separator) + `data: [DONE]${separator}`);
	const onText = vi.fn();
	const client = createServerClient(async () => new Response(new ReadableStream({ start(controller) {
		for (const byte of bytes) controller.enqueue(new Uint8Array([byte]));
		controller.close();
	} }), { headers: { "Content-Type": "text/event-stream" } }));
	expect(await client.chat("http://s", "m", [], { onText })).toMatchObject({ ok: true, value: { content: "Привет 🌍", usage: { totalTokens: 8 } } });
	expect(onText).toHaveBeenCalledTimes(1);
	expect(onText).toHaveBeenCalledWith("Привет 🌍");
});

async function open(response: Response, responseWait = "") {
	const plugin = { settings: { ...DEFAULT_SETTINGS, model: "m", serverUrl: "http://s", responseWait },
		serverClient: createServerClient(async () => response), t } as unknown as AiHelperPlugin;
	const view = new ChatView({} as WorkspaceLeaf, plugin); await view.onOpen();
	const root = view.contentEl as unknown as TestElement;
	const input = root.find("ai-helper-input"); const send = root.find("ai-helper-send");
	input.value = "question"; send.click(); await flushPromises();
	return { view, root, input, send };
}

it("immediately flushes the final text and switches Stop to Send after a finish event", async () => {
	vi.useFakeTimers(); setLanguage("en");
	const transport = controlled();
	const { view, root, input, send } = await open(transport.response, "1");
	transport.send(data(delta("early"))); await flushPromises();
	input.value = "draft";
	transport.send(data(delta(" final", "stop"))); await flushPromises();
	expect(root.getText()).toContain("early final");
	expect(send.text).toBe("Send");
	expect(input.value).toBe("draft");
	expect(view.getMessages()).toEqual([{ role: "user", content: "question" }, { role: "model", content: "early final" }]);
	await vi.advanceTimersByTimeAsync(2000);
	expect(root.getText()).not.toContain("expired");
	transport.handshake.resolve(); await view.onClose();
});

it.each([
	["[]", ru["chat-invalid-stream"]],
	["not JSON", ru["chat-invalid-stream"]],
	[JSON.stringify({ error: {} }), ru["chat-stream-error"]],
	[JSON.stringify({ error: { message: "Server-specific detail" } }), "Server-specific detail"],
])("localizes plugin stream errors but preserves server messages: %s", async (payload, expected) => {
	setLanguage("ru");
	const transport = controlled();
	const { view, root } = await open(transport.response);
	transport.send(`data: ${payload}\n\n`); await flushPromises();
	expect(root.getText()).toContain(expected);
	expect(root.getText()).not.toContain("Model server returned");
	expect(view.getMessages()).toEqual([]);
	transport.handshake.resolve(); await view.onClose();
});

it.each(["0", "-1", "1.5", "abc", "1e3", "9007199254740992"])("validates response wait at the request boundary: %s", async (responseWait) => {
	const fetch = vi.fn();
	expect(await createServerClient(fetch).chat("http://s", "m", [], { responseWait })).toMatchObject({ ok: false, error: { code: "invalid-response-wait" } });
	expect(fetch).not.toHaveBeenCalled();
});

it("does not treat a stream_options refusal as refusal of streaming itself", async () => {
	const fetch = vi.fn(async () => new Response(JSON.stringify({ error: { message: "Unsupported parameter: stream_options" } }), { status: 400 }));
	expect(await createServerClient(fetch).chat("http://s", "m", [])).toMatchObject({ ok: false, error: { message: "Unsupported parameter: stream_options" } });
	expect(fetch).toHaveBeenCalledTimes(1);
});
