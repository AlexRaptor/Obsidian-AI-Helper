export type ClientFetch = (input: string, init?: RequestInit) => Promise<Response>;

const MODELS_TIMEOUT_MS = 15_000;

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

export type ServerClientResult<T> =
	| { ok: true; value: T }
	| { ok: false; error: { message: string; code?: "empty" | "incomplete" | "timeout" } };

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
	listModels(serverUrl: string, apiKey?: string, signal?: AbortSignal): Promise<ServerClientResult<string[]>>;
	chat(
		serverUrl: string,
		model: string,
		messages: ChatMessage[],
		params?: ChatParams
	): Promise<ServerClientResult<ChatCompletionResult>>;
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
			return { ok: false, error: { message: error instanceof Error ? error.message : String(error) } };
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
					message: `Invalid generation parameters: ${invalidParams.join(", ")}`,
				},
			};
		}

		const headers: Record<string, string> = {
			"Content-Type": "application/json",
			...bearerHeaders(params?.apiKey),
		};

		const responseWait = params?.responseWait?.trim() ?? "";
		const seconds = responseWait ? Number(responseWait) : undefined;
		if (seconds !== undefined && (!/^\d+$/.test(responseWait) || !Number.isSafeInteger(seconds) || seconds <= 0)) {
			return { ok: false, error: { message: "Response wait must be a positive whole number of seconds." } };
		}
		const timeoutMs = seconds === undefined ? undefined : seconds * 1000;

		return request(async (signal, resetWait) => {
			const response = await fetchImpl(url, {
				method: "POST",
				headers,
				body: JSON.stringify(body),
				signal,
			});
			if (!response.ok) {
				return { ok: false, error: { message: await readErrorMessage(response) } };
			}

			const fail = (code: "empty" | "incomplete"): ServerClientResult<ChatCompletionResult> => ({
				ok: false, error: { code, message: code === "empty"
					? "Model server returned an empty response." : "Model server connection closed before completion." },
			});
			if (!response.headers?.get("content-type")?.includes("text/event-stream")) {
				let data: unknown;
				try { data = await response.json(); } catch {
					return { ok: false, error: { message: "Model server returned an unparseable response." } };
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
			let buffer = "";
			let content = "";
			let usage: TokenUsage | undefined;
			let completed = false;
			let done = false;
			const event = (raw: string) => {
				const data = raw.split(/\r\n|\r|\n/).filter((line) => line.startsWith("data:"))
					.map((line) => line.slice(5).replace(/^ /, "")).join("\n");
				if (!data) return;
				if (data.trim() === "[DONE]") { completed = true; done = true; return; }
				const parsed: unknown = JSON.parse(data);
				if (!isRecord(parsed)) throw new Error("Model server returned an invalid stream event.");
				if (isRecord(parsed.error)) throw new Error(typeof parsed.error.message === "string"
					? parsed.error.message : "Model server returned a stream error.");
				if (parsed.usage !== undefined) usage = parseUsage(parsed.usage);
				if (!Array.isArray(parsed.choices)) return;
				const choice = parsed.choices.find((value: unknown) => isRecord(value) && (value.index === 0 || value.index === undefined));
				if (!isRecord(choice)) return;
				if (isRecord(choice.delta) && typeof choice.delta.content === "string" && choice.delta.content) {
					content += choice.delta.content;
					if (!signal.aborted) { resetWait(); params?.onText?.(content); }
				}
				if (typeof choice.finish_reason === "string" && choice.finish_reason) completed = true;
			};
			const onAbort = () => { void reader.cancel().catch(() => {}); };
			signal.addEventListener("abort", onAbort, { once: true });
			try {
				while (!done && !signal.aborted) {
					const part = await reader.read();
					buffer += part.done ? decoder.decode() : decoder.decode(part.value, { stream: true });
					let boundary: RegExpExecArray | null;
					while (!done && (boundary = /\r\n\r\n|\n\n|\r\r/.exec(buffer))) {
						const raw = buffer.slice(0, boundary.index);
						buffer = buffer.slice(boundary.index + boundary[0].length);
						event(raw);
					}
					if (part.done) break;
				}
				if (signal.aborted || !completed) return fail("incomplete");
				if (!content.trim()) return fail("empty");
				return { ok: true, value: { content, usage } };
			} finally {
				signal.removeEventListener("abort", onAbort);
				try { await reader.cancel(); } catch { /* closed transport */ }
				reader.releaseLock();
			}

		}, timeoutMs, params?.signal, "timeout");
	}

	return { listModels, chat };
}
