import { afterEach, expect, it, vi } from "vitest";
import { createServerClient, type ServerClientResult } from "../src/server-client";
import { createContextWindowConnection, effectiveContextWindow, type ContextWindow } from "../src/context-window";
import { deferred } from "./helpers/obsidian";
import { createModelConnection } from "../src/model-connection";

afterEach(() => { vi.useRealTimers(); });

function server(routes: Record<string, unknown>) {
	const fetch = vi.fn(async (url: string, _init?: RequestInit) => url in routes
		? new Response(JSON.stringify(routes[url])) : new Response("Not found", { status: 404 }));
	return { fetch, client: createServerClient(fetch) };
}

it("uses the loaded LM Studio instance, not the model maximum, and retains proxy prefixes and credentials", async () => {
	const { client, fetch } = server({ "http://s/proxy/api/v1/models": { models: [
		{ type: "llm", key: "m", max_context_length: 262144, loaded_instances: [{ id: "instance", config: { context_length: 4096 } }] },
	] } });
	expect(await client.getContextWindow("http://s/proxy/v1/", "instance", "key")).toEqual({ ok: true, value: { tokens: 4096, source: "LM Studio" } });
	expect(fetch.mock.calls.every(([url, init]) => url.startsWith("http://s/proxy/") && (init?.headers as Record<string, string>).Authorization === "Bearer key" && !init?.body)).toBe(true);
	// Selecting the model key also works when only one instance is loaded.
	expect(await client.getContextWindow("http://s/proxy/v1", "m")).toMatchObject({ value: { tokens: 4096 } });
});

it.each([{ loaded_instances: [] }, { loaded_instances: [{ id: "a", config: { context_length: 4096 } }, { id: "b", config: { context_length: 8192 } }] }])(
	"keeps the window unknown for unloaded or ambiguous LM Studio models", async ({ loaded_instances }) => {
		const { client } = server({ "http://s/api/v1/models": { models: [{ type: "llm", key: "m", max_context_length: 262144, loaded_instances }] } });
		expect(await client.getContextWindow("http://s/v1", "m")).toEqual({ ok: true, value: undefined });
	}
);

it.each([
	["vLLM", { "http://s/v1/models": { data: [{ id: "other", max_model_len: 100 }, { id: "m", max_model_len: 8192 }] } }, "m", 8192],
	["Ollama", { "http://s/api/ps": { models: [{ name: "m:latest", context_length: 4096 }] } }, "m", 4096],
	["llama.cpp", { "http://s/v1/models": { data: [{ id: "a/b" }] }, "http://s/props?model=a%2Fb&autoload=false": { default_generation_settings: { n_ctx: 2048 }, total_slots: 4 } }, "a/b", 2048],
] as const)("reads the selected model's runtime window from %s", async (source, routes, model, tokens) => {
	const { client } = server(routes);
	expect(await client.getContextWindow("http://s/v1", model)).toEqual({ ok: true, value: { tokens, source } });
});

it("does not use global llama.cpp properties for an unrecognized model", async () => {
	const { client, fetch } = server({ "http://s/v1/models": { data: [{ id: "other" }] }, "http://s/props": { default_generation_settings: { n_ctx: 8192 } } });
	expect(await client.getContextWindow("http://s/v1", "m")).toEqual({ ok: true, value: undefined });
	expect(fetch.mock.calls.some(([url]) => url.includes("/props"))).toBe(false);
});

it.each([0, -1, 1.5, "8192", null, 9007199254740992])("ignores invalid server limits: %s", async (max_model_len) => {
	const { client } = server({ "http://s/v1/models": { data: [{ id: "m", max_model_len }] } });
	expect(await client.getContextWindow("http://s/v1", "m")).toEqual({ ok: true, value: undefined });
});

it("bounds discovery time and cancels the transport", async () => {
	vi.useFakeTimers();
	const fetch = vi.fn((_url: string, _init?: RequestInit): Promise<Response> => new Promise(() => {}));
	const pending = createServerClient(fetch).getContextWindow("http://s/v1", "m");
	await vi.advanceTimersByTimeAsync(15000);
	expect((await pending).ok).toBe(false);
	expect(fetch.mock.calls[0][1]?.signal?.aborted).toBe(true);
	expect(vi.getTimerCount()).toBe(0);
});

it("rejects late metadata after changing model, server, or API key", async () => {
	const { client } = server({});
	const connection = createContextWindowConnection(client);
	const pending = deferred<ServerClientResult<ContextWindow | undefined>>();
	const get = vi.spyOn(client, "getContextWindow").mockReturnValueOnce(pending.promise).mockResolvedValue({ ok: true, value: { tokens: 8192, source: "vLLM" } });
	connection.configure({ serverUrl: "http://old/v1", model: "old", apiKey: "old" });
	const old = connection.refresh();
	connection.configure({ serverUrl: "http://new/v1", model: "new", apiKey: "new" });
	expect(connection.value).toBeUndefined();
	expect(get.mock.calls[0][3]?.aborted).toBe(true);
	await connection.refresh();
	pending.resolve({ ok: true, value: { tokens: 4096, source: "LM Studio" } });
	await old;
	expect(connection.value).toEqual({ tokens: 8192, source: "vLLM" });
	connection.configure({ serverUrl: "http://new/v1", model: "new", apiKey: "changed" });
	expect(connection.value).toBeUndefined();
});

it("prioritizes the manual override and restores automatic mode when cleared", () => {
	const detected = { tokens: 8192, source: "vLLM" };
	expect(effectiveContextWindow("4096", detected)).toBe(4096);
	expect(effectiveContextWindow("", detected)).toBe(8192);
	expect(effectiveContextWindow("", undefined)).toBeUndefined();
	expect(effectiveContextWindow("invalid", detected)).toBeUndefined();
});

it("clears metadata on a failed refresh", async () => {
	const { client } = server({ "http://s/v1/models": { data: [{ id: "m", max_model_len: 8192 }] } });
	const connection = createContextWindowConnection(client);
	connection.configure({ serverUrl: "http://s/v1", model: "m", apiKey: "" });
	await connection.refresh();
	expect(connection.value?.tokens).toBe(8192);
	vi.spyOn(client, "getContextWindow").mockResolvedValue({ ok: false, error: { message: "offline" } });
	await connection.refresh();
	expect(connection.value).toBeUndefined();
	expect(connection.checking).toBe(false);
});

it("keeps model verification independent of successful context discovery", async () => {
	const { client, fetch } = server({ "http://s/v1/models": { data: [{ id: "m", max_model_len: 8192 }] } });
	const connection = createContextWindowConnection(client);
	const model = createModelConnection(client);
	const config = { serverUrl: "http://s/v1", apiKey: "", model: "m" };
	connection.configure(config); model.configure(config);
	await connection.refresh();
	expect(connection.value?.tokens).toBe(8192);
	expect(model.status.state).toBe("idle");
	expect(fetch.mock.calls.some(([, init]) => init?.method === "POST")).toBe(false);
	await model.verify();
	expect(model.status).toEqual({ state: "error", code: "model-unavailable" });
});
