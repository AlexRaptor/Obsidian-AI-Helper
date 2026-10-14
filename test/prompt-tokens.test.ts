import { afterEach, beforeEach, expect, it, vi } from "vitest";
import { createServerClient, type ChatMessage } from "../src/server-client";
import { conservativePromptTokens } from "../src/prompt-tokens";
import { deferred, flushPromises } from "./helpers/obsidian";

const sdk = vi.hoisted(() => ({ create: vi.fn(), list: vi.fn(), template: vi.fn(), count: vi.fn(), dispose: vi.fn() }));
vi.mock("@lmstudio/sdk", () => ({ LMStudioClient: class {
	llm = { listLoaded: sdk.list };
	constructor(options: unknown) { sdk.create(options); }
	[Symbol.asyncDispose]() { return sdk.dispose(); }
} }));

const messages: ChatMessage[] = [
	{ role: "system", content: "Проверь назначение папок и объясни выбор." },
	{ role: "assistant", content: "Обсуждали активный проект." },
	{ role: "user", content: JSON.stringify({ note: "План поездки 🧳", folders: [{ folder: "Проекты", text: "Активные проекты." }] }) },
];
const loaded = () => ({ identifier: "экземпляр", applyPromptTemplate: sdk.template, countTokens: sdk.count });
const metadata = (loaded_instances: unknown[] = [{ id: "экземпляр" }]) => ({ models: [{ type: "llm", key: "модель", loaded_instances }] });
function server(body: unknown = metadata()) {
	const fetch = vi.fn(async (_url: string, _init?: RequestInit) => new Response(JSON.stringify(body)));
	return { fetch, client: createServerClient(fetch) };
}
beforeEach(() => {
	vi.resetAllMocks();
	sdk.list.mockResolvedValue([loaded()]); sdk.template.mockResolvedValue("Шаблон диалога с началом ответа");
	sdk.count.mockResolvedValue(123); sdk.dispose.mockResolvedValue(undefined);
});
afterEach(() => { vi.useRealTimers(); });

it("считает весь запрос токенизатором выбранного загруженного экземпляра, сохраняя сервер, прокси и ключ", async () => {
	const { fetch, client } = server();
	expect(await client.countPromptTokens("https://server/proxy/v1/", "модель", messages, "lms-test")).toEqual({ tokens: 123, method: "lmstudio" });
	expect(fetch).toHaveBeenCalledWith("https://server/proxy/api/v1/models", expect.objectContaining({ headers: { Authorization: "Bearer lms-test" } }));
	expect(sdk.create).toHaveBeenCalledWith(expect.objectContaining({ baseUrl: "wss://server/proxy", apiToken: "lms-test" }));
	expect(sdk.template).toHaveBeenCalledWith(messages);
	expect(sdk.count).toHaveBeenCalledWith("Шаблон диалога с началом ответа");
	expect(sdk.dispose).toHaveBeenCalledTimes(1);
	expect(fetch).toHaveBeenCalledTimes(1); // No generation or requests to other servers.
});

it("использует localhost для локального подсчёта и допускает выбор по идентификатору экземпляра", async () => {
	const { fetch, client } = server();
	expect(await client.countPromptTokens("http://127.0.0.1:1234/v1", "экземпляр", messages)).toMatchObject({ method: "lmstudio" });
	expect(fetch.mock.calls[0][0]).toBe("http://127.0.0.1:1234/api/v1/models");
	expect(sdk.create).toHaveBeenCalledWith(expect.objectContaining({ baseUrl: "ws://127.0.0.1:1234", apiToken: undefined }));
});

it.each([metadata([]), metadata([{ id: "а" }, { id: "б" }]), { models: [{ type: "llm", key: "другая", loaded_instances: [{ id: "чужой" }] }] }, { data: [] }])(
	"сохраняет оценку по байтам для незагруженной, неоднозначной или неподдерживаемой модели", async body => {
		const { client } = server(body);
		expect(await client.countPromptTokens("http://s/v1", "модель", messages)).toEqual(conservativePromptTokens(messages));
		expect(sdk.create).not.toHaveBeenCalled();
	}
);

