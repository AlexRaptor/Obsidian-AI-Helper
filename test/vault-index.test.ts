import { expect, it, vi } from "vitest";
import { IDBFactory } from "fake-indexeddb";
import { createNoteSearch } from "../src/note-index";
import { createServerClient } from "../src/server-client";

const connection = { embeddingServerUrl: "http://s/v1", embeddingApiKey: "", embeddingModel: "e" };
function fixture() {
	const notes = new Map([
		["Private/secret.md", "secret"], ["Private/nested/hidden.md", "hidden"],
		["Private-public/train.md", "train"], ["Travel/boat.md", "boat ![[Private/secret.md]]"],
		["Travel/map.canvas", "canvas"], ["Travel/photo.png", "photo"], ["Travel/manual.pdf", "pdf"],
	]);
	const inputs: string[] = [];
	const read = vi.fn(async (path: string) => notes.get(path) ?? null);
	const client = createServerClient(async (_url, init) => {
		const { input } = JSON.parse(String(init?.body)); inputs.push(...input);
		return new Response(JSON.stringify({ data: input.map((text: string, index: number) => ({ index, embedding: text.includes("boat") ? [0, 1] : [1, 0] })) }));
	});
	const environment = { factory: new IDBFactory(), vaultPath: "/vault", client, read, list: () => [...notes.keys()], open: vi.fn(async () => {}) };
	const search = createNoteSearch(environment);
	search.configure({ ...connection, excludedFolders: ["/Private/"] });
	return { search, environment, read, inputs };
}

it("indexes allowed Markdown subtrees without reading exclusions, attachments or embedded targets", async () => {
	const { search, environment, read, inputs } = fixture();
	await search.indexVault();
	expect(new Set(read.mock.calls.map(([path]) => path))).toEqual(new Set(["Private-public/train.md", "Travel/boat.md"]));
	expect(inputs.join("\n")).not.toContain("hidden");
	expect(await search.search("boat")).toMatchObject({ path: "Travel/boat.md" });
	expect(await search.search("train")).toMatchObject({ path: "Private-public/train.md" });
	const restored = createNoteSearch(environment); restored.configure({ ...connection, excludedFolders: ["Private"] });
	expect(await restored.search("boat")).toMatchObject({ path: "Travel/boat.md" });
	expect(restored.progress).toMatchObject({ state: "complete", completed: 2, total: 2 });
});

it("searches and restores the completed part while a later note is pending", async () => {
	const { environment } = fixture();
	let finish!: (response: Response) => void;
	let pending = false;
	const client = createServerClient(async (_url, init) => {
		const { input } = JSON.parse(String(init?.body));
		if (input[0].includes("boat.md")) { pending = true; return new Promise<Response>((resolve) => { finish = resolve; }); }
		return new Response(JSON.stringify({ data: [{ index: 0, embedding: [1, 0] }] }));
	});
	const search = createNoteSearch({ ...environment, client }); search.configure({ ...connection, excludedFolders: ["Private"] });
	const indexing = search.indexVault();
	await vi.waitFor(() => expect(pending).toBe(true));
	expect(search.progress).toMatchObject({ state: "indexing", completed: 1, total: 2 });
	expect(await search.search("train")).toMatchObject({ path: "Private-public/train.md", partial: true });
	const restored = createNoteSearch({ ...environment, client }); restored.configure({ ...connection, excludedFolders: ["Private"] });
	expect(await restored.search("train")).toMatchObject({ path: "Private-public/train.md", partial: true });
	expect(restored.progress).toMatchObject({ state: "partial", completed: 1, total: 2 });
	finish(new Response(JSON.stringify({ data: [{ index: 0, embedding: [0, 1] }] })));
	await indexing;
	expect(search.progress).toMatchObject({ state: "complete", completed: 2, total: 2 });
});

