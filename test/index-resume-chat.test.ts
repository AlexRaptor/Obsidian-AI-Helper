import { expect, it, vi } from "vitest";
import type { App, PluginManifest, WorkspaceLeaf } from "obsidian";
import { IDBFactory } from "fake-indexeddb";
import { ChatView } from "../src/chat-view";
import { AiHelperPlugin } from "../src/main";
import { createNoteSearch } from "../src/note-index";
import { createServerClient } from "../src/server-client";
import { DEFAULT_SETTINGS } from "../src/settings";
import { t, setLanguage } from "../src/i18n";
import { TestElement, Notice } from "./helpers/obsidian";
vi.mock("obsidian", async () => import("./helpers/obsidian"));

it("shows whole-vault coverage in the header, pauses and continues through accessible localized buttons", async () => {
	setLanguage("en");
	const notes = new Map([["Ready.md", "ready"], ["Pending.md", "pending"]]);
	let hold = true; let requests = 0; let finish!: (response: Response) => void;
	const response = () => new Response(JSON.stringify({ data: [{ index: 0, embedding: [1, 0] }] }));
	const client = createServerClient(async () => {
		requests++; if (hold && requests === 2) return new Promise<Response>(resolve => { finish = resolve; });
		return response();
	});
	const settings = { ...DEFAULT_SETTINGS, embeddingServerUrl: "http://s/v1", embeddingModel: "e" };
	const noteSearch = createNoteSearch({ client, factory: new IDBFactory(), vaultPath: "/coverage-chat", list: () => [...notes.keys()], read: async path => notes.get(path) ?? null, open: async () => {} });
	noteSearch.configure(settings);
	const plugin = new AiHelperPlugin({} as App, {} as PluginManifest);
	Object.assign(plugin, { settings, noteSearch, serverClient: client });
	Notice.messages.length = 0;
	const view = new ChatView({} as WorkspaceLeaf, plugin); await view.onOpen();
	const root = view.contentEl as unknown as TestElement;
	try {
		root.find("ai-helper-search-toggle").click();
		expect(root.find("ai-helper-index-title").getText()).toBe("Indexing");
		expect(root.find("ai-helper-index-action").attributes["aria-label"]).toBe("Index the vault");
		expect(root.find("ai-helper-index-action").text).toBe("");
		expect(root.find("ai-helper-index-action").attributes["data-icon"]).toBe("play");
		expect(root.find("ai-helper-send").attributes["data-icon"]).toBe("search");
		root.find("ai-helper-index-action").click();
		await vi.waitFor(() => expect(requests).toBe(2));
		expect(root.find("ai-helper-index-coverage-label").getText()).toBe("50% - 1 / 2");
		expect(root.find("ai-helper-index-bar").attributes).toMatchObject({ role: "progressbar", "aria-valuenow": "50", "aria-label": "Vault index coverage" });
		expect(root.find("ai-helper-header").getText()).toContain("50% - 1 / 2");
		root.find("ai-helper-index-pause").click(); hold = false; finish(response());
		await vi.waitFor(() => expect(noteSearch.progress.state).toBe("paused"));
		await vi.waitFor(() => expect(root.find("ai-helper-index-action").disabled).toBe(false));
		expect(Notice.messages).not.toContain(t("search-rebuild"));
		setLanguage("ru"); await view.refreshLocale();
		expect(root.find("ai-helper-index-title").getText()).toBe("Индексация");
		expect(root.find("ai-helper-index-action").attributes["aria-label"]).toBe("Продолжить индексацию");
		expect(root.find("ai-helper-index-status").getText()).toContain("Индексация приостановлена");
		root.find("ai-helper-index-action").click(); root.find("ai-helper-index-action").click();
		await vi.waitFor(() => expect(noteSearch.progress.state).toBe("complete"));
		expect(requests).toBe(3); expect(root.find("ai-helper-index-coverage-label").getText()).toBe("100% - 2 / 2");
		root.find("ai-helper-search-toggle").click(); expect(root.find("ai-helper-index-status").style.display).toBe("none");
	} finally { await view.onClose(); noteSearch.dispose(); setLanguage("en"); }
});
it("displays an offline retry, keeps normal chat available and resumes only on another search transition", async () => {
	setLanguage("en");
	let text = "original"; let offline = false; let embeddings = 0;
	const inputs: string[] = [];
	const client = createServerClient(async (url, init) => {
		if (!url.endsWith("/embeddings")) return new Response(JSON.stringify({ choices: [{ message: { content: "Normal chat works." } }] }));
		embeddings++; inputs.push(...JSON.parse(String(init?.body)).input);
		if (offline) throw new Error("offline");
		return new Response(JSON.stringify({ data: [{ index: 0, embedding: [1, 0] }] }));
	});
	const settings = { ...DEFAULT_SETTINGS, serverUrl: "http://s/v1", model: "chat", embeddingServerUrl: "http://s/v1", embeddingModel: "e", noteUpdateDelaySeconds: 0.01 };
	const noteSearch = createNoteSearch({ client, factory: new IDBFactory(), vaultPath: "/offline-chat", list: () => ["Train.md"], read: async () => text, open: async () => {} });
	noteSearch.configure(settings); await noteSearch.indexVault(); embeddings = 0; inputs.length = 0;
	const plugin = { settings, noteSearch, serverClient: client, t } as unknown as AiHelperPlugin;
	const view = new ChatView({} as WorkspaceLeaf, plugin); await view.onOpen();
	const root = view.contentEl as unknown as TestElement;
	try {
		offline = true; text = "offline edit"; await noteSearch.changed("Train.md");
		await vi.waitFor(() => expect(noteSearch.progress.state).toBe("error"));
		root.find("ai-helper-search-toggle").click();
		await vi.waitFor(() => expect(embeddings).toBe(2));
		await vi.waitFor(() => expect(noteSearch.progress.state).toBe("error"));
		expect(root.find("ai-helper-index-reason").getText()).toContain("Waiting for the embedding server");
		expect(root.find("ai-helper-index-action").attributes["aria-label"]).toBe("Retry");
		expect(root.find("ai-helper-index-action").attributes["data-icon"]).toBe("rotate-cw");
		expect(root.find("ai-helper-index-coverage-label").getText()).toBe("0% - 0 / 1");
		text = "latest text"; await noteSearch.changed("Train.md"); offline = false;
		await new Promise(resolve => setTimeout(resolve, 60)); expect(embeddings).toBe(2);
		root.find("ai-helper-search-toggle").click();
		root.find("ai-helper-input").value = "hello"; root.find("ai-helper-send").click();
		await vi.waitFor(() => expect(view.getMessages().at(-1)?.content).toBe("Normal chat works."));
		root.find("ai-helper-search-toggle").click();
		await vi.waitFor(() => expect(noteSearch.progress.state).toBe("complete"));
		expect(embeddings).toBe(3); expect(inputs[2]).toContain("latest text");
	} finally { await view.onClose(); noteSearch.dispose(); }
});
