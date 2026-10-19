import { expect, vi } from "vitest";
import { TFile, TFolder, type WorkspaceLeaf } from "obsidian";
import { ChatView } from "../../src/chat-view";
import type { AiHelperPlugin } from "../../src/main";
import { createServerClient, type ClientFetch } from "../../src/server-client";
import { DEFAULT_SETTINGS } from "../../src/settings";
import { setLanguage, t } from "../../src/i18n";
import { TestElement, deferred, flushPromises } from "./obsidian";

export const json = (message: object, finish_reason = "stop") => new Response(JSON.stringify({ choices: [{ message, finish_reason }] }));
export const call = (args: object = { title: "Решение", content: "# Решение\nЕдем поездом.\n\n## Открытые вопросы\nДата отправления." }, id = "вызов-1", name = "create_note") =>
	({ id, type: "function", function: { name, arguments: JSON.stringify(args) } });
export async function setup(responses: Array<Response | Promise<Response>> = []) {
	setLanguage("ru");
	const requests: Array<Record<string, any>> = [];
	const fetch: ClientFetch = async (url, init) => {
		if (!url.endsWith("/chat/completions")) return new Response("{}", { status: 404 });
		requests.push(JSON.parse(String(init?.body)));
		return await responses.shift() ?? json({ content: "Готово." });
	};
	const plugin = { settings: { ...DEFAULT_SETTINGS, serverUrl: "http://s/v1", model: "модель", contextWindow: "32000", maxTokens: "1024" }, serverClient: createServerClient(fetch), t } as unknown as AiHelperPlugin;
	const view = new ChatView({} as WorkspaceLeaf, plugin);
	const entries = new Map<string, TFile | TFolder>();
	const texts = new Map<string, string>();
	const folder = (path: string) => { const entry = Object.assign(new TFolder(), { path }); entries.set(path, entry); return entry; };
	const add = (path: string, content: string) => { const file = Object.assign(new TFile(), { path, basename: path.split("/").pop()!.slice(0, -3), extension: "md" }); entries.set(path, file); texts.set(path, content); return file; };
	const parent = vi.fn(() => folder("Входящие"));
	const create = vi.fn(async (path: string, content: string) => {
		if (entries.has(path)) throw new Error("Файл существует");
		return add(path, content);
	});
	let caseSensitive = false;
	const vault = { configDir: ".obsidian", getAbstractFileByPath: (path: string) => entries.get(path) ?? null,
		getFileByPath: (path: string) => entries.get(path) ?? null, getAllLoadedFiles: () => [...entries.values()], getMarkdownFiles: () => [...entries.values()].filter(file => file instanceof TFile),
		adapter: { exists: async (path: string) => caseSensitive ? entries.has(path) : [...entries.keys()].some(key => key.toLowerCase() === path.toLowerCase()) }, create,
		createFolder: vi.fn(async (path: string) => folder(path)), read: async (file: TFile) => texts.get(file.path)! };
	view.app = { vault, fileManager: { getNewFileParent: parent, generateMarkdownLink: (file: TFile) => `[[${file.path}]]` },
		workspace: { getActiveFile: () => ({ path: "Проекты/Обсуждение.md" }), getActiveViewOfType: () => null, getLeavesOfType: () => [] } } as any;
	await view.onOpen();
	const root = view.contentEl as unknown as TestElement;
	const input = root.find("ai-helper-input"), send = root.find("ai-helper-send");
	const settle = async () => { await vi.waitFor(() => expect(send.attributes["aria-label"]).toBe(t("send"))); await flushPromises(); };
	const ask = async (text: string) => { input.value = text; send.click(); await settle(); };
	return { view, plugin, root, input, send, ask, settle, requests, entries, texts, folder, add, parent, create, vault, setCaseSensitive() { caseSensitive = true; } };
}