it("blocks processed sources immediately and discards a late embedding after exclusion", async () => {
	const { search, environment, read } = fixture();
	await search.index("Private-public/train.md");
	const source = (await search.search("train"))!;
	let finish!: (response: Response) => void;
	let pending = false;
	const client = createServerClient(async () => { pending = true; return new Promise<Response>((resolve) => { finish = resolve; }); });
	const active = createNoteSearch({ ...environment, client }); active.configure({ ...connection, excludedFolders: ["Private"] });
	const indexing = active.indexVault();
	const rejected = expect(indexing).rejects.toMatchObject({ code: "search-rebuild" });
	await vi.waitFor(() => expect(pending).toBe(true));
	active.configure({ ...connection, excludedFolders: ["Private", "Private-public"] });
	read.mockClear();
	await expect(active.open(source)).rejects.toMatchObject({ code: "search-excluded" });
	expect(read).not.toHaveBeenCalled();
	finish(new Response(JSON.stringify({ data: [{ index: 0, embedding: [1, 0] }] })));
	await rejected;
	await expect(active.search("train")).rejects.toMatchObject({ code: "search-rebuild" });
	const restored = createNoteSearch(environment); restored.configure(connection);
	await expect(restored.search("train")).rejects.toMatchObject({ code: "search-rebuild" });
});

it("deletes the index and rejects late results without changing any notes", async () => {
	const { search, environment } = fixture(); await search.indexVault();
	const contents = await environment.read("Travel/boat.md");
	await search.clear();
	await expect(search.search("boat")).rejects.toMatchObject({ code: "search-rebuild" });
	expect(await environment.read("Travel/boat.md")).toBe(contents);
	await search.rebuild();
	expect(await search.search("boat")).toMatchObject({ path: "Travel/boat.md", partial: false });
});

it("restores progress on opening the module before a search and removes saved exclusions", async () => {
	const { search, environment } = fixture(); await search.indexVault();
	const restored = createNoteSearch(environment);
	restored.configure({ ...connection, excludedFolders: ["Private", "Travel"] });
	await restored.restore();
	expect(restored.progress.state).toBe("partial");
	const reopened = createNoteSearch(environment); reopened.configure(connection);
	expect(await reopened.search("boat")).toBeNull();
	expect(await reopened.search("train")).toMatchObject({ path: "Private-public/train.md" });
});

it.each(["clear", "dispose"] as const)("does not restore pending fragments after %s", async (action) => {
	const { environment } = fixture();
	let finish!: (response: Response) => void;
	let pending = false;
	const client = createServerClient(async () => { pending = true; return new Promise<Response>((resolve) => { finish = resolve; }); });
	const search = createNoteSearch({ ...environment, client }); search.configure(connection);
	const indexing = search.index("Travel/boat.md");
	const rejected = expect(indexing).rejects.toMatchObject({ code: "search-rebuild" });
	await vi.waitFor(() => expect(pending).toBe(true));
	await search[action]();
	finish(new Response(JSON.stringify({ data: [{ index: 0, embedding: [1, 0] }] })));
	await rejected;
	const restored = createNoteSearch(environment); restored.configure(connection);
	await expect(restored.search("boat")).rejects.toMatchObject({ code: "search-rebuild" });
});

it("preserves completed notes and error progress after a server failure", async () => {
	const { environment } = fixture();
	const client = createServerClient(async (_url, init) => {
		const { input } = JSON.parse(String(init?.body));
		if (input[0].includes("boat.md")) throw new Error("offline");
		return new Response(JSON.stringify({ data: [{ index: 0, embedding: [1, 0] }] }));
	});
	const search = createNoteSearch({ ...environment, client }); search.configure({ ...connection, excludedFolders: ["Private"] });
	await expect(search.indexVault()).rejects.toMatchObject({ code: "search-failed" });
	const restored = createNoteSearch({ ...environment, client }); restored.configure({ ...connection, excludedFolders: ["Private"] });
	await restored.restore();
	expect(restored.progress).toMatchObject({ state: "error", completed: 1, total: 2, error: "search-failed" });
	expect(await restored.search("train")).toMatchObject({ path: "Private-public/train.md", partial: true });
});

it("updates live progress after removing a processed folder and resets it on incompatible settings", async () => {
	const { search } = fixture(); await search.indexVault();
	search.configure({ ...connection, excludedFolders: ["Private", "Travel"] });
	await vi.waitFor(() => expect(search.progress).toMatchObject({ state: "partial", completed: 1, total: 2 }));
	search.configure({ ...connection, embeddingModel: "new-model", excludedFolders: ["Private", "Travel"] });
	expect(search.progress).toMatchObject({ state: "idle", completed: 0, total: 0 });
});
