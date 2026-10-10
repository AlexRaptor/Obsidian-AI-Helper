import { parseResponseWait } from "./response-wait";

export type ClientFetch = (input: string, init?: RequestInit) => Promise<Response>;

const MODELS_TIMEOUT_MS = 15_000;
const MODEL_CHECK_TIMEOUT_MS = 60_000;

export interface Model {
	id: string;
}

export interface ModelListBody {
	object?: string;
	data?: Model[];
}

export interface ServerErrorBody {
	error?: { message?: string };
}

export type EmbeddingErrorCode = "embedding-config" | "embedding-auth" | "embedding-model" | "embedding-network" | "embedding-response";

export type ModelCheckErrorCode = "model-config" | "model-auth" | "model-unavailable" | "model-network" | "model-response";

type ClientErrorCode = ModelCheckErrorCode | EmbeddingErrorCode | "empty" | "incomplete" | "timeout" | "invalid-stream" | "stream-error" | "invalid-response-wait" | "invalid-params";

class ClientError extends Error {
	constructor(message: string, readonly code: ClientErrorCode) { super(message); }
}

export type ServerClientResult<T> =
	| { ok: true; value: T }
	| { ok: false; error: { message: string; code?: ClientErrorCode } };

export interface ChatMessage {
	role: "system" | "user" | "assistant";
	content: string;
}

export interface ChatParams {
	responseWait?: string;
	signal?: AbortSignal;
	onText?: (content: string) => void;
	apiKey?: string;
	systemPrompt?: string;
	temperature?: string;
	maxTokens?: string;
	topP?: string;
}

export interface ChatCompletionUsage {
	prompt_tokens?: number;
	completion_tokens?: number;
	total_tokens?: number;
}

export interface ChatCompletionBody {
	choices?: Array<{ message?: { content?: string } }>;
	usage?: ChatCompletionUsage;
}

export interface ChatCompletionResult {
	content: string;
	usage?: TokenUsage;
}

export interface TokenUsage {
	promptTokens: number;
	completionTokens: number;
	totalTokens: number;
}

export interface ServerClient {
	verifyModel(serverUrl: string, model: string, apiKey?: string, signal?: AbortSignal): Promise<ServerClientResult<void>>;
	embeddings(serverUrl: string, model: string, input: string[], apiKey?: string, signal?: AbortSignal): Promise<ServerClientResult<number[][]>>;
	listModels(serverUrl: string, apiKey?: string, signal?: AbortSignal): Promise<ServerClientResult<string[]>>;
	chat(
		serverUrl: string,
		model: string,
		messages: ChatMessage[],
		params?: ChatParams
	): Promise<ServerClientResult<ChatCompletionResult>>;
}

function connectionUrl(raw: string): string | undefined {
	try {
		const url = new URL(raw.trim());
		if (!["http:", "https:"].includes(url.protocol) || url.username || url.password || url.search || url.hash) return undefined;
		return url.href.replace(/\/+$/, "");
	} catch { return undefined; }
}

function bearerHeaders(apiKey?: string): Record<string, string> {
	const headers: Record<string, string> = {};
	if (apiKey) {
		headers.Authorization = `Bearer ${apiKey}`;
	}
	return headers;
}

async function readErrorMessage(response: Response): Promise<string> {
	let message = `Model server responded with status ${response.status}`;
	try {
		const body: unknown = await response.json();
		if (isRecord(body) && isRecord(body.error) && typeof body.error.message === "string" && body.error.message) {
			message = body.error.message;
		}
	} catch {
		// non-JSON error body: keep the status message
	}
	return message;
}

class UnsupportedStreamingError extends Error {}

