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
		expect(await restored.search("When does the train depart?")).toMatchObject({ path: "Train.md", text: "Train\nTrain.md\n\nThe train departs at 18:30." });
		expect(requests).toEqual([["Train\nTrain.md\n\nThe train departs at 18:30."], ["When does the train depart?"]]);
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

it("indexes long sections in bounded overlapping fragments and restores the matching section", async () => {
	const { search, notes, requests, options, connection } = fixture();
	notes.set("Train.md", "# Travel\n## Departure\n" + "The train departs at 18:30. ".repeat(250) + "\n\n## Arrival\nArrives at 22:00.");
	await search.index("Train.md");
	expect(requests.length).toBeGreaterThan(2);
	expect(requests.every(([text]) => text.length <= 4000)).toBe(true);
	expect(requests[0][0].slice(-200)).toBe(requests[1][0].split("\n\n").at(-1)?.slice(0, 200));
	const restored = createNoteSearch(options); restored.configure(connection);
	const source = await restored.search("Departure");
	expect(source?.headings).toEqual(["Travel", "Departure"]);
	expect(source?.text.length).toBeLessThanOrEqual(4000);
	expect(source?.text).not.toContain("Arrives at 22:00");
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

it("finds the departure time with the captured embeddings from the Russian acceptance scenario", async () => {
	const { trainEmbedding, departureQuestionEmbedding } = await import("./fixtures/train-embeddings");
	const text = "Поезд Север отправляется в 18:30 с платформы 4";
	const { options, connection } = fixture();
	const client = createServerClient(async (_url, init) => {
		const { input } = JSON.parse(String(init?.body));
		const embedding = input[0].endsWith(text) ? trainEmbedding : departureQuestionEmbedding;
		return new Response(JSON.stringify({ data: [{ index: 0, embedding }] }));
	});
	const search = createNoteSearch({ ...options, client, read: async () => text }); search.configure(connection);
	await search.index("Тест поиска.md");
	expect(await search.search("Время отправления поезда")).toMatchObject({ path: "Тест поиска.md", text: "Тест поиска\nТест поиска.md\n\n" + text });
	search.configure({ ...connection, noteSearchMinSimilarity: 0.5 });
	expect(await search.search("Время отправления поезда")).toBeNull();
	search.configure({ ...connection, noteSearchMinSimilarity: 0.4 });
	expect(await search.search("Время отправления поезда")).toMatchObject({ path: "Тест поиска.md", text: "Тест поиска\nТест поиска.md\n\n" + text });
	// The persisted vectors remain compatible after changing only the search threshold.
	const restored = createNoteSearch({ ...options, client, read: async () => text });
	restored.configure({ ...connection, noteSearchMinSimilarity: 0.5 });
	expect(await restored.search("Время отправления поезда")).toBeNull();
});

it("still rejects an unrelated question with captured embeddings from the same model", async () => {
	const { trainEmbedding, unrelatedQuestionEmbedding } = await import("./fixtures/train-embeddings");
	const text = "Поезд Север отправляется в 18:30 с платформы 4";
	const { options, connection } = fixture();
	const client = createServerClient(async (_url, init) => {
		const { input } = JSON.parse(String(init?.body));
		const embedding = input[0].endsWith(text) ? trainEmbedding : unrelatedQuestionEmbedding;
		return new Response(JSON.stringify({ data: [{ index: 0, embedding }] }));
	});
	const search = createNoteSearch({ ...options, client, read: async () => text }); search.configure(connection);
	await search.index("Тест поиска.md");
	expect(await search.search("Курс доллара сегодня")).toBeNull();
});

it("accepts an identical captured embedding at the maximum similarity threshold", async () => {
	const { trainEmbedding } = await import("./fixtures/train-embeddings");
	const { options, connection } = fixture();
	const client = createServerClient(async () => new Response(JSON.stringify({ data: [{ index: 0, embedding: trainEmbedding }] })));
	const search = createNoteSearch({ ...options, client });
	search.configure({ ...connection, noteSearchMinSimilarity: 1 }); await search.index("Train.md");
	expect(await search.search("The train departs at 18:30.")).toMatchObject({ path: "Train.md", text: "Train\nTrain.md\n\nThe train departs at 18:30." });
});


it("indexes only allowed metadata and literal embeds, returns the relevant heading and opens its section", async () => {
	const { options, notes, connection } = fixture();
	notes.set("Train.md", "---\ntags: [rail]\naliases: [North]\nsecret: hidden-password\n---\n# Travel\n## Departure\nLeaves at 18:30.\n\nAnother paragraph.\n## Arrival\nArrives at 22:00. ![[Secret]] [[Linked]]\n");
	const readPaths: string[] = [];
	const opened: Array<[string, string | undefined]> = [];
	const inputs: string[] = [];
	const client = createServerClient(async (_url, init) => {
		const { input } = JSON.parse(String(init?.body)); inputs.push(input[0]);
		return new Response(JSON.stringify({ data: [{ index: 0, embedding: input[0].includes("Arriv") ? [0, 1] : [1, 0] }] }));
	});
	const search = createNoteSearch({ ...options, client,
		metadata: () => ({ tags: ["rail"], aliases: ["North"], secret: "hidden-password" }),
		read: async (path) => { readPaths.push(path); return notes.get(path) ?? null; },
		open: async (path, heading) => { opened.push([path, heading]); },
	}); search.configure(connection);
	await search.index("Train.md");
	const source = await search.search("Arrival");
	expect(source).toMatchObject({ path: "Train.md", headings: ["Travel", "Arrival"], text: "Train\nTrain.md\nTravel\nArrival\ntags: rail\naliases: North\n\nArrives at 22:00. ![[Secret]] [[Linked]]" });
	expect(inputs.join("\n")).not.toContain("hidden-password");
	expect(inputs[0]).toContain("Another paragraph.");
	expect(new Set(readPaths)).toEqual(new Set(["Train.md"]));
	await search.open(source!); expect(opened).toEqual([["Train.md", "Arrival"]]);
	notes.set("Train.md", "Changed");
	await expect(search.open(source!)).rejects.toMatchObject({ code: "search-rebuild" });
});

it("validates fragment options, invalidates incompatible saved results and uses the next processing options", async () => {
	const { search, notes, options, connection, requests } = fixture();
	notes.set("Train.md", "# Departure\n" + "train ".repeat(1200));
	await search.index("Train.md");
	expect(() => search.configure({ ...connection, noteFragmentSize: 256, noteFragmentOverlap: 200 })).toThrow();
	expect(await search.search("When?")).not.toBeNull();
	search.configure({ ...connection, noteFragmentSize: 512, noteFragmentOverlap: 32 });
	await expect(search.search("When?")).rejects.toMatchObject({ code: "search-rebuild" });
	requests.length = 0;
	await search.index("Train.md");
	expect(requests.length).toBeGreaterThan(10);
	expect(requests.every(([text]) => text.length <= 512)).toBe(true);
	const restored = createNoteSearch(options); restored.configure(connection);
	await expect(restored.search("When?")).rejects.toMatchObject({ code: "search-rebuild" });
	restored.configure({ ...connection, noteFragmentSize: 512, noteFragmentOverlap: 32 });
	// Switching configuration intentionally discards the incompatible index, even when switching back.
	await expect(restored.search("When?")).rejects.toMatchObject({ code: "search-rebuild" });
});

it("keeps heading ancestry when levels are skipped and ignores headings inside fenced code", async () => {
	const { options, connection, notes } = fixture();
	const client = createServerClient(async (_url, init) => {
		const { input } = JSON.parse(String(init?.body));
		return new Response(JSON.stringify({ data: [{ index: 0, embedding: input[0].includes("Arrival") ? [0, 1] : [1, 0] }] }));
	});
	const search = createNoteSearch({ ...options, client }); search.configure(connection);
	notes.set("Train.md", "# Travel\n### Departure\n#### Platform\n```md\n# Example\n```\n### Arrival\nArrives at 22:00.");
	await search.index("Train.md");
	const source = await search.search("Arrival");
	expect(source?.headings).toEqual(["Travel", "Arrival"]);
	expect(source?.text).not.toContain("# Example");
});

it("recognizes Setext headings and keeps fitting paragraphs whole", async () => {
	const { search, notes, connection, requests } = fixture();
	search.configure({ ...connection, noteFragmentSize: 512, noteFragmentOverlap: 0 });
	notes.set("Train.md", "Travel\n======\nDeparture\n---------\n" + "A".repeat(180) + "\n\n" + "B".repeat(350));
	await search.index("Train.md");
	const source = await search.search("When?");
	expect(source?.headings).toEqual(["Travel", "Departure"]);
	expect(requests[0][0]).toBe("Train\nTrain.md\nTravel\nDeparture\n\n" + "A".repeat(180));
	expect(requests[1][0]).toBe("Train\nTrain.md\nTravel\nDeparture\n\n" + "B".repeat(350));
});

it("requests rebuilding instead of throwing on a corrupted persisted fragment", async () => {
	const { search, options } = fixture(); await search.index("Train.md");
	// Corrupt the persistence boundary; the observable assertion remains public search behavior.
	const [{ name }] = await options.factory.databases();
	await new Promise<void>((resolve, reject) => {
		const request = options.factory.open(name!);
		request.onerror = () => reject(request.error);
		request.onsuccess = () => {
			const db = request.result;
			const tx = db.transaction("note", "readwrite");
			const store = tx.objectStore("note");
			const record = store.get("current");
			record.onsuccess = () => store.put({ ...record.result, fragments: [null] }, "current");
			tx.oncomplete = () => { db.close(); resolve(); };
			tx.onabort = () => { db.close(); reject(tx.error); };
		};
	});
	await expect(search.search("When?")).rejects.toMatchObject({ code: "search-rebuild" });
});

it("requires closing fences to end with whitespace so code cannot swallow a real section", async () => {
	const { options, connection, notes } = fixture();
	notes.set("Train.md", "```markdown\n```example\n# Literal code heading\n```\n# Real\nActual body");
	const client = createServerClient(async (_url, init) => {
		const { input } = JSON.parse(String(init?.body));
		return new Response(JSON.stringify({ data: [{ index: 0, embedding: input[0].includes("Actual") ? [0, 1] : [1, 0] }] }));
	});
	const search = createNoteSearch({ ...options, client }); search.configure(connection); await search.index("Train.md");
	expect(await search.search("Actual")).toMatchObject({ headings: ["Real"], text: "Train\nTrain.md\nReal\n\nActual body" });
});
