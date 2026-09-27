import { describe, expect, it, vi } from "vitest";
import { createServerClient, type ClientFetch } from "../src/server-client";

const makeFetch = (impl: ClientFetch) => vi.fn(impl);

const ok = (models: string[]): Promise<Response> =>
	Promise.resolve(
		{
			ok: true,
			status: 200,
			json: async () => ({
				object: "list",
				data: models.map((id) => ({ object: "model", id })),
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

describe("server client: listModels", () => {
	it("requests GET {url}/models with the settings URL as-is", async () => {
		const fetchImpl = makeFetch(async () => ok(["m1"]));
		const client = createServerClient(fetchImpl);

		await client.listModels("http://localhost:1234/v1");

		expect(fetchImpl).toHaveBeenCalledTimes(1);
		const [url, init] = fetchImpl.mock.calls[0];
		expect(url).toBe("http://localhost:1234/v1/models");
		expect(init?.method ?? "GET").toBe("GET");
	});

	it("appends /models to a URL that already ends with a slash", async () => {
		const fetchImpl = makeFetch(async () => ok(["m1"]));
		const client = createServerClient(fetchImpl);

		await client.listModels("http://localhost:1234/v1/");

		expect(fetchImpl.mock.calls[0][0]).toBe("http://localhost:1234/v1//models");
	});

	it("sends an Authorization header only when the key is set", async () => {
		const fetchImpl = makeFetch(async () => ok(["m1"]));
		const client = createServerClient(fetchImpl);

		await client.listModels("http://s", "");
		const noKeyHeaders = new Headers(fetchImpl.mock.calls[0][1]?.headers);
		expect(noKeyHeaders.get("authorization")).toBeNull();

		fetchImpl.mockClear();
		await client.listModels("http://s", "sk-test");
		const keyedHeaders = new Headers(fetchImpl.mock.calls[0][1]?.headers);
		expect(keyedHeaders.get("authorization")).toBe("Bearer sk-test");
	});

	it("maps the success body to the list of model names", async () => {
		const fetchImpl = makeFetch(async () => ok(["alpha", "beta"]));
		const client = createServerClient(fetchImpl);

		const result = await client.listModels("http://s");
		expect(result.ok).toBe(true);
		if (result.ok) {
			expect(result.value).toEqual(["alpha", "beta"]);
		}
	});

	it("resolves to an empty list when the server returns an empty list", async () => {
		const fetchImpl = makeFetch(async () => ok([]));
		const client = createServerClient(fetchImpl);

		const result = await client.listModels("http://s");
		expect(result.ok).toBe(true);
		if (result.ok) {
			expect(result.value).toEqual([]);
		}
	});

	it("maps a non-2xx response to a ServerError carrying the body error message", async () => {
		const fetchImpl = makeFetch(async () => errorResponse(401, "Invalid API key"));
		const client = createServerClient(fetchImpl);

		const result = await client.listModels("http://s", "bad");
		expect(result).toEqual({ ok: false, error: { message: "Invalid API key" } });
	});

	it("maps a non-2xx response without a parseable body to a ServerError with the status", async () => {
		const fetchImpl = makeFetch(
			async () =>
				({
					ok: false,
					status: 502,
					text: async () => "<html>Bad Gateway</html>",
				}) as unknown as Response
		);
		const client = createServerClient(fetchImpl);

		const result = await client.listModels("http://s");
		expect(result).toEqual({
			ok: false,
			error: { message: "Model server responded with status 502" },
		});
	});

	it("maps a network failure to a ServerError carrying the cause", async () => {
		const fetchImpl = makeFetch(
			async () => {
				throw new TypeError("fetch failed");
			}
		);
		const client = createServerClient(fetchImpl);

		const result = await client.listModels("http://s");
		expect(result).toEqual({ ok: false, error: { message: "fetch failed" } });
	});

	it("maps an unparseable 2xx body to a ServerError", async () => {
		const fetchImpl = makeFetch(
			async () =>
				({
					ok: true,
					status: 200,
					text: async () => "not json",
					json: async () => {
						throw new Error("Unexpected token");
					},
				}) as unknown as Response
		);
		const client = createServerClient(fetchImpl);

		const result = await client.listModels("http://s");
		expect(result.ok).toBe(false);
		if (!result.ok) {
			expect(result.error.message.length).toBeGreaterThan(0);
		}
	});
});
