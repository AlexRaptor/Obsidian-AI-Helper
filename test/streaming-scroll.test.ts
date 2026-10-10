import { afterEach, describe, expect, it, vi } from "vitest";
import { MarkdownRenderer, type WorkspaceLeaf } from "obsidian";
import { ChatView } from "../src/chat-view";
import type { AiHelperPlugin } from "../src/main";
import { DEFAULT_SETTINGS } from "../src/settings";
import { t, setLanguage } from "../src/i18n";
import { createServerClient } from "../src/server-client";
import { TestElement, deferred, flushPromises } from "./helpers/obsidian";

vi.mock("obsidian", async () => import("./helpers/obsidian"));

class ControlledResizeObserver {
	static instances: ControlledResizeObserver[] = [];
	observed = new Set<unknown>();
	constructor(private callback: () => void) { ControlledResizeObserver.instances.push(this); }
	observe(element: unknown): void { this.observed.add(element); }
	unobserve(element: unknown): void { this.observed.delete(element); }
	disconnect(): void { this.observed.clear(); }
	static resize(element: unknown): void {
		for (const observer of this.instances) if (observer.observed.has(element)) observer.callback();
	}
}

afterEach(() => {
	vi.restoreAllMocks();
	vi.unstubAllGlobals();
	vi.useRealTimers();
	ControlledResizeObserver.instances = [];
});

function stream() {
	let controller!: ReadableStreamDefaultController<Uint8Array>;
	const response = new Response(new ReadableStream<Uint8Array>({ start(value) { controller = value; } }),
		{ headers: { "Content-Type": "text/event-stream" } });
	return {
		response,
		text(content: string) { controller.enqueue(new TextEncoder().encode(`data: ${JSON.stringify({ choices: [{ delta: { content } }] })}\n\n`)); },
		finish() { controller.enqueue(new TextEncoder().encode("data: [DONE]\n\n")); controller.close(); },
		fail() { controller.close(); },
	};
}

async function setup() {
	vi.useFakeTimers();
	vi.stubGlobal("ResizeObserver", ControlledResizeObserver);
	setLanguage("en");
	const current = stream();
	const fetch = vi.fn().mockResolvedValue(current.response);
	const plugin = {
		settings: { ...DEFAULT_SETTINGS, serverUrl: "http://s", model: "m" },
		serverClient: createServerClient(fetch), t,
	} as unknown as AiHelperPlugin;
	const view = new ChatView({} as WorkspaceLeaf, plugin);
	await view.onOpen();
	const root = view.contentEl as unknown as TestElement;
	const messages = root.find("ai-helper-messages");
	const input = root.find("ai-helper-input");
	messages.clientHeight = 300;
	messages.scrollHeight = 1000;
	messages.scrollTop = 700;
	input.value = "question";
	root.find("ai-helper-send").click();
	await flushPromises();
	return { view, root, messages, input, current, fetch };
}

function scroll(element: TestElement, top: number): void {
	element.scrollTop = top;
	element.dispatchEvent({ type: "scroll" });
}

async function update(current: ReturnType<typeof stream>, text: string): Promise<void> {
	current.text(text);
	await flushPromises();
	await vi.advanceTimersByTimeAsync(100);
}

