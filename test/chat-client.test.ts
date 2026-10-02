import { describe, expect, it, vi } from "vitest";
import { createServerClient, type ClientFetch } from "../src/server-client";

const makeFetch = (impl: ClientFetch) => vi.fn(impl);

const ok = (content: string): Promise<Response> =>
	Promise.resolve(
		{
			ok: true,
			status: 200,
			json: async () => ({
				id: "chatcmpl-1",
				object: "chat.completion",
				choices: [{ index: 0, message: { role: "assistant", content } }],
			}),
		} as unknown as Response
	);

const errorResponse = (status: number, message: string): Promise<Response> =>
	Promise.resolve(
		{
			ok: false,
			status,
			json: async () => ({ error: { message } }),
		} as unknown as Response
	);

type CapturedInit = { method?: string; headers?: unknown; body?: string };

function capturedCall(fetchImpl: ReturnType<typeof makeFetch>): [string, CapturedInit] {
	const [url, init] = fetchImpl.mock.calls[0] as [string, RequestInit | undefined];
	return [url, (init ?? {}) as CapturedInit];
}

describe("server client: chat", () => {
	it("requests POST {url}/chat/completions with the settings URL as-is", async () => {
		const fetchImpl = makeFetch(async () => ok("hi"));
		const client = createServerClient(fetchImpl);

		await client.chat(
			"http://localhost:1234/v1",
			"gpt-4o-mini",
			[{ role: "user", content: "hi" }]
		);

		expect(fetchImpl).toHaveBeenCalledTimes(1);
		const [url, init] = capturedCall(fetchImpl);
		expect(url).toBe("http://localhost:1234/v1/chat/completions");
		expect(init.method).toBe("POST");
	});

	it("sends messages as the full conversation history", async () => {
		const fetchImpl = makeFetch(async () => ok("hi"));
		const client = createServerClient(fetchImpl);

		await client.chat(
			"http://s",
			"gpt-4o-mini",
			[
				{ role: "user", content: "q1" },
				{ role: "assistant", content: "a1" },
				{ role: "user", content: "q2" },
			]
		);

		const [, init] = capturedCall(fetchImpl);
		const body = JSON.parse(init.body ?? "{}");
		expect(body.messages).toEqual([
			{ role: "user", content: "q1" },
			{ role: "assistant", content: "a1" },
			{ role: "user", content: "q2" },
		]);
	});

	it("prepends a system message when a system prompt is set", async () => {
		const fetchImpl = makeFetch(async () => ok("hi"));
		const client = createServerClient(fetchImpl);

		await client.chat(
			"http://s",
			"gpt-4o-mini",
			[{ role: "user", content: "q" }],
			{ systemPrompt: "You are terse." }
		);

		const [, init] = capturedCall(fetchImpl);
		const body = JSON.parse(init.body ?? "{}");
		expect(body.messages[0]).toEqual({
			role: "system",
			content: "You are terse.",
		});
		expect(body.messages).toHaveLength(2);
	});

	it("omits the system message when the system prompt is empty", async () => {
		const fetchImpl = makeFetch(async () => ok("hi"));
		const client = createServerClient(fetchImpl);

		await client.chat(
			"http://s",
			"gpt-4o-mini",
			[{ role: "user", content: "q" }],
			{ systemPrompt: "" }
		);

		const [, init] = capturedCall(fetchImpl);
		const body = JSON.parse(init.body ?? "{}");
		expect(body.messages).toHaveLength(1);
		expect(body.messages[0].role).toBe("user");
	});

	it("always sends stream: false", async () => {
		const fetchImpl = makeFetch(async () => ok("hi"));
		const client = createServerClient(fetchImpl);

		await client.chat("http://s", "gpt-4o-mini", [{ role: "user", content: "q" }]);

		const [, init] = capturedCall(fetchImpl);
		const body = JSON.parse(init.body ?? "{}");
		expect(body.stream).toBe(false);
	});

	it("sends the configured model", async () => {
		const fetchImpl = makeFetch(async () => ok("hi"));
		const client = createServerClient(fetchImpl);

		await client.chat("http://s", "my-model", [{ role: "user", content: "q" }]);

		const [, init] = capturedCall(fetchImpl);
		const body = JSON.parse(init.body ?? "{}");
		expect(body.model).toBe("my-model");
	});

	it("includes temperature/max_tokens/top_p only when set", async () => {
		const fetchImpl = makeFetch(async () => ok("hi"));
		const client = createServerClient(fetchImpl);

		await client.chat("http://s", "m", [{ role: "user", content: "q" }], {
			temperature: "0.7",
			maxTokens: "100",
			topP: "",
		});

		const [, init] = capturedCall(fetchImpl);
		const body = JSON.parse(init.body ?? "{}");
		expect(body.temperature).toBe(0.7);
		expect(body.max_tokens).toBe(100);
		expect(body).not.toHaveProperty("top_p");
	});

	it("omits all optional params when every field is empty", async () => {
		const fetchImpl = makeFetch(async () => ok("hi"));
		const client = createServerClient(fetchImpl);

		await client.chat("http://s", "m", [{ role: "user", content: "q" }]);

		const [, init] = capturedCall(fetchImpl);
		const body = JSON.parse(init.body ?? "{}");
		expect(body).not.toHaveProperty("temperature");
		expect(body).not.toHaveProperty("max_tokens");
		expect(body).not.toHaveProperty("top_p");
	});

	it("returns an error naming non-numeric params instead of sending the request", async () => {
		const fetchImpl = makeFetch(async () => ok("hi"));
		const client = createServerClient(fetchImpl);

		const result = await client.chat("http://s", "m", [{ role: "user", content: "q" }], {
			temperature: "abc",
			topP: "0.5",
		});

		expect(fetchImpl).not.toHaveBeenCalled();
		expect(result).toEqual({
			ok: false,
			error: { message: "Invalid generation parameters: temperature" },
		});
	});

	it("sends an Authorization header only when the key is set", async () => {
		const fetchImpl = makeFetch(async () => ok("hi"));
		const client = createServerClient(fetchImpl);

		await client.chat("http://s", "m", [{ role: "user", content: "q" }], { apiKey: "" });
		expect(
			new Headers((fetchImpl.mock.calls[0][1]?.headers ?? {}) as Record<string, string>).get(
				"authorization"
			)
		).toBeNull();

		fetchImpl.mockClear();
		await client.chat("http://s", "m", [{ role: "user", content: "q" }], { apiKey: "sk-test" });
		expect(
			new Headers((fetchImpl.mock.calls[0][1]?.headers ?? {}) as Record<string, string>).get(
				"authorization"
			)
		).toBe("Bearer sk-test");
	});

	it("sends the request body as JSON content type", async () => {
		const fetchImpl = makeFetch(async () => ok("hi"));
		const client = createServerClient(fetchImpl);

		await client.chat("http://s", "m", [{ role: "user", content: "q" }]);

		const [, init] = capturedCall(fetchImpl);
		const headers = new Headers(init.headers as Record<string, string>);
		expect(headers.get("content-type")).toBe("application/json");
	});

	it("maps the success body to the assistant message content", async () => {
		const fetchImpl = makeFetch(async () => ok("the answer"));
		const client = createServerClient(fetchImpl);

		const result = await client.chat("http://s", "m", [{ role: "user", content: "q" }]);

		expect(result).toEqual({ ok: true, value: "the answer" });
	});

	it("maps a non-2xx response with an error body to the body error message", async () => {
		const fetchImpl = makeFetch(
			async () => errorResponse(400, "The model `nope` does not exist")
		);
		const client = createServerClient(fetchImpl);

		const result = await client.chat("http://s", "nope", [{ role: "user", content: "q" }]);

		expect(result).toEqual({
			ok: false,
			error: { message: "The model `nope` does not exist" },
		});
	});

	it("maps a non-2xx response without a parseable body to a status error", async () => {
		const fetchImpl = makeFetch(
			async () =>
				({
					ok: false,
					status: 500,
					text: async () => "boom",
				}) as unknown as Response
		);
		const client = createServerClient(fetchImpl);

		const result = await client.chat("http://s", "m", [{ role: "user", content: "q" }]);

		expect(result).toEqual({
			ok: false,
			error: { message: "Model server responded with status 500" },
		});
	});

	it("maps a network failure to an error carrying the cause", async () => {
		const fetchImpl = makeFetch(async () => {
			throw new TypeError("fetch failed");
		});
		const client = createServerClient(fetchImpl);

		const result = await client.chat("http://s", "m", [{ role: "user", content: "q" }]);

		expect(result).toEqual({ ok: false, error: { message: "fetch failed" } });
	});

	it("maps an unparseable 2xx body to an error", async () => {
		const fetchImpl = makeFetch(
			async () =>
				({
					ok: true,
					status: 200,
					json: async () => {
						throw new Error("Unexpected token");
					},
				}) as unknown as Response
		);
		const client = createServerClient(fetchImpl);

		const result = await client.chat("http://s", "m", [{ role: "user", content: "q" }]);

		expect(result.ok).toBe(false);
		if (!result.ok) {
			expect(result.error.message.length).toBeGreaterThan(0);
		}
	});
});
