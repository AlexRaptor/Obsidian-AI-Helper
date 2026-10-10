import { describe, expect, it } from "vitest";
import { IDBFactory } from "fake-indexeddb";
import { createNoteSearch } from "../src/note-index";
import { createServerClient } from "../src/server-client";

function fixture(factory = new IDBFactory(), vaultPath = "/notes") {
	const notes = new Map([["Train.md", "The train departs at 18:30."]]);
	const requests: string[][] = [];
	const client = createServerClient(async (_url, init) => {
		const body = JSON.parse(String(init?.body));
		requests.push(body.input);
		return new Response(JSON.stringify({ data: body.input.map((_: string, index: number) => ({ index, embedding: [1, 0] })) }));
	});
	const options = { vaultPath, factory, client, read: async (path: string) => notes.get(path) ?? null, open: async (_path: string) => {} };
	const connection = { embeddingServerUrl: "http://s/v1", embeddingApiKey: "", embeddingModel: "e" };
	const search = createNoteSearch(options);
	search.configure(connection);
	return { search, notes, requests, options, connection };
}

describe("single note search", () => {
	it("explicitly indexes one note, restores it after restart and isolates another vault", async () => {
		const { search, options, connection, requests } = fixture();
		await search.index("Train.md");
		const restored = createNoteSearch(options); restored.configure(connection);
		expect(await restored.search("When does the train depart?")).toEqual({ path: "Train.md", text: "The train departs at 18:30." });
		expect(requests).toEqual([["The train departs at 18:30."], ["When does the train depart?"]]);
		const other = createNoteSearch({ ...options, vaultPath: "/other/notes" }); other.configure(connection);
		await expect(other.search("When?")).rejects.toMatchObject({ code: "search-rebuild" });
	});
});

it.each(["changed", "deleted", "renamed"])("rejects a %s note after restoring the persisted index", async (change) => {
	const { search, notes, options, connection } = fixture(); await search.index("Train.md");
	if (change === "changed") notes.set("Train.md", "The train now departs at 19:00.");
	else { notes.delete("Train.md"); if (change === "renamed") notes.set("New.md", "The train departs at 18:30."); }
	const restored = createNoteSearch(options); restored.configure(connection);
	await expect(restored.search("When?")).rejects.toMatchObject({ code: "search-rebuild" });
});

it.each(["embeddingModel", "embeddingServerUrl", "embeddingApiKey"] as const)("invalidates on a change to %s, including changing back", async (key) => {
	const { search, connection } = fixture(); await search.index("Train.md");
	search.configure({ ...connection, [key]: "different" }); search.configure(connection);
	await expect(search.search("When?")).rejects.toMatchObject({ code: "search-rebuild" });
	await search.index("Train.md"); expect(await search.search("When?")).not.toBeNull();
});

it("does not index a long note or use unavailable storage", async () => {
	const { search, notes, options, connection, requests } = fixture();
	notes.set("Long.md", "a".repeat(4001));
	await expect(search.index("Long.md")).rejects.toMatchObject({ code: "search-long" }); expect(requests).toEqual([]);
	const unavailable = createNoteSearch({ ...options, factory: undefined }); unavailable.configure(connection);
	await expect(unavailable.index("Train.md")).rejects.toMatchObject({ code: "search-storage" });
});

it("rejects a note changed while its embedding is pending", async () => {
	const { options, notes, connection } = fixture();
	let resolve!: (response: Response) => void;
	let started!: () => void;
	const ready = new Promise<void>((done) => { started = done; });
	const client = createServerClient(async () => { started(); return new Promise<Response>((done) => { resolve = done; }); });
	const search = createNoteSearch({ ...options, client }); search.configure(connection);
	const indexing = search.index("Train.md"); await ready; notes.delete("Train.md");
	resolve(new Response(JSON.stringify({ data: [{ index: 0, embedding: [1, 0] }] })));
	await expect(indexing).rejects.toMatchObject({ code: "search-rebuild" });
	await expect(search.search("When?")).rejects.toMatchObject({ code: "search-rebuild" });
});

it("reports no suitable information for an unrelated embedding", async () => {
	const { options, connection } = fixture();
	let calls = 0;
	const client = createServerClient(async () => new Response(JSON.stringify({ data: [{ index: 0, embedding: ++calls === 1 ? [1, 0] : [0, 1] }] })));
	const search = createNoteSearch({ ...options, client }); search.configure(connection);
	await search.index("Train.md"); expect(await search.search("Unrelated question")).toBeNull();
});
