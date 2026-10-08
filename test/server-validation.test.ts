import { afterEach, describe, expect, it, vi } from "vitest";
import { createServerClient, type ClientFetch } from "../src/server-client";

afterEach(() => { vi.useRealTimers(); });

describe("server response validation", () => {
	it.each([null, {}, { data: {} }, { data: [null] }, { data: [{}] }, { data: [{ id: 12 }] }])(
		"returns an error for malformed model lists: %j", async (body) => {
			const client = createServerClient(async () => new Response(JSON.stringify(body)));
			await expect(client.listModels("http://s")).resolves.toMatchObject({ ok: false });
		}
	);
	it.each([null, {}, { choices: {} }, { choices: [null] }, { choices: [{ message: { content: 12 } }] }])(
		"returns an error for malformed chat responses: %j", async (body) => {
			const client = createServerClient(async () => new Response(JSON.stringify(body)));
			await expect(client.chat("http://s", "m", [])).resolves.toMatchObject({ ok: false });
		}
	);
	it("ignores malformed usage without producing NaN token counts", async () => {
		const body = { choices: [{ message: { content: "answer" } }], usage: { total_tokens: "oops" } };
		const client = createServerClient(async () => new Response(JSON.stringify(body)));
		await expect(client.chat("http://s", "m", [])).resolves.toEqual({
			ok: true, value: { content: "answer", usage: undefined },
		});
	});
});

describe("server request timeout", () => {
	it("cancels an active chat request even when fetch does not settle", async () => {
		const controller = new AbortController();
		const fetchImpl = vi.fn<Parameters<ClientFetch>, ReturnType<ClientFetch>>(() => new Promise(() => {}));
		const result = createServerClient(fetchImpl).chat("http://s", "m", [], { signal: controller.signal });
		controller.abort();
		await expect(result).resolves.toMatchObject({ ok: false, error: { message: "Request cancelled." } });
		expect(fetchImpl.mock.calls[0][1]?.signal?.aborted).toBe(true);
	});

	it("does not send a request when its signal is already aborted", async () => {
		const controller = new AbortController();
		controller.abort();
		const fetchImpl = vi.fn<Parameters<ClientFetch>, ReturnType<ClientFetch>>();
		await expect(createServerClient(fetchImpl).listModels("http://s", "", controller.signal))
			.resolves.toMatchObject({ ok: false });
		expect(fetchImpl).not.toHaveBeenCalled();
	});

	it("ends a stalled model request and aborts its fetch", async () => {
		vi.useFakeTimers();
		const fetchImpl = vi.fn<Parameters<ClientFetch>, ReturnType<ClientFetch>>(() => new Promise(() => {}));
		const result = createServerClient(fetchImpl).listModels("http://s");
		await vi.advanceTimersByTimeAsync(15_000);
		await expect(result).resolves.toMatchObject({ ok: false, error: { message: expect.stringMatching(/timed out/i) } });
		expect(fetchImpl.mock.calls[0][1]?.signal?.aborted).toBe(true);
	});
	it("keeps the chat timeout active while reading the response body", async () => {
		vi.useFakeTimers();
		const fetchImpl: ClientFetch = async () => ({
			ok: true, json: () => new Promise(() => {}),
		}) as unknown as Response;
		const result = createServerClient(fetchImpl).chat("http://s", "m", []);
		await vi.advanceTimersByTimeAsync(120_000);
		await expect(result).resolves.toMatchObject({ ok: false, error: { message: expect.stringMatching(/timed out/i) } });
	});

	it("cleans up the timer after a successful request", async () => {
		vi.useFakeTimers();
		const client = createServerClient(async () => new Response(JSON.stringify({ data: [] })));
		await client.listModels("http://s");
		expect(vi.getTimerCount()).toBe(0);
	});
});
