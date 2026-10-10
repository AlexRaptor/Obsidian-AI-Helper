import { afterEach, expect, it, vi } from "vitest";
import { deferred } from "./helpers/obsidian";
import { createModelConnection } from "../src/model-connection";
import { createServerClient } from "../src/server-client";

it("checks the selected conversation model with a small real completion", async () => {
	const fetch = vi.fn(async (_url: string, _init?: RequestInit) => new Response(JSON.stringify({ choices: [{ message: { content: "OK" } }] })));
	expect(await createServerClient(fetch).verifyModel("http://s/v1/", "selected", "key")).toEqual({ ok: true, value: undefined });
	expect(fetch.mock.calls[0][0]).toBe("http://s/v1/chat/completions");
	expect(fetch.mock.calls[0][1]?.headers).toEqual({ "Content-Type": "application/json", Authorization: "Bearer key" });
	expect(JSON.parse(fetch.mock.calls[0][1]!.body as string)).toEqual({ model: "selected", messages: [{ role: "user", content: "Reply with OK." }], stream: false, max_tokens: 8 });
});


it("recognizes a reasoning model that returns only reasoning within the short check budget", async () => {
	const client = createServerClient(async () => new Response(JSON.stringify({ choices: [{ message: { content: null, reasoning_content: "Let me answer briefly." }, finish_reason: "length" }] })));
	expect((await client.verifyModel("http://s", "reasoning-model")).ok).toBe(true);
});


afterEach(() => { vi.useRealTimers(); });

it.each([[401, "model-auth"], [403, "model-auth"], [400, "model-unavailable"], [404, "model-unavailable"], [422, "model-unavailable"], [500, "model-network"]])(
	"classifies a failed model check with HTTP %s", async (status, code) => {
		const client = createServerClient(async () => new Response("server details", { status: status as number }));
		expect(await client.verifyModel("http://s", "m")).toMatchObject({ ok: false, error: { code } });
	}
);

it.each([null, {}, { choices: [] }, { choices: [{ message: { content: "" } }] }, { choices: [{ message: { content: 12 } }] }])(
	"rejects invalid or empty completions when checking availability: %j", async (body) => {
		const client = createServerClient(async () => new Response(JSON.stringify(body)));
		expect(await client.verifyModel("http://s", "m")).toMatchObject({ ok: false, error: { code: "model-response" } });
	}
);

it("omits the optional key and does not apply generation settings to the check", async () => {
	const fetch = vi.fn(async (_url: string, _init?: RequestInit) => new Response(JSON.stringify({ choices: [{ message: { content: "OK" } }] })));
	await createServerClient(fetch).verifyModel("http://s", "m");
	expect(fetch.mock.calls[0][1]?.headers).toEqual({ "Content-Type": "application/json" });
});

it("allows a cold model to load and ends a stalled availability check after 60 seconds", async () => {
	vi.useFakeTimers();
	const fetch = vi.fn((_url: string, _init?: RequestInit): Promise<Response> => new Promise(() => {}));
	let settled = false;
	const checking = createServerClient(fetch).verifyModel("http://s", "m").then((result) => { settled = true; return result; });
	await vi.advanceTimersByTimeAsync(15_000);
	expect(settled).toBe(false);
	await vi.advanceTimersByTimeAsync(45_000);
	expect(await checking).toMatchObject({ ok: false, error: { code: "model-network" } });
	expect(fetch.mock.calls[0][1]?.signal?.aborted).toBe(true);
	expect(vi.getTimerCount()).toBe(0);
});

it("keeps a late model check from confirming a changed connection", async () => {
	const pending = deferred<Response>();
	const connection = createModelConnection(createServerClient(() => pending.promise));
	connection.configure({ serverUrl: "http://old", apiKey: "", model: "old" });
	const checking = connection.verify();
	connection.configure({ serverUrl: "http://new", apiKey: "new-key", model: "new" });
	pending.resolve(new Response(JSON.stringify({ choices: [{ message: { content: "OK" } }] })));
	await checking;
	expect(connection.status).toEqual({ state: "idle" });
});

it("cancels a model check when the settings close", async () => {
	const pending = deferred<Response>();
	const connection = createModelConnection(createServerClient(() => pending.promise));
	connection.configure({ serverUrl: "http://s", apiKey: "", model: "m" });
	const checking = connection.verify();
	connection.cancel();
	pending.resolve(new Response("{}"));
	await checking;
	expect(connection.status).toEqual({ state: "idle" });
});

it("reports network and malformed JSON errors without including server details", async () => {
	const offline = createServerClient(async () => { throw new TypeError("offline"); });
	expect(await offline.verifyModel("http://s", "m")).toMatchObject({ ok: false, error: { code: "model-network" } });
	const malformed = createServerClient(async () => new Response("not json"));
	expect(await malformed.verifyModel("http://s", "m")).toMatchObject({ ok: false, error: { code: "model-response" } });
});

it("rejects invalid model configuration before sending a message", async () => {
	const fetch = vi.fn(); const client = createServerClient(fetch);
	expect(await client.verifyModel("", "m")).toMatchObject({ ok: false, error: { code: "model-config" } });
	expect(await client.verifyModel("http://s", " ")).toMatchObject({ ok: false, error: { code: "model-config" } });
	expect(fetch).not.toHaveBeenCalled();
});
