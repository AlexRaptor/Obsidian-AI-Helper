import { expect, it, vi } from "vitest";
import { IDBFactory } from "fake-indexeddb";
import { createNoteSearch } from "../src/note-index";
import { createServerClient } from "../src/server-client";
const connection = { embeddingServerUrl: "http://s/v1", embeddingApiKey: "", embeddingModel: "e" };
function fixture() {
	const notes = new Map([["Train.md", "old train"], ["Other.md", "boat"]]);
	const inputs: string[] = []; let offline = false;
	const client = createServerClient(async (_url, init) => {
	 const { input } = JSON.parse(String(init?.body)); inputs.push(...input);
	 if (offline) throw new Error("offline");
	 return new Response(JSON.stringify({ data: [{ index: 0, embedding: input[0].includes("boat") ? [0, 1] : [1, 0] }] }));
	});
	const environment = { vaultPath: "/updates", factory: new IDBFactory(), client, read: async (path: string) => notes.get(path) ?? null, list: () => [...notes.keys()], open: vi.fn(async () => {}) };
	const search = createNoteSearch(environment); search.configure(connection);
	return { notes, inputs, environment, search, offline: (value: boolean) => { offline = value; } };
}
it("coalesces edits and creates only affected notes after explicit indexing", async () => {
	const { search, notes, inputs } = fixture(); await search.indexVault(); inputs.length = 0;
	notes.set("Train.md", "first edit"); await search.changed("Train.md");
	notes.set("Train.md", "last edit"); await search.changed("Train.md");
	notes.set("New.md", "new note"); await search.changed("New.md");
	expect(search.progress.state).toBe("partial");
	await vi.waitFor(() => expect(search.progress.state).toBe("complete"));
	expect(inputs).toHaveLength(2); expect(inputs.join(" ")).toContain("last edit");
	expect(inputs.join(" ")).not.toContain("first edit"); expect(inputs.join(" ")).not.toContain("boat"); search.dispose();
});
it("persists latest edits offline without reconnecting on events and reconciles on resume", async () => {
	const { search, notes, inputs, offline, environment } = fixture(); await search.indexVault(); offline(true); inputs.length = 0;
	notes.set("Train.md", "offline edit"); await search.changed("Train.md");
	await vi.waitFor(() => expect(search.progress.state).toBe("error")); expect(inputs).toHaveLength(1);
	notes.set("Train.md", "latest offline edit"); await search.changed("Train.md");
	notes.set("New.md", "new offline note"); await search.changed("New.md");
	await new Promise(resolve => setTimeout(resolve, 450)); expect(inputs).toHaveLength(1);
	search.dispose(); notes.delete("New.md"); notes.set("Other.md", "changed while closed"); offline(false);
	const restored = createNoteSearch(environment); restored.configure(connection); await restored.restore(); await restored.resume();
	expect(inputs.slice(1).join(" ")).toContain("latest offline edit"); expect(inputs.slice(1).join(" ")).toContain("changed while closed");
	expect(inputs.slice(1).join(" ")).not.toContain("new offline note"); expect(restored.progress.state).toBe("complete"); restored.dispose();
});
it("discards a late edit after moving into an excluded folder and preserves similar paths", async () => {
	const { search, notes, environment } = fixture(); await search.indexVault(); search.dispose();
	let finish!: (response: Response) => void; let held = false;
	const client = createServerClient(async (_url, init) => {
	 const { input } = JSON.parse(String(init?.body));
	 if (input[0].includes("pending edit")) { held = true; return new Promise<Response>(resolve => { finish = resolve; }); }
	 return new Response(JSON.stringify({ data: [{ index: 0, embedding: [1, 0] }] }));
	});
	const active = createNoteSearch({ ...environment, client }); active.configure({ ...connection, excludedFolders: ["Private"] }); await active.restore();
	notes.set("Train.md", "pending edit"); await active.changed("Train.md");
	await vi.waitFor(() => expect(held).toBe(true));
	notes.delete("Train.md"); notes.set("Private/Train.md", "pending edit"); await active.renamed("Private/Train.md", "Train.md");
	notes.set("Private-public/Train.md", "allowed train"); await active.changed("Private-public/Train.md");
	finish(new Response(JSON.stringify({ data: [{ index: 0, embedding: [1, 0] }] })));
	await vi.waitFor(() => expect(active.progress.state).toBe("complete"));
	await active.removed("Other.md"); notes.delete("Other.md");
	expect(await active.search("train")).toMatchObject({ path: "Private-public/Train.md", text: expect.stringContaining("Private-public/Train.md") }); active.dispose();
});
it("follows renamed excluded subtrees and allows a manual note update while automation is paused", async () => {
	const { search, notes, inputs } = fixture(); await search.indexVault();
	search.configure({ ...connection, excludedFolders: ["Private", "Private/Nested"], autoUpdateNotes: false });
	expect(await search.renamed("Secrets", "Private")).toEqual(["Secrets", "Secrets/Nested"]);
	notes.set("Secrets/Train.md", "secret"); await search.changed("Secrets/Train.md");
	notes.set("Train.md", "paused edit"); inputs.length = 0; await search.changed("Train.md");
	await new Promise(resolve => setTimeout(resolve, 450)); expect(inputs).toHaveLength(0);
	await expect(search.index("Secrets/Train.md")).rejects.toMatchObject({ code: "search-excluded" });
	await search.index("Train.md"); expect(inputs).toHaveLength(1);
	expect(await search.search("train")).toMatchObject({ path: "Train.md", text: expect.stringContaining("paused edit") }); search.dispose();
});
it("rejects a late version, accepts the latest text and updates renamed source metadata", async () => {
	const { notes, environment } = fixture();
	let finish!: (response: Response) => void; let held = false;
	const client = createServerClient(async (_url, init) => {
	 const { input } = JSON.parse(String(init?.body));
	 if (input[0].includes("first pending edit")) { held = true; return new Promise<Response>(resolve => { finish = resolve; }); }
	 return new Response(JSON.stringify({ data: [{ index: 0, embedding: input[0].includes("boat") ? [0, 1] : [1, 0] }] }));
	});
	const search = createNoteSearch({ ...environment, client }); search.configure(connection); await search.indexVault();
	notes.set("Train.md", "first pending edit"); await search.changed("Train.md");
	await vi.waitFor(() => expect(held).toBe(true));
	notes.set("Train.md", "latest pending edit"); await search.changed("Train.md");
	expect(await search.search("train")).toBeNull();
	finish(new Response(JSON.stringify({ data: [{ index: 0, embedding: [1, 0] }] })));
	await vi.waitFor(() => expect(search.progress.state).toBe("complete"));
	expect(await search.search("train")).toMatchObject({ path: "Train.md", text: expect.stringContaining("latest pending edit") });
	notes.delete("Train.md"); notes.set("Travel/Renamed.md", "latest pending edit"); await search.renamed("Travel/Renamed.md", "Train.md");
	await vi.waitFor(() => expect(search.progress.state).toBe("complete"));
	const source = (await search.search("train"))!;
	expect(source).toMatchObject({ path: "Travel/Renamed.md", text: expect.stringContaining("Renamed\nTravel/Renamed.md") });
	await search.open(source); expect(environment.open).toHaveBeenLastCalledWith("Travel/Renamed.md");
	notes.delete("Travel/Renamed.md"); await search.removed("Travel/Renamed.md");
	expect(await search.search("train")).toBeNull(); search.dispose();
});
it("reports changes made while closed even when automatic processing is paused", async () => {
	const { search, notes, environment, inputs } = fixture(); await search.indexVault(); search.dispose(); inputs.length = 0;
	notes.set("New.md", "new while closed"); notes.set("Train.md", "changed while closed");
	const restored = createNoteSearch(environment); restored.configure({ ...connection, autoUpdateNotes: false }); await restored.restore();
	expect(restored.progress).toMatchObject({ state: "partial", completed: 1, total: 3 });
	await restored.resume(); expect(inputs).toHaveLength(0);
	await restored.resume(true); expect(restored.progress).toMatchObject({ state: "complete", completed: 3, total: 3 }); restored.dispose();
});
it("resumes interrupted updates after unrelated exclusions and selected-note indexing", async () => {
	const { notes, environment } = fixture(); let held = false; let finish!: (response: Response) => void;
	const client = createServerClient(async (_url, init) => {
	 const { input } = JSON.parse(String(init?.body));
	 if (input[0].includes("interrupt") && !held) { held = true; return new Promise<Response>(resolve => { finish = resolve; }); }
	 return new Response(JSON.stringify({ data: [{ index: 0, embedding: input[0].includes("boat") ? [0, 1] : [1, 0] }] }));
	});
	const search = createNoteSearch({ ...environment, client }); search.configure(connection); await search.indexVault();
	notes.set("Train.md", "interrupt edit"); await search.changed("Train.md"); await vi.waitFor(() => expect(held).toBe(true));
	search.configure({ ...connection, excludedFolders: ["Private"] });
	await search.index("Other.md");
	finish(new Response(JSON.stringify({ data: [{ index: 0, embedding: [1, 0] }] })));
	await vi.waitFor(() => expect(search.progress).toMatchObject({ state: "complete", completed: 2, total: 2 }));
	expect(await search.search("train")).toMatchObject({ path: "Train.md", text: expect.stringContaining("interrupt edit") }); search.dispose();
});
it("ignores automatic events before first explicit indexing and removes offline pending paths without HTTP", async () => {
	const { search, notes, inputs, offline } = fixture();
	notes.set("New.md", "new before indexing"); await search.changed("New.md");
	await new Promise(resolve => setTimeout(resolve, 450)); expect(inputs).toHaveLength(0);
	await search.indexVault(); offline(true); inputs.length = 0;
	notes.set("Train.md", "offline train"); await search.changed("Train.md");
	await vi.waitFor(() => expect(search.progress.state).toBe("error"));
	notes.delete("Train.md"); notes.set("Moved.md", "offline train"); await search.renamed("Moved.md", "Train.md");
	notes.delete("Moved.md"); await search.removed("Moved.md");
	await new Promise(resolve => setTimeout(resolve, 450)); expect(inputs).toHaveLength(1);
	offline(false); await search.resume(true); expect(inputs).toHaveLength(1); search.dispose();
});
it("counts empty Markdown notes as processed without embedding requests or repeated work", async () => {
	const { search, notes, inputs, environment } = fixture(); notes.set("Empty.md", ""); await search.indexVault();
	expect(search.progress).toMatchObject({ state: "complete", completed: 3, total: 3 }); search.dispose(); inputs.length = 0;
	const restored = createNoteSearch(environment); restored.configure(connection); await restored.restore(); await restored.resume();
	expect(restored.progress).toMatchObject({ state: "complete", completed: 3, total: 3 }); expect(inputs).toHaveLength(0); restored.dispose();
});