it("не подменяет выбранную модель другим загруженным экземпляром", async () => {
	sdk.list.mockResolvedValue([{ ...loaded(), identifier: "чужой" }]);
	expect(await server().client.countPromptTokens("http://s/v1", "модель", messages)).toEqual(conservativePromptTokens(messages));
	expect(sdk.template).not.toHaveBeenCalled(); expect(sdk.dispose).toHaveBeenCalledTimes(1);
});

it.each([0, -1, 1.5, "123", null, Number.MAX_SAFE_INTEGER + 1])("не доверяет некорректному числу токенов %s", async tokens => {
	sdk.count.mockResolvedValue(tokens);
	expect(await server().client.countPromptTokens("http://s/v1", "модель", messages)).toEqual(conservativePromptTokens(messages));
});

it.each(["list", "template", "count"] as const)("при ошибке SDK на этапе %s сохраняет консервативную оценку и освобождает клиент", async stage => {
	sdk[stage].mockRejectedValue(new Error("Недоступно"));
	expect(await server().client.countPromptTokens("http://s/v1", "модель", messages)).toEqual(conservativePromptTokens(messages));
	expect(sdk.dispose).toHaveBeenCalledTimes(1);
});

it.each([401, 404, 500])("не запускает SDK при HTTP-ошибке %s", async status => {
	const client = createServerClient(async () => new Response("Недоступно", { status }));
	expect(await client.countPromptTokens("http://s/v1", "модель", messages)).toEqual(conservativePromptTokens(messages));
	expect(sdk.create).not.toHaveBeenCalled();
});

it("ограничивает ожидание метаданных и отменяет сетевой запрос", async () => {
	vi.useFakeTimers();
	const pending = deferred<Response>(); let active: AbortSignal | undefined;
	const client = createServerClient(async (_url, init) => { active = init?.signal ?? undefined; return pending.promise; });
	const count = client.countPromptTokens("http://s/v1", "модель", messages);
	await vi.advanceTimersByTimeAsync(5000);
	expect(await count).toEqual(conservativePromptTokens(messages)); expect(active?.aborted).toBe(true);
	pending.resolve(new Response(JSON.stringify(metadata()))); await flushPromises();
	expect(sdk.create).not.toHaveBeenCalled();
});

it.each(["отмена", "таймаут"])("%s прекращает подсчёт и игнорирует поздний шаблон без следующего SDK-запроса", async reason => {
	vi.useFakeTimers();
	const pending = deferred<string>(); sdk.template.mockReturnValue(pending.promise);
	const active = new AbortController();
	const count = server().client.countPromptTokens("http://s/v1", "модель", messages, undefined, active.signal);
	await vi.waitFor(() => expect(sdk.template).toHaveBeenCalled());
	if (reason === "отмена") active.abort(); else await vi.advanceTimersByTimeAsync(5000);
	expect(await count).toEqual(conservativePromptTokens(messages)); expect(sdk.dispose).toHaveBeenCalledTimes(1);
	pending.resolve("Поздний шаблон"); await flushPromises();
	expect(sdk.count).not.toHaveBeenCalled(); expect(sdk.dispose).toHaveBeenCalledTimes(1);
});

it("для некорректного адреса и заранее отменённого запроса не отправляет данные", async () => {
	const { client, fetch } = server(); const active = new AbortController(); active.abort();
	expect(await client.countPromptTokens("http://s/v1", "модель", messages, undefined, active.signal)).toEqual(conservativePromptTokens(messages));
	expect(await client.countPromptTokens("file:///заметки", "модель", messages)).toEqual(conservativePromptTokens(messages));
	expect(fetch).not.toHaveBeenCalled(); expect(sdk.create).not.toHaveBeenCalled();
});

function nativeServer(kind: "vllm" | "llamacpp", overrides: Record<string, unknown> = {}) {
	const routes: Record<string, unknown> = {
		"https://s/proxy/v1/models": { data: [{ id: "другая" }, { id: "модель/русская", ...(kind === "vllm" ? { max_model_len: 8192 } : {}) }] },
		["https://s/proxy/props?model=" + encodeURIComponent("модель/русская") + "&autoload=false"]: { default_generation_settings: { n_ctx: 8192 } },
		"https://s/proxy/apply-template?autoload=false": { prompt: "<bos>Диалог с началом ответа" },
		[kind === "vllm" ? "https://s/proxy/tokenize" : "https://s/proxy/tokenize?autoload=false"]: { tokens: [1, 2, 3], count: 3 },
		...overrides,
	};
	const fetch = vi.fn(async (url: string, _init?: RequestInit) => url in routes
		? new Response(JSON.stringify(routes[url])) : new Response("Не найдено", { status: 404 }));
	return { fetch, client: createServerClient(fetch) };
}

