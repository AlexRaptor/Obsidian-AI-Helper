import { afterEach, describe, expect, it, vi } from "vitest";
import { MarkdownRenderer, type WorkspaceLeaf } from "obsidian";
import { ChatView } from "../src/chat-view";
import type { AiHelperPlugin } from "../src/main";
import { DEFAULT_SETTINGS } from "../src/settings";
import { t, setLanguage } from "../src/i18n";
import { createServerClient, type ClientFetch } from "../src/server-client";
import { TestElement, deferred, flushPromises } from "./helpers/obsidian";

vi.mock("obsidian", async () => import("./helpers/obsidian"));
afterEach(() => { vi.restoreAllMocks(); vi.useRealTimers(); });

function stream() {
	let controller!: ReadableStreamDefaultController<Uint8Array>;
	const response = new Response(new ReadableStream<Uint8Array>({ start(value) { controller = value; } }),
		{ headers: { "Content-Type": "text/event-stream" } });
	const write = (value: string) => controller.enqueue(new TextEncoder().encode(value));
	return { response, text(content: string) { write(`data: ${JSON.stringify({ choices: [{ delta: { content } }] })}\n\n`); },
		finish() { write("data: [DONE]\n\n"); controller.close(); },
		fail() { controller.error(new Error("connection lost")); }, close() { controller.close(); } };
}
const json = (content: string) => new Response(JSON.stringify({ choices: [{ message: { content } }] }));
async function setup(fetch: ClientFetch) {
	setLanguage("en");
	const plugin = { settings: { ...DEFAULT_SETTINGS, serverUrl: "http://s", model: "m" },
		serverClient: createServerClient(fetch), t } as unknown as AiHelperPlugin;
	const view = new ChatView({} as WorkspaceLeaf, plugin);
	await view.onOpen();
	const root = view.contentEl as unknown as TestElement;
	const input = root.find("ai-helper-input"), send = root.find("ai-helper-send");
	async function ask(text: string) { input.value = text; send.click(); await flushPromises(); }
	return { view, root, input, send, ask };
}

