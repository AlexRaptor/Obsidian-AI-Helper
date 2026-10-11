import { expect, it } from "vitest";
import { IDBFactory } from "fake-indexeddb";
import { createNoteSearch } from "../src/note-index";
import { createServerClient } from "../src/server-client";

async function fixture() {
	const notes = new Map([
		["Access.md", "ERR_AUTH_42 means the access token has expired."],
		["Travel.md", "The night service leaves the station at 18:30."],
	]);
	const connection = { embeddingServerUrl: "http://s/v1", embeddingApiKey: "", embeddingModel: "embed", autoUpdateNotes: false };
	const client = createServerClient(async (_url, init) => {
		const { input } = JSON.parse(String(init?.body));
		return new Response(JSON.stringify({ data: input.map((text: string, index: number) => ({ index,
			embedding: text.includes("\n\n") ? text.includes("18:30") ? [1, 0] : [0, 1] : text.includes("departure") ? [1, 0] : [-1, 0],
		})) }));
	});
	const options = { factory: new IDBFactory(), vaultPath: "/hybrid", client, list: () => [...notes.keys()], read: async (path: string) => notes.get(path) ?? null, open: async () => {}, metadata: (path: string) => path === "Access.md" ? { tags: ["authentication"], aliases: ["Credentials"] } : {} };
	const search = createNoteSearch(options); search.configure(connection); await search.indexVault();
	return { search, notes, options, connection };
}

it("finds an exact identifier even when its semantic similarity is below the threshold", async () => {
	const { search } = await fixture();
	expect(await search.search("What does ERR_AUTH_42 mean?")).toMatchObject({ path: "Access.md" });
});

it.each(["Access", "authentication", "Credentials"])("finds a title, tag or alias: %s", async (question) => {
	const { search } = await fixture();
	expect(await search.search(question)).toMatchObject({ path: "Access.md" });
});

it("keeps paraphrase search and rejects negative examples and identifier substrings", async () => {
	const { search } = await fixture();
	expect(await search.search("departure time")).toMatchObject({ path: "Travel.md" });
	for (const question of ["Weather tomorrow", "What does ERR_AUTH_4 mean?", "What is the access price on Mars?", "Что означает ERR_AUTH_4?"]) {
		expect(await search.search(question)).toBeNull();
	}
});

it("returns complementary fragments without filling the source context with copies", async () => {
	const { search, notes } = await fixture();
	notes.set("Copy.md", notes.get("Access.md")!);
	notes.set("Recovery.md", "ERR_AUTH_42 is resolved by requesting a new token.");
	await search.index("Copy.md"); await search.index("Recovery.md");
	const sources = await search.searchSources("ERR_AUTH_42");
	expect(sources).toHaveLength(2);
	expect(sources.map(source => source.text).join("\n")).toContain("requesting a new token");
});

it("respects a source byte budget and never revives stale or excluded lexical matches", async () => {
	const { search, notes, connection } = await fixture();
	await expect(search.searchSources("ERR_AUTH_42", undefined, 20)).rejects.toMatchObject({ code: "search-budget" });
	notes.set("Access.md", "This note no longer contains the identifier.");
	expect(await search.searchSources("ERR_AUTH_42")).toEqual([]);
	await search.index("Access.md");
	search.configure({ ...connection, excludedFolders: ["Access.md"] });
	expect(await search.searchSources("authentication")).toEqual([]);
});

it("finds an identifier embedded in a longer question and favors it over a semantic distractor", async () => {
	const { search } = await fixture();
	expect(await search.search("ERR_AUTH_42 departure troubleshooting")).toMatchObject({ path: "Access.md" });
});

it("restores exact matching after restart and keeps sources under the requested budget", async () => {
	const { search, options, connection, notes } = await fixture();
	notes.set("Recovery.md", "ERR_AUTH_42 is resolved by requesting a new token.");
	await search.index("Recovery.md");
	const restored = createNoteSearch(options); restored.configure(connection);
	const sources = await restored.searchSources("ERR_AUTH_42", undefined, 300);
	expect(sources).toHaveLength(1);
	expect(sources[0].text).toContain("ERR_AUTH_42");
});

it("does not suppress a complementary larger fragment just because it contains the shorter one", async () => {
	const { search, notes } = await fixture();
	const shared = "ERR_AUTH_42 means the current access token has expired and the client cannot authenticate until it obtains a fresh token from the authorization server.";
	notes.set("Access.md", shared);
	notes.set("Recovery.md", shared + " To obtain it, open the account settings, choose renew credentials, verify your email address and confirm the request. The old credential is revoked automatically after the replacement has been issued.");
	await search.index("Access.md"); await search.index("Recovery.md");
	const sources = await search.searchSources("ERR_AUTH_42");
	expect(sources.map(source => source.text).join("\n")).toContain("choose renew credentials");
});

it("finds a short exact title and identifier independently of semantic similarity", async () => {
	const { search, notes } = await fixture();
	notes.set("AI.md", "X1 identifies the access gateway."); await search.index("AI.md");
	expect(await search.search("AI")).toMatchObject({ path: "AI.md" });
	expect(await search.search("What does X1 mean?")).toMatchObject({ path: "AI.md" });
});

it("keeps different recorded values even in otherwise almost identical fragments", async () => {
	const { search, notes } = await fixture();
	const shared = "ERR_AUTH_42 means the current access token has expired and the client cannot authenticate until it obtains a fresh token from the authorization server. The documented retry interval in this environment is ";
	notes.set("Access.md", shared + "15 seconds."); notes.set("Recovery.md", shared + "60 seconds.");
	await search.index("Access.md"); await search.index("Recovery.md");
	const sources = await search.searchSources("ERR_AUTH_42 retry interval");
	expect(sources.map(source => source.text).join("\n")).toContain("15 seconds");
	expect(sources.map(source => source.text).join("\n")).toContain("60 seconds");
});

it("finds separately recorded identifiers and retains the available part of a multi-identifier question", async () => {
	const { search, notes } = await fixture();
	notes.set("Other.md", "ERR_AUTH_43 means the account has been disabled."); await search.index("Other.md");
	const sources = await search.searchSources("What do ERR_AUTH_42 and ERR_AUTH_43 mean?");
	expect(sources.map(source => source.path).sort()).toEqual(["Access.md", "Other.md"]);
	expect((await search.searchSources("What do ERR_AUTH_42 and ERR_AUTH_99 mean?")).map(source => source.path)).toEqual(["Access.md"]);
});