function explicitlyRejectsStreaming(message: string): boolean {
	return /\bstream(?:ing)?(?:\s+(?:mode|parameter|responses?))?["']?\s+(?:is\s+)?(?:not supported|unsupported|not implemented|disabled)\b/i.test(message)
		|| /\b(?:unsupported|unrecognized|unknown)\s+(?:parameter|argument)\s*[:=]?\s*["']?stream["']?\b/i.test(message)
		|| /\b(?:does not|doesn't|cannot)\s+support\s+(?:the\s+)?(?:streaming|stream(?:\s+parameter)?)\b/i.test(message);
}

function isRecord(value: unknown): value is Record<string, unknown> {
	return typeof value === "object" && value !== null && !Array.isArray(value);
}

function parseUsage(raw: unknown): TokenUsage | undefined {
	if (!isRecord(raw)) return undefined;
	const values = [raw.prompt_tokens, raw.completion_tokens, raw.total_tokens];
	if (values.every((value) => value === undefined) || values.some((value) =>
		value !== undefined && (typeof value !== "number" || !Number.isSafeInteger(value) || value < 0)
	)) return undefined;
	const promptTokens = typeof raw.prompt_tokens === "number" ? raw.prompt_tokens : 0;
	const completionTokens = typeof raw.completion_tokens === "number" ? raw.completion_tokens : 0;
	const totalTokens = typeof raw.total_tokens === "number" ? raw.total_tokens : promptTokens + completionTokens;
	if (!Number.isSafeInteger(totalTokens)) return undefined;
	return { promptTokens, completionTokens, totalTokens };
}

function numericParam(
	raw: string | undefined,
	invalid: string[],
	name: string
): number | undefined {
	if (raw === undefined || raw.trim() === "") return undefined;
	const value = Number(raw);
	if (!Number.isFinite(value)) {
		invalid.push(name);
		return undefined;
	}
	return value;
}

export function createServerClient(fetchImpl: ClientFetch): ServerClient {
	async function request<T>(
		operation: (signal: AbortSignal, resetWait: () => void) => Promise<ServerClientResult<T>>,
		timeoutMs: number | undefined,
		signal?: AbortSignal,
		timeoutCode?: "timeout"
	): Promise<ServerClientResult<T>> {
		const controller = new AbortController();
		let interrupt!: (result: ServerClientResult<T>) => void;
		const interrupted = new Promise<ServerClientResult<T>>((resolve) => { interrupt = resolve; });
		const cancel = (message: string, code?: "timeout") => {
			interrupt({ ok: false, error: { message, ...(code ? { code } : {}) } });
			controller.abort();
		};
		const onAbort = () => cancel("Request cancelled.");
		signal?.addEventListener("abort", onAbort, { once: true });
		let timer: ReturnType<typeof setTimeout> | undefined;
		let deadline = 0;
		const scheduleWait = () => {
			const remaining = deadline - Date.now();
			if (remaining <= 0) cancel("Model server request timed out.", timeoutCode);
			else timer = setTimeout(scheduleWait, Math.min(remaining, 2_147_483_647));
		};
		const resetWait = () => {
			if (timeoutMs === undefined || controller.signal.aborted) return;
			clearTimeout(timer);
			deadline = Date.now() + timeoutMs;
			scheduleWait();
		};
		resetWait();
		try {
			if (signal?.aborted) {
				onAbort();
				return await interrupted;
			}
			return await Promise.race([operation(controller.signal, resetWait), interrupted]);
		} catch (error) {
			return { ok: false, error: { message: error instanceof Error ? error.message : String(error),
				...(error instanceof ClientError ? { code: error.code } : {}) } };
		} finally {
			clearTimeout(timer);
			signal?.removeEventListener("abort", onAbort);
		}
	}

	async function listModels(serverUrl: string, apiKey?: string, signal?: AbortSignal): Promise<ServerClientResult<string[]>> {
		return request(async (requestSignal) => {
			const response = await fetchImpl(`${serverUrl}/models`, {
				method: "GET", headers: bearerHeaders(apiKey), signal: requestSignal,
			});
			if (!response.ok) {
				return { ok: false, error: { message: await readErrorMessage(response) } };
			}
			let data: unknown;
			try {
				data = await response.json();
			} catch {
				return { ok: false, error: { message: "Model server returned an unparseable model list." } };
			}
			if (!isRecord(data) || !Array.isArray(data.data)) {
				return { ok: false, error: { message: "Model server returned an invalid model list." } };
			}
			const ids: string[] = [];
			for (const model of data.data) {
				if (!isRecord(model) || typeof model.id !== "string") {
					return { ok: false, error: { message: "Model server returned an invalid model list." } };
				}
				if (model.id.length > 0) ids.push(model.id);
			}
			return { ok: true, value: ids };
		}, MODELS_TIMEOUT_MS, signal);
	}

	async function chat(
		serverUrl: string,
		model: string,
		messages: ChatMessage[],
		params?: ChatParams
	): Promise<ServerClientResult<ChatCompletionResult>> {
		const url = `${serverUrl}/chat/completions`;

		const body: Record<string, unknown> = {
			model,
			messages: [
				...(params?.systemPrompt ? [{ role: "system", content: params.systemPrompt }] : []),
				...messages,
			],
			stream: true,
			stream_options: { include_usage: true },
		};

		const invalidParams: string[] = [];
		const temperature = numericParam(params?.temperature, invalidParams, "temperature");
		if (temperature !== undefined) body.temperature = temperature;
		const maxTokens = numericParam(params?.maxTokens, invalidParams, "max_tokens");
		if (maxTokens !== undefined) body.max_tokens = maxTokens;
		const topP = numericParam(params?.topP, invalidParams, "top_p");
		if (topP !== undefined) body.top_p = topP;

		if (invalidParams.length > 0) {
			return {
				ok: false,
				error: {
					code: "invalid-params",
					message: `Invalid generation parameters: ${invalidParams.join(", ")}`,
				},
			};
		}

		const headers: Record<string, string> = {
			"Content-Type": "application/json",
			...bearerHeaders(params?.apiKey),
		};

		const responseWait = parseResponseWait(params?.responseWait);
		if (!responseWait.valid) {
			return { ok: false, error: { code: "invalid-response-wait", message: "Response wait must be a positive whole number of seconds." } };
		}
		const timeoutMs = responseWait.seconds === undefined ? undefined : responseWait.seconds * 1000;

		return request(async (signal, resetWait) => {
			const attempt = async (streaming: boolean): Promise<ServerClientResult<ChatCompletionResult>> => {
				const requestBody: Record<string, unknown> = { ...body, stream: streaming };
				if (!streaming) delete requestBody.stream_options;
				const reject = (message: string): ServerClientResult<ChatCompletionResult> => {
					if (streaming && explicitlyRejectsStreaming(message)) throw new UnsupportedStreamingError(message);
					return { ok: false, error: { message } };
				};
				const response = await fetchImpl(url, {
					method: "POST",
					headers,
					body: JSON.stringify(requestBody),
					signal,
				});
				if (!response.ok) return reject(await readErrorMessage(response));

				const fail = (code: "empty" | "incomplete"): ServerClientResult<ChatCompletionResult> => ({
					ok: false, error: { code, message: code === "empty"
						? "Model server returned an empty response." : "Model server connection closed before completion." },
				});
				if (!response.headers?.get("content-type")?.includes("text/event-stream")) {
					let data: unknown;
					try { data = await response.json(); } catch {
						return { ok: false, error: { message: "Model server returned an unparseable response." } };
					}
					if (isRecord(data) && isRecord(data.error) && typeof data.error.message === "string") {
						return reject(data.error.message);
					}
					if (!isRecord(data) || !Array.isArray(data.choices) || !isRecord(data.choices[0]) ||
						!isRecord(data.choices[0].message) || typeof data.choices[0].message.content !== "string" ||
						!data.choices[0].message.content.trim()) return fail("empty");
					const content = data.choices[0].message.content;
					if (signal.aborted) return fail("incomplete");
					resetWait();
					params?.onText?.(content);
					return { ok: true, value: { content, usage: parseUsage(data.usage) } };
				}
				if (!response.body) return fail("incomplete");
				const reader = response.body.getReader();
				const decoder = new TextDecoder();
				let line = "";
				let afterCR = false;
				let dataLines: string[] = [];
				let content = "";
				let usage: TokenUsage | undefined;
				let completed = false;
				let done = false;
				const event = (data: string) => {
					if (!data) return;
					if (data.trim() === "[DONE]") { completed = true; done = true; return; }
					let parsed: unknown;
					try { parsed = JSON.parse(data); } catch {
						if (completed) return;
						throw new ClientError("Model server returned an invalid stream event.", "invalid-stream");
					}
					if (!isRecord(parsed)) {
						if (completed) return;
						throw new ClientError("Model server returned an invalid stream event.", "invalid-stream");
					}
					if (parsed.usage !== undefined) usage = parseUsage(parsed.usage);
					// Completion is final. Only collect usage already available in this transport chunk.
					if (completed) return;
					if (isRecord(parsed.error)) {
						if (typeof parsed.error.message !== "string" || !parsed.error.message) {
							throw new ClientError("Model server returned a stream error.", "stream-error");
						}
						const message = parsed.error.message;
						if (streaming && !content && explicitlyRejectsStreaming(message)) throw new UnsupportedStreamingError(message);
						throw new Error(message);
					}
					if (!Array.isArray(parsed.choices)) return;
					const choice = parsed.choices.find((value: unknown) => isRecord(value) && (value.index === 0 || value.index === undefined));
					if (!isRecord(choice)) return;
					if (isRecord(choice.delta) && typeof choice.delta.content === "string" && choice.delta.content) {
						content += choice.delta.content;
						if (!signal.aborted) { resetWait(); params?.onText?.(content); }
					}
					if (typeof choice.finish_reason === "string" && choice.finish_reason) completed = true;
				};
				const endLine = () => {
					if (line === "") {
						const data = dataLines.join("\n");
						dataLines = [];
						event(data);
					} else if (line === "data" || line.startsWith("data:")) {
						dataLines.push(line === "data" ? "" : line.slice(5).replace(/^ /, ""));
					}
					line = "";
				};
				const consume = (text: string) => {
					for (const character of text) {
						if (done) break;
						if (afterCR) {
							afterCR = false;
							if (character === "\n") continue;
						}
						if (character === "\r" || character === "\n") {
							endLine();
							afterCR = character === "\r";
						} else line += character;
					}
				};
				const onAbort = () => { void reader.cancel().catch(() => {}); };
				signal.addEventListener("abort", onAbort, { once: true });
				try {
					while (!completed && !signal.aborted) {
						const part = await reader.read();
						consume(part.done ? decoder.decode() : decoder.decode(part.value, { stream: true }));
						if (part.done) break;
					}
					if (signal.aborted || !completed) return fail("incomplete");
					if (!content.trim()) return fail("empty");
					return { ok: true, value: { content, usage } };
				} finally {
					signal.removeEventListener("abort", onAbort);
					// Do not make confirmed completion wait for the transport cancellation handshake.
					void reader.cancel().catch(() => {});
					reader.releaseLock();
				}

			};
			try {
				return await attempt(true);
			} catch (error) {
				if (!(error instanceof UnsupportedStreamingError) || signal.aborted) throw error;
				// One explicit compatibility fallback shares cancellation and the request's waiting policy.
				return await attempt(false);
			}
		}, timeoutMs, params?.signal, "timeout");
	}

	async function embeddings(serverUrl: string, model: string, input: string[], apiKey?: string, signal?: AbortSignal): Promise<ServerClientResult<number[][]>> {
		const fail = (code: EmbeddingErrorCode): ServerClientResult<number[][]> => ({ ok: false, error: { code, message: code } });
		const url = connectionUrl(serverUrl);
		if (!url) return fail("embedding-config");
		if (!model.trim() || !input.length || input.some((text) => !text.trim())) return fail("embedding-config");
		const result = await request<number[][]>(async (requestSignal) => {
			const response = await fetchImpl(`${url}/embeddings`, {
				method: "POST", headers: { "Content-Type": "application/json", ...bearerHeaders(apiKey) },
				body: JSON.stringify({ model: model.trim(), input, encoding_format: "float" }), signal: requestSignal,
			});
			if (!response.ok) return fail(response.status === 401 || response.status === 403 ? "embedding-auth"
				: [400, 404, 405, 422].includes(response.status) ? "embedding-model" : "embedding-network");
			let body: unknown;
			try { body = await response.json(); } catch { return fail("embedding-response"); }
			if (!isRecord(body) || !Array.isArray(body.data) || body.data.length !== input.length) return fail("embedding-response");
			const vectors: number[][] = new Array(input.length);
			let dimensions = 0;
			for (const item of body.data) {
				if (!isRecord(item) || typeof item.index !== "number" || !Number.isSafeInteger(item.index) ||
					item.index < 0 || item.index >= input.length || vectors[item.index] !== undefined ||
					!Array.isArray(item.embedding) || !item.embedding.length ||
					item.embedding.some((value) => typeof value !== "number" || !Number.isFinite(value))) return fail("embedding-response");
				const vector: number[] = item.embedding;
				const norm = vector.reduce((length, value) => Math.hypot(length, value), 0);
				if (!Number.isFinite(norm) || norm === 0 || (dimensions !== 0 && dimensions !== vector.length)) return fail("embedding-response");
				dimensions = vector.length;
				vectors[item.index] = vector;
			}
			return { ok: true, value: vectors };
		}, MODELS_TIMEOUT_MS, signal);
		return !result.ok && !result.error.code ? fail("embedding-network") : result;
	}

	async function verifyModel(serverUrl: string, model: string, apiKey?: string, signal?: AbortSignal): Promise<ServerClientResult<void>> {
		const fail = (code: ModelCheckErrorCode): ServerClientResult<void> => ({ ok: false, error: { code, message: code } });
		const url = connectionUrl(serverUrl);
		if (!url || !model.trim()) return fail("model-config");
		const result = await request<void>(async (requestSignal) => {
			const response = await fetchImpl(`${url}/chat/completions`, {
				method: "POST", headers: { "Content-Type": "application/json", ...bearerHeaders(apiKey) },
				body: JSON.stringify({ model: model.trim(), messages: [{ role: "user", content: "Reply with OK." }], stream: false, max_tokens: 8 }),
				signal: requestSignal,
			});
			if (!response.ok) return fail(response.status === 401 || response.status === 403 ? "model-auth"
				: [400, 404, 405, 422].includes(response.status) ? "model-unavailable" : "model-network");
			let body: unknown;
			try { body = await response.json(); } catch { return fail("model-response"); }
			if (!isRecord(body) || !Array.isArray(body.choices) || !isRecord(body.choices[0]) || !isRecord(body.choices[0].message)) return fail("model-response");
			const message = body.choices[0].message;
			// A reasoning model may spend the short check budget on reasoning before emitting its answer.
			if (![message.content, message.reasoning_content].some((text) => typeof text === "string" && text.trim())) return fail("model-response");
			return { ok: true, value: undefined };
		}, MODEL_CHECK_TIMEOUT_MS, signal);
		return !result.ok && !result.error.code ? fail("model-network") : result;
	}

	return { listModels, chat, embeddings, verifyModel };
}