describe("streaming chat scroll behavior", () => {
	it("follows growing Markdown at the bottom, including later code-block layout changes", async () => {
		const { view, root, messages, input, current } = await setup();
		input.value = "next draft";
		messages.scrollHeight = 1400;
		await update(current, "- item\n```ts\nconst value");
		expect(messages.scrollTop).toBe(1100);
		const row = root.find("ai-helper-message-model");
		messages.scrollHeight = 1700;
		ControlledResizeObserver.resize(row);
		expect(messages.scrollTop).toBe(1400);
		messages.scrollHeight = 1800;
		await update(current, " = 1;\n```");
		expect(messages.scrollTop).toBe(1500);
		expect(root.find("ai-helper-message-model")).toBe(row);
		expect(input.value).toBe("next draft");
		current.finish(); await flushPromises();
		await view.onClose();
	});

	it("preserves reading position after scrolling up, and resumes after returning down", async () => {
		const { view, root, messages, current } = await setup();
		await update(current, "start");
		const row = root.find("ai-helper-message-model");
		scroll(messages, 100);
		messages.scrollHeight = 1400;
		await update(current, "\n- more");
		expect(messages.scrollTop).toBe(100);
		messages.scrollHeight = 1700;
		ControlledResizeObserver.resize(row);
		expect(messages.scrollTop).toBe(100);
		scroll(messages, 1400);
		messages.scrollHeight = 2000;
		await update(current, "\n```ts\ncode\n```");
		expect(messages.scrollTop).toBe(1700);
		current.finish(); await flushPromises();
		await view.onClose();
	});

	it("honors a scroll up while final Markdown is rendering asynchronously", async () => {
		const { view, root, messages, current } = await setup();
		await update(current, "partial");
		const render = deferred<void>();
		vi.spyOn(MarkdownRenderer, "render").mockImplementationOnce(async (_app, content, element) => {
			await render.promise;
			element.setText(content);
			messages.scrollHeight = 1800;
		});
		// This last part is flushed by completion, bypassing the batching timer.
		current.text(" final"); current.finish(); await flushPromises();
		scroll(messages, 150);
		render.resolve(); await flushPromises();
		expect(root.getText()).toContain("partial final");
		expect(messages.scrollTop).toBe(150);
		ControlledResizeObserver.resize(root.find("ai-helper-message-model"));
		expect(messages.scrollTop).toBe(150);
		await view.onClose();
	});

	it("keeps the reading position and next draft when partial text ends with an error", async () => {
		const { view, root, messages, input, current } = await setup();
		await update(current, "partial answer");
		scroll(messages, 200);
		input.value = "another draft";
		messages.scrollHeight = 1600;
		current.fail(); await flushPromises();
		expect(root.getText()).toContain("Connection closed");
		expect(messages.scrollTop).toBe(200);
		expect(input.value).toBe("another draft");
		await view.onClose();
	});

	it("keeps old message rows and the draft stable during updates in a long dialog", async () => {
		vi.useFakeTimers();
		vi.stubGlobal("ResizeObserver", ControlledResizeObserver);
		setLanguage("en");
		const current = stream();
		const fetch = vi.fn();
		for (let i = 0; i < 40; i++) fetch.mockResolvedValueOnce(new Response(JSON.stringify({ choices: [{ message: { content: `answer ${i}` } }] })));
		fetch.mockResolvedValueOnce(current.response);
		const plugin = {
			settings: { ...DEFAULT_SETTINGS, serverUrl: "http://s", model: "m" },
			serverClient: createServerClient(fetch), t,
		} as unknown as AiHelperPlugin;
		const view = new ChatView({} as WorkspaceLeaf, plugin);
		await view.onOpen();
		const root = view.contentEl as unknown as TestElement;
		const input = root.find("ai-helper-input");
		const send = root.find("ai-helper-send");
		for (let i = 0; i < 40; i++) { input.value = `question ${i}`; send.click(); await flushPromises(); }
		const messages = root.find("ai-helper-messages");
		const oldRows = [...messages.children];
		messages.clientHeight = 300;
		messages.scrollHeight = 10000;
		scroll(messages, 9700);
		input.value = "last question"; send.click(); await flushPromises();
		scroll(messages, 500);
		input.value = "working draft";
		messages.scrollHeight = 11000;
		await update(current, "new text\n- list\n```ts\ncode");
		current.text("\n```"); current.finish(); await flushPromises();
		oldRows.forEach((row, index) => expect(messages.children[index]).toBe(row));
		expect(messages.scrollTop).toBe(500);
		expect(input.value).toBe("working draft");
		expect(root.getText()).toContain("answer 0");
		expect(root.getText()).toContain("new text");
		await view.onClose();
		expect(ControlledResizeObserver.instances.every((observer) => observer.observed.size === 0)).toBe(true);
	});
});