it("vLLM применяет шаблон и считает все сообщения одним запросом без генерации", async () => {
	const { client, fetch } = nativeServer("vllm");
	expect(await client.countPromptTokens("https://s/proxy/v1/", "модель/русская", messages, "ключ")).toEqual({ tokens: 3, method: "vllm" });
	const posts = fetch.mock.calls.filter(([, init]) => init?.method === "POST");
	expect(posts).toHaveLength(1);
	expect(posts[0][0]).toBe("https://s/proxy/tokenize");
	expect(JSON.parse(String(posts[0][1]?.body))).toEqual({ model: "модель/русская", messages, add_generation_prompt: true, add_special_tokens: false });
	expect(fetch.mock.calls.every(([url, init]) => url.startsWith("https://s/proxy/") &&
		(init?.headers as Record<string, string>).Authorization === "Bearer ключ" && init?.signal instanceof AbortSignal)).toBe(true);
	expect(sdk.create).not.toHaveBeenCalled();
});

it("llama.cpp токенизирует серверный шаблон с теми же специальными токенами, что запрос ответа", async () => {
	const { client, fetch } = nativeServer("llamacpp");
	expect(await client.countPromptTokens("https://s/proxy/v1", "модель/русская", messages, "ключ")).toEqual({ tokens: 3, method: "llamacpp" });
	const posts = fetch.mock.calls.filter(([, init]) => init?.method === "POST");
	expect(posts.map(([url]) => url)).toEqual(["https://s/proxy/apply-template?autoload=false", "https://s/proxy/tokenize?autoload=false"]);
	expect(JSON.parse(String(posts[0][1]?.body))).toEqual({ model: "модель/русская", messages });
	expect(JSON.parse(String(posts[1][1]?.body))).toEqual({ model: "модель/русская", content: "<bos>Диалог с началом ответа",
		add_special: true, parse_special: true, with_pieces: false });
	expect(fetch.mock.calls.every(([url, init]) => url.startsWith("https://s/proxy/") &&
		(init?.headers as Record<string, string>).Authorization === "Bearer ключ")).toBe(true);
	expect(sdk.create).not.toHaveBeenCalled();
});

it.each(["vllm", "llamacpp"] as const)("%s не отправляет текст без однозначного соответствия выбранной модели", async kind => {
	for (const data of [[{ id: "чужая", max_model_len: 8192 }], [{ id: "модель/русская" }, { id: "модель/русская" }]]) {
		const { client, fetch } = nativeServer(kind, { "https://s/proxy/v1/models": { data } });
		expect(await client.countPromptTokens("https://s/proxy/v1", "модель/русская", messages)).toEqual(conservativePromptTokens(messages));
		expect(fetch.mock.calls.some(([, init]) => init?.method === "POST")).toBe(false);
	}
});

it.each([{}, { tokens: [] }, { tokens: ["1"], count: 1 }, { tokens: [-1], count: 1 }, { tokens: [1.5], count: 1 },
	{ tokens: [1], count: 2 }, { tokens: [1], count: "1" }, { tokens: [Number.MAX_SAFE_INTEGER + 1], count: 1 }])(
	"vLLM не доверяет некорректному результату токенизации %j", async body => {
		const { client } = nativeServer("vllm", { "https://s/proxy/tokenize": body });
		expect(await client.countPromptTokens("https://s/proxy/v1", "модель/русская", messages)).toEqual(conservativePromptTokens(messages));
	}
);

it.each([{}, { tokens: [] }, { tokens: ["1"] }, { tokens: [-1] }, { tokens: [1.5] }, { tokens: [Number.MAX_SAFE_INTEGER + 1] }])(
	"llama.cpp не доверяет некорректному результату токенизации %j", async body => {
		const { client } = nativeServer("llamacpp", { "https://s/proxy/tokenize?autoload=false": body });
		expect(await client.countPromptTokens("https://s/proxy/v1", "модель/русская", messages)).toEqual(conservativePromptTokens(messages));
	}
);

