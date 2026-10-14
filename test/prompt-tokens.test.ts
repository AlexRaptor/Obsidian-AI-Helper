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