describe("stopping real chat streams", () => {
	it.each([false, true])("stops before/after text, flushes the last chunk and preserves draft (text=%s)", async (withText) => {
		vi.useFakeTimers();
		const current = stream();
		const fetch = vi.fn<Parameters<ClientFetch>, ReturnType<ClientFetch>>().mockResolvedValueOnce(current.response).mockResolvedValueOnce(json("next answer"));
		const { view, root, input, send, ask } = await setup(fetch);
		await ask("question");
		expect(send.disabled).toBe(false); expect(send.text).toBe("Stop");
		input.value = "next draft";
		input.keydown("Enter"); await flushPromises();
		expect(fetch).toHaveBeenCalledTimes(1); expect(send.text).toBe("Stop");
		if (withText) {
			current.text("partial"); await flushPromises();
			current.text(" latest"); await flushPromises();
			expect(root.getText()).not.toContain("latest");
		}
		send.click(); await flushPromises();
		expect(fetch.mock.calls[0][1]?.signal?.aborted).toBe(true);
		expect(root.getText()).toContain("question"); expect(root.getText()).toContain("Stopped");
		if (withText) expect(root.getText()).toContain("partial latest");
		expect(send.text).toBe("Send"); expect(input.value).toBe("next draft");
		expect(view.getMessages()).toEqual([]);
		setLanguage("ru"); await view.refreshLocale();
		expect(root.getText()).toContain("Остановлено"); expect(input.value).toBe("next draft");
		send.click(); await flushPromises();
		expect(JSON.parse(String(fetch.mock.calls[1][1]?.body)).messages).toEqual([{ role: "user", content: "next draft" }]);
		await view.onClose();
	});

	it.each(["error", "incomplete", "empty"])("preserves successful history and draft while excluding a %s attempt", async (failure) => {
		vi.useFakeTimers();
		const current = stream();
		const fetch = vi.fn<Parameters<ClientFetch>, ReturnType<ClientFetch>>().mockResolvedValueOnce(json("good answer")).mockResolvedValueOnce(current.response).mockResolvedValueOnce(json("next answer"));
		const { view, root, input, send, ask } = await setup(fetch);
		await ask("good question"); await ask("failed question"); input.value = "draft";
		if (failure !== "empty") {
			current.text("partial"); await flushPromises(); current.text(" latest"); await flushPromises();
		}
		if (failure === "error") current.fail(); else if (failure === "empty") current.finish(); else current.close();
		await flushPromises();
		expect(input.value).toBe("draft"); expect(send.text).toBe("Send");
		expect(root.getText()).toContain(failure === "empty" ? "empty message" : "partial latest");
		expect(root.getText()).toContain(failure === "error" ? "connection lost" : failure === "incomplete" ? "Connection closed" : "empty message");
		send.click(); await flushPromises();
		expect(JSON.parse(String(fetch.mock.calls[2][1]?.body)).messages).toEqual([
			{ role: "user", content: "good question" }, { role: "assistant", content: "good answer" }, { role: "user", content: "draft" },
		]);
		await view.onClose();
	});

	it("flushes stopped text immediately even while final Markdown rendering is pending", async () => {
		vi.useFakeTimers();
		const current = stream(); const fetch = vi.fn<Parameters<ClientFetch>, ReturnType<ClientFetch>>().mockResolvedValueOnce(current.response);
		const { view, root, send, ask } = await setup(fetch);
		await ask("question"); current.text("partial"); await flushPromises(); current.text(" latest"); await flushPromises();
		const rendering = deferred<void>();
		vi.spyOn(MarkdownRenderer, "render").mockImplementationOnce(async (_app, text, element) => {
			await rendering.promise; element.setText(text);
		});
		send.click();
		expect(root.getText()).toContain("partial latest"); expect(root.getText()).toContain("Stopped");
		rendering.resolve(); await flushPromises(); await view.onClose();
	});

	it("keeps stopped text and draft when reopening the same view", async () => {
		vi.useFakeTimers();
		const current = stream(); const fetch = vi.fn<Parameters<ClientFetch>, ReturnType<ClientFetch>>().mockResolvedValueOnce(current.response);
		const { view, root, input, ask } = await setup(fetch);
		await ask("question"); current.text("partial"); await flushPromises(); current.text(" latest"); await flushPromises();
		input.value = "draft"; await view.onClose();
		expect(fetch.mock.calls[0][1]?.signal?.aborted).toBe(true);
		await view.onOpen();
		expect(root.getText()).toContain("partial latest"); expect(root.getText()).toContain("Stopped");
		expect(root.find("ai-helper-input").value).toBe("draft"); expect(root.find("ai-helper-send").text).toBe("Send");
		expect(fetch).toHaveBeenCalledTimes(1); await view.onClose();
	});

	it("clears pending rendering and discards late data from a replaced request", async () => {
		const response = deferred<Response>(); const next = stream();
		const fetch = vi.fn<Parameters<ClientFetch>, ReturnType<ClientFetch>>().mockReturnValueOnce(response.promise).mockResolvedValueOnce(next.response);
		const { view, root, input, send, ask } = await setup(fetch);
		await ask("old question"); root.find("ai-helper-clear-btn").click(); await flushPromises();
		await ask("new question"); response.resolve(json("late old text")); await flushPromises();
		expect(root.getText()).not.toContain("old"); expect(send.text).toBe("Stop");
		const rendering = deferred<void>();
		vi.spyOn(MarkdownRenderer, "render").mockImplementationOnce(async (_app, _text, element) => {
			await rendering.promise; element.setText("stale rendered text");
		});
		next.text("new partial"); await flushPromises();
		root.find("ai-helper-clear-btn").click(); await flushPromises();
		input.value = "draft"; rendering.resolve(); await flushPromises();
		expect(root.find("ai-helper-messages").getText()).toBe(""); expect(input.value).toBe("draft");
		expect(view.getMessages()).toEqual([]); expect(send.text).toBe("Send"); await view.onClose();
	});
});