it.each([{}, { prompt: "" }, { prompt: 12 }])("llama.cpp не считает сообщения как простой текст без серверного шаблона %j", async body => {
	const { client, fetch } = nativeServer("llamacpp", { "https://s/proxy/apply-template?autoload=false": body });
	expect(await client.countPromptTokens("https://s/proxy/v1", "модель/русская", messages)).toEqual(conservativePromptTokens(messages));
	expect(fetch.mock.calls.some(([url]) => url.endsWith("/tokenize?autoload=false"))).toBe(false);
});

it("llama.cpp не использует глобальный токенизатор при недоступных свойствах выбранной модели", async () => {
	const { client, fetch } = nativeServer("llamacpp", {
		["https://s/proxy/props?model=" + encodeURIComponent("модель/русская") + "&autoload=false"]: { default_generation_settings: { n_ctx: 0 } },
	});
	expect(await client.countPromptTokens("https://s/proxy/v1", "модель/русская", messages)).toEqual(conservativePromptTokens(messages));
	expect(fetch.mock.calls.some(([, init]) => init?.method === "POST")).toBe(false);
});

it.each(["vllm", "llamacpp"] as const)("ошибка метаданных LM Studio не мешает доступному адаптеру %s", async kind => {
	const { fetch } = nativeServer(kind);
	const client = createServerClient(async (url, init) => {
		if (url.endsWith("/api/v1/models")) throw new Error("Маршрут недоступен");
		return fetch(url, init);
	});
	expect(await client.countPromptTokens("https://s/proxy/v1", "модель/русская", messages)).toMatchObject({ tokens: 3, method: kind });
});

it.each(["vllm", "llamacpp"] as const)("таймаут %s отменяет запрос и не продолжает обработку позднего результата", async kind => {
	vi.useFakeTimers();
	const { fetch } = nativeServer(kind); const pending = deferred<Response>();
	let countingSignal: AbortSignal | undefined;
	const blocked = kind === "vllm" ? "/tokenize" : "/apply-template?autoload=false";
	const client = createServerClient(async (url, init) => {
		if (url.endsWith(blocked)) { countingSignal = init?.signal ?? undefined; return pending.promise; }
		return fetch(url, init);
	});
	const count = client.countPromptTokens("https://s/proxy/v1", "модель/русская", messages);
	await vi.waitFor(() => expect(countingSignal).toBeDefined());
	await vi.advanceTimersByTimeAsync(5000);
	expect(await count).toEqual(conservativePromptTokens(messages)); expect(countingSignal?.aborted).toBe(true);
	pending.resolve(new Response(JSON.stringify({ prompt: "Поздний шаблон", count: 3, tokens: [1, 2, 3] }))); await flushPromises();
	expect(fetch.mock.calls.some(([url]) => url.endsWith("/tokenize?autoload=false"))).toBe(false);
});

it("Ollama сохраняет оценку по байтам и не запускает пробную генерацию или скрытый токенизатор", async () => {
	const calls: string[] = [];
	const client = createServerClient(async (url, init) => {
		calls.push(url); expect(init?.method).not.toBe("POST");
		if (url.endsWith("/models")) return new Response(JSON.stringify({ data: [{ id: "модель" }] }));
		return new Response("Не поддерживается", { status: 404 });
	});
	expect(await client.countPromptTokens("http://127.0.0.1:11434/v1", "модель", messages)).toEqual(conservativePromptTokens(messages));
	expect(calls.every(url => url.startsWith("http://127.0.0.1:11434/"))).toBe(true);
	expect(calls.some(url => url.includes("/chat") || url.includes("/generate") || url.includes("/tokenize"))).toBe(false);
});

it.each(["vllm", "llamacpp"] as const)("HTTP-ошибки и некорректный JSON токенизации %s сохраняют оценку по байтам", async kind => {
	for (const status of [200, 401, 404, 500]) {
		const { fetch } = nativeServer(kind);
		const client = createServerClient(async (url, init) => url.includes("/tokenize")
			? new Response("Некорректный ответ", { status }) : fetch(url, init));
		expect(await client.countPromptTokens("https://s/proxy/v1", "модель/русская", messages)).toEqual(conservativePromptTokens(messages));
	}
});
