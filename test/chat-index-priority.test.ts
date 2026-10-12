import { expect, it, vi } from "vitest";
import type { WorkspaceLeaf } from "obsidian";
import { IDBFactory } from "fake-indexeddb";
import { ChatView } from "../src/chat-view";
import type { AiHelperPlugin } from "../src/main";
import { createNoteSearch } from "../src/note-index";
import { createServerClient } from "../src/server-client";
import { DEFAULT_SETTINGS } from "../src/settings";
import { t, setLanguage } from "../src/i18n";
import { TestElement } from "./helpers/obsidian";
vi.mock("obsidian", async () => import("./helpers/obsidian"));

const embedding = () => new Response(JSON.stringify({ data: [{ index: 0, embedding: [1, 0] }] }));
it.each(["success", "error", "stop", "close", "pause"] as const)("lets an in-flight index request finish and gives chat priority until %s", async outcome => {
	setLanguage("en");
	const notes = new Map([["Ready.md", "ready train"], ["First.md", "first"], ["Next.md", "next"]]);
	const requests: string[] = [];
	let finishIndex!: (response: Response) => void;
	let finishChat!: (response: Response) => void;
	let indexSignal: AbortSignal | null | undefined;
	const client = createServerClient(async (url, init) => {
		const body = JSON.parse(String(init?.body));
		if (url.endsWith("/embeddings")) {
			const input = body.input[0].split("\n\n").at(-1);
			requests.push(input);
			if (input === "first") { indexSignal = init?.signal; return new Promise<Response>(resolve => { finishIndex = resolve; }); }
			return embedding();
		}
		requests.push("answer");
		return new Promise<Response>(resolve => { finishChat = resolve; });
	});
	const settings = { ...DEFAULT_SETTINGS, serverUrl: "http://s/v1", model: "chat", embeddingServerUrl: "http://s/v1", embeddingModel: "e", noteUpdateDelaySeconds: 0.01 };
	const noteSearch = createNoteSearch({ client, factory: new IDBFactory(), vaultPath: "/priority", list: () => [...notes.keys()], read: async path => notes.get(path) ?? null, open: async () => {} });
	noteSearch.configure(settings); await noteSearch.index("Ready.md");
	const view = new ChatView({} as WorkspaceLeaf, { settings, noteSearch, serverClient: client, t } as unknown as AiHelperPlugin);
	await view.onOpen(); const root = view.contentEl as unknown as TestElement;
	try {
		view.toggleSearch();
		await vi.waitFor(() => expect(requests).toContain("first"));
		root.find("ai-helper-input").value = "train?"; root.find("ai-helper-send").click();
		await new Promise(resolve => setTimeout(resolve, 30));
		expect(requests).toEqual(["ready train", "first"]); expect(indexSignal?.aborted).toBe(false);
		expect(root.getText()).toContain("train?");
		finishIndex(embedding());
		await vi.waitFor(() => expect(requests).toContain("answer"));
		expect(requests).toEqual(["ready train", "first", "train?", "answer"]);
		expect(root.find("ai-helper-index-reason").getText()).toContain("Chat has priority");
		setLanguage("ru"); await view.refreshLocale();
		expect(root.find("ai-helper-index-reason").getText()).toContain("Приоритет у чата");
		notes.set("Next.md", "latest"); await noteSearch.changed("Next.md");
		await new Promise(resolve => setTimeout(resolve, 30)); expect(requests).not.toContain("latest");
		if (outcome === "pause") {
			expect(root.find("ai-helper-index-pause").style.display).toBe("");
			root.find("ai-helper-index-pause").click();
			await vi.waitFor(() => expect(noteSearch.progress.state).toBe("paused"));
		}
		if (outcome === "stop") root.find("ai-helper-send").click();
		else if (outcome === "close") await view.onClose();
		else finishChat(outcome === "error" ? new Response("{}", { status: 500 }) : new Response(JSON.stringify({ choices: [{ message: { content: "done" } }] })));
		if (outcome === "pause") {
			await vi.waitFor(() => expect(view.getMessages()).toHaveLength(2));
			await new Promise(resolve => setTimeout(resolve, 30));
			expect(requests).not.toContain("latest"); expect(noteSearch.progress.state).toBe("paused");
			root.find("ai-helper-index-action").click();
		}
		await vi.waitFor(() => expect(requests).toContain("latest"));
		await vi.waitFor(() => expect(noteSearch.progress.state).toBe("complete"));
		expect(requests).not.toContain("next");
		if (outcome === "stop" || outcome === "close") finishChat(new Response(JSON.stringify({ choices: [{ message: { content: "late" } }] })));
		await new Promise(resolve => setTimeout(resolve, 30));
		expect(requests.filter(input => input === "latest")).toHaveLength(1);
	} finally { await view.onClose(); noteSearch.dispose(); setLanguage("en"); }
});

