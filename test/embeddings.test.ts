import { afterEach, expect, it, vi } from "vitest";
import { createServerClient } from "../src/server-client";

it("posts text to the independent embedding server and restores input order", async () => {
	const fetch = vi.fn(async () => new Response(JSON.stringify({ data: [
		{ index: 1, embedding: [0, 2] }, { index: 0, embedding: [1, 0] },
	] })));
	const client = createServerClient(fetch);
	expect(await client.embeddings("https://embedding.example/v1/", "chosen-id", ["first", "second"], "secret"))
		.toEqual({ ok: true, value: [[1, 0], [0, 2]] });
	const [url, init] = fetch.mock.calls[0] as unknown as [string, RequestInit];
	expect(url).toBe("https://embedding.example/v1/embeddings");
	expect(init.method).toBe("POST");
	expect(init.headers).toEqual({ "Content-Type": "application/json", Authorization: "Bearer secret" });
	expect(JSON.parse(init.body as string)).toEqual({ model: "chosen-id", input: ["first", "second"], encoding_format: "float" });
});


afterEach(() => { vi.useRealTimers(); });

it.each([
	null, {}, { data: [] }, { data: [null, null] },
	{ data: [{ index: 0, embedding: [1] }] },
	{ data: [{ index: 0, embedding: [1] }, { index: 0, embedding: [2] }] },
	{ data: [{ index: -1, embedding: [1] }, { index: 1, embedding: [2] }] },
	{ data: [{ index: 2, embedding: [1] }, { index: 1, embedding: [2] }] },
	{ data: [{ index: 0.5, embedding: [1] }, { index: 1, embedding: [2] }] },
	{ data: [{ embedding: [1] }, { index: 1, embedding: [2] }] },
	{ data: [{ index: 0, embedding: [] }, { index: 1, embedding: [] }] },
	{ data: [{ index: 0, embedding: [0, 0] }, { index: 1, embedding: [1, 2] }] },
	{ data: [{ index: 0, embedding: [1] }, { index: 1, embedding: [1, 2] }] },
	{ data: [{ index: 0, embedding: ["1"] }, { index: 1, embedding: [2] }] },
	{ data: [{ index: 0, embedding: "base64" }, { index: 1, embedding: [2] }] },
])( "rejects unusable vectors or mismatched input indices: %j", async (body) => {
	const client = createServerClient(async () => new Response(JSON.stringify(body)));
	expect(await client.embeddings("http://s/v1", "m", ["one", "two"]))
		.toMatchObject({ ok: false, error: { code: "embedding-response" } });
});

it.each([NaN, Infinity, -Infinity])( "rejects nonfinite vector values: %s", async (value) => {
	const client = createServerClient(async () => ({ ok: true, json: async () => ({ data: [{ index: 0, embedding: [value] }] }) }) as Response);
	expect(await client.embeddings("http://s", "m", ["text"]))
		.toMatchObject({ ok: false, error: { code: "embedding-response" } });
});

it("omits authorization for servers without a key", async () => {
	const fetch = vi.fn(async (_url: string, _init?: RequestInit) => new Response(JSON.stringify({ data: [{ index: 0, embedding: [1] }] })));
	expect((await createServerClient(fetch).embeddings("http://s/v1", "m", ["text"])).ok).toBe(true);
	expect(fetch.mock.calls[0][1]?.headers).toEqual({ "Content-Type": "application/json" });
});

it.each([[401, "embedding-auth"], [403, "embedding-auth"], [400, "embedding-model"], [404, "embedding-model"], [422, "embedding-model"], [500, "embedding-network"]])(
	"classifies HTTP %s without exposing server error details", async (status, code) => {
		const client = createServerClient(async () => new Response("secret error", { status: status as number }));
		expect(await client.embeddings("http://s", "m", ["text"]))
			.toMatchObject({ ok: false, error: { code } });
	}
);

it("reports invalid JSON separately from network failures", async () => {
	const malformed = createServerClient(async () => new Response("not json"));
	expect(await malformed.embeddings("http://s", "m", ["text"]))
		.toMatchObject({ ok: false, error: { code: "embedding-response" } });
	const offline = createServerClient(async () => { throw new TypeError("offline"); });
	expect(await offline.embeddings("http://s", "m", ["text"]))
		.toMatchObject({ ok: false, error: { code: "embedding-network" } });
});

it.each(["", "file:///tmp", "http://user:pass@s/v1", "http://s/v1?key=secret", "http://s/v1#fragment"])("rejects invalid configuration before sending text: %s", async (url) => {
	const fetch = vi.fn();
	expect(await createServerClient(fetch).embeddings(url, "m", ["text"]))
		.toMatchObject({ ok: false, error: { code: "embedding-config" } });
	expect(fetch).not.toHaveBeenCalled();
});

it("aborts a stalled response body after the check deadline", async () => {
	vi.useFakeTimers();
	const fetch = vi.fn(async (_url: string, _init?: RequestInit) => ({ ok: true, json: () => new Promise(() => {}) }) as Response);
	const checking = createServerClient(fetch).embeddings("http://s", "m", ["text"]);
	await vi.advanceTimersByTimeAsync(15_000);
	expect(await checking).toMatchObject({ ok: false, error: { code: "embedding-network" } });
	expect(fetch.mock.calls[0][1]?.signal?.aborted).toBe(true);
	expect(vi.getTimerCount()).toBe(0);
});
