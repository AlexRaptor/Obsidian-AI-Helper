import { expect, it, vi } from "vitest";
import { createNoteSearchConnection } from "../src/note-search";
import { createServerClient } from "../src/server-client";
import { deferred } from "./helpers/obsidian";

it("does not confirm a changed connection with a late response", async () => {
	const pending = deferred<Response>();
	const connection = createNoteSearchConnection(createServerClient(() => pending.promise));
	connection.configure({ embeddingServerUrl: "http://old/v1", embeddingApiKey: "", embeddingModel: "old" });
	const checking = connection.verify();
	expect(connection.status).toEqual({ state: "checking" });
	connection.configure({ embeddingServerUrl: "http://new/v1", embeddingApiKey: "new-key", embeddingModel: "new" });
	pending.resolve(new Response(JSON.stringify({ data: [{ index: 0, embedding: [1, 2] }, { index: 1, embedding: [3, 4] }] })));
	await checking;
	expect(connection.status).toEqual({ state: "idle" });
});


it("verifies actual embeddings without using the model list", async () => {
	const fetch = vi.fn(async (_url: string, _init?: RequestInit) => new Response(JSON.stringify({ data: [
		{ index: 1, embedding: [3, 4] }, { index: 0, embedding: [1, 2] },
	] })));
	const connection = createNoteSearchConnection(createServerClient(fetch));
	const config = { embeddingServerUrl: "http://s/v1", embeddingApiKey: "", embeddingModel: "user-chosen" };
	connection.configure(config);
	await connection.verify();
	expect(connection.status).toEqual({ state: "verified", dimensions: 2 });
	expect(fetch).toHaveBeenCalledTimes(1);
	expect(fetch.mock.calls[0][0]).toBe("http://s/v1/embeddings");
	expect(JSON.parse(fetch.mock.calls[0][1]!.body as string)).toMatchObject({ model: "user-chosen", input: ["A cat sits by the window.", "The train arrives at the station."] });
	connection.configure(config);
	expect(connection.status.state).toBe("verified");
	connection.configure({ ...config, embeddingApiKey: "changed" });
	expect(connection.status.state).toBe("idle");
});

it("does not let an older check overwrite a newer check", async () => {
	const old = deferred<Response>();
	const fetch = vi.fn().mockReturnValueOnce(old.promise).mockResolvedValueOnce(new Response("unauthorized", { status: 401 }));
	const connection = createNoteSearchConnection(createServerClient(fetch));
	connection.configure({ embeddingServerUrl: "http://s", embeddingApiKey: "", embeddingModel: "m" });
	const first = connection.verify();
	await connection.verify();
	old.resolve(new Response(JSON.stringify({ data: [{ index: 0, embedding: [1] }, { index: 1, embedding: [2] }] })));
	await first;
	expect(connection.status).toEqual({ state: "error", code: "embedding-auth" });
});

it("ignores a late check after cancel", async () => {
	const pending = deferred<Response>();
	const connection = createNoteSearchConnection(createServerClient(() => pending.promise));
	connection.configure({ embeddingServerUrl: "http://s", embeddingApiKey: "", embeddingModel: "m" });
	const checking = connection.verify();
	connection.cancel();
	pending.resolve(new Response("{}"));
	await checking;
	expect(connection.status).toEqual({ state: "idle" });
});