it.each(["paused", "offline"] as const)("chat completion never retries an index that is %s", async state => {
	let text = "original"; let offline = false; let embeddings = 0;
	const client = createServerClient(async url => {
		if (!url.endsWith("/embeddings")) return new Response(JSON.stringify({ choices: [{ message: { content: "done" } }] }));
		embeddings++; if (offline) throw new Error("offline"); return embedding();
	});
	const settings = { ...DEFAULT_SETTINGS, serverUrl: "http://s/v1", model: "chat", embeddingServerUrl: "http://s/v1", embeddingModel: "e", noteUpdateDelaySeconds: 0.01 };
	const noteSearch = createNoteSearch({ client, factory: new IDBFactory(), vaultPath: "/priority-paused", list: () => ["Note.md"], read: async () => text, open: async () => {} });
	noteSearch.configure(settings); await noteSearch.indexVault();
	if (state === "paused") await noteSearch.pause(); else offline = true;
	text = "changed"; await noteSearch.changed("Note.md");
	if (state === "offline") await vi.waitFor(() => expect(noteSearch.progress.state).toBe("error"));
	offline = false; const before = embeddings;
	const view = new ChatView({} as WorkspaceLeaf, { settings, noteSearch, serverClient: client, t } as unknown as AiHelperPlugin);
	await view.onOpen(); const root = view.contentEl as unknown as TestElement;
	try {
		root.find("ai-helper-input").value = "hello"; root.find("ai-helper-send").click();
		await vi.waitFor(() => expect(view.getMessages()).toHaveLength(2));
		await new Promise(resolve => setTimeout(resolve, 40));
		expect(embeddings).toBe(before); expect(noteSearch.progress.state).toBe(state === "paused" ? "paused" : "error");
		await noteSearch.resume(true); expect(embeddings).toBe(before + 1);
	} finally { await view.onClose(); noteSearch.dispose(); }
});

it("holds the next batch of a long note, retains completed batches and ignores late releases after disposal", async () => {
	let requests = 0; let finish!: (response: Response) => void;
	const response = (count: number) => new Response(JSON.stringify({ data: Array.from({ length: count }, (_, index) => ({ index, embedding: [1, 0] })) }));
	const client = createServerClient(async (_url, init) => {
		requests++; const count = JSON.parse(String(init?.body)).input.length;
		if (requests > 1) await new Promise(resolve => setTimeout(resolve, 40));
		if (requests === 1) return new Promise<Response>(resolve => { finish = () => resolve(response(count)); });
		return response(count);
	});
	const noteSearch = createNoteSearch({ client, factory: new IDBFactory(), vaultPath: "/priority-batches", list: () => ["Long.md"], read: async () => "long text ".repeat(900), open: async () => {} });
	noteSearch.configure({ ...DEFAULT_SETTINGS, embeddingServerUrl: "http://s/v1", embeddingModel: "e", noteFragmentSize: 256, noteFragmentOverlap: 0, noteUpdateDelaySeconds: 0.01, autoUpdateNotes: true });
	const indexing = noteSearch.indexVault();
	await vi.waitFor(() => expect(requests).toBe(1));
	const first = noteSearch.acquireChatPriority(); const second = noteSearch.acquireChatPriority();
	finish(embedding()); await first.ready;
	await new Promise(resolve => setTimeout(resolve, 30)); expect(requests).toBe(1);
	first.release(); first.release();
	await new Promise(resolve => setTimeout(resolve, 30)); expect(requests).toBe(1);
	second.release(); await indexing;
	expect(requests).toBe(3); expect(noteSearch.progress.state).toBe("complete");
	const late = noteSearch.acquireChatPriority();
	const pending = noteSearch.indexVault().catch(error => error);
	await new Promise(resolve => setTimeout(resolve, 30)); expect(requests).toBe(3);
	noteSearch.dispose(); late.release();
	await expect(pending).resolves.toMatchObject({ code: "search-rebuild" });
	await new Promise(resolve => setTimeout(resolve, 30)); expect(requests).toBe(3);
});
