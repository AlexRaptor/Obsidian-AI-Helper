import { expect, it } from "vitest";
import { IDBFactory } from "fake-indexeddb";
import { createNoteSearch } from "../src/note-index";
import { createServerClient } from "../src/server-client";
import { trainEmbedding } from "./fixtures/train-embeddings";
import { fileIndexAdapter } from "./helpers/file-index";

it("switches 400 completed notes to files without rewriting all vectors on every progress update", async () => {
	const adapter = fileIndexAdapter(); let bytesWritten = 0; let requests = 0;
	const write = adapter.write;
	adapter.write = async (path, text) => { bytesWritten += text.length; await write(path, text); };
	const client = createServerClient(async () => { requests++; return new Response(JSON.stringify({ data: [{ index: 0, embedding: trainEmbedding }] })); });
	const notes = Array.from({ length: 400 }, (_, index) => `Notes/${index}.md`);
	const search = createNoteSearch({ client, factory: new IDBFactory(), vaultPath: "/scale", fileStorage: { adapter, directory: ".obsidian/plugins/obsidian-ai-helper/note-index" }, list: () => notes, read: async path => `Train at 18:30. ${path}`, open: async () => {} });
	search.configure({ embeddingServerUrl: "http://s/v1", embeddingApiKey: "", embeddingModel: "e" });
	try {
		await search.indexVault();
		requests = 0;
		await search.switchStorage("file");
		await search.indexVault();
		expect(search.progress).toMatchObject({ state: "complete", completed: 400, total: 400 });
		expect(bytesWritten).toBeLessThan(50 * 1024 * 1024);
		expect(requests).toBe(400);
	} finally { search.dispose(); }
}, 15000);
