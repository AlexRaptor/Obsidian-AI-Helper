import { connectionUrl, type ChatMessage, type ClientFetch } from "./server-client";

export interface PromptTokenCount {
	tokens: number;
	method: "lmstudio" | "vllm" | "llamacpp" | "bytes";
}

export const TOKENIZER_SERVERS = { lmstudio: "LM Studio", vllm: "vLLM", llamacpp: "llama.cpp" };

export function conservativePromptTokens(messages: ChatMessage[]): PromptTokenCount {
	return { tokens: new TextEncoder().encode(JSON.stringify(messages)).length, method: "bytes" };
}

function record(value: unknown): value is Record<string, unknown> {
	return typeof value === "object" && value !== null && !Array.isArray(value);
}

function tokenIds(value: unknown): value is number[] {
	return Array.isArray(value) && value.length > 0 && value.every(id => typeof id === "number" && Number.isSafeInteger(id) && id >= 0);
}

// Identify supported servers from model metadata, never by model names or response guesses.
// Ollama has no public tokenizer API; do not use generation as a counting probe.
export async function serverPromptTokens(fetch: ClientFetch, serverUrl: string, model: string,
	messages: ChatMessage[], apiKey: string | undefined, signal: AbortSignal): Promise<PromptTokenCount | undefined> {
	const base = connectionUrl(serverUrl);
	if (!base || !model.trim() || signal.aborted) return undefined;
	let lm: PromptTokenCount | undefined;
	try { lm = await lmStudioPromptTokens(fetch, base, model, messages, apiKey, signal); }
	catch { /* An unsupported metadata route must not disable other server adapters. */ }
	if (lm || signal.aborted) return lm;
	const native = base.replace(/\/v1$/, "");
	const headers: Record<string, string> = apiKey ? { Authorization: `Bearer ${apiKey}` } : {};
	const json = async (url: string, body?: Record<string, unknown>): Promise<Record<string, unknown> | undefined> => {
		if (signal.aborted) return undefined;
		try {
			const response = await fetch(url, body ? { method: "POST", headers: { ...headers, "Content-Type": "application/json" }, body: JSON.stringify(body), signal }
				: { headers, signal });
			if (!response.ok || signal.aborted) return undefined;
			const data: unknown = await response.json();
			return !signal.aborted && record(data) ? data : undefined;
		} catch { return undefined; }
	};
	const list = await json(`${base}/models`);
	const selected = Array.isArray(list?.data) ? list.data.filter(record).filter(entry => entry.id === model.trim()) : [];
	if (selected.length !== 1 || signal.aborted) return undefined;
	if (typeof selected[0].max_model_len === "number" && Number.isSafeInteger(selected[0].max_model_len) && selected[0].max_model_len > 0) {
		const data = await json(`${native}/tokenize`, { model: model.trim(), messages, add_generation_prompt: true, add_special_tokens: false });
		return data && tokenIds(data.tokens) && data.count === data.tokens.length ? { tokens: data.tokens.length, method: "vllm" } : undefined;
	}
	const routing = `model=${encodeURIComponent(model.trim())}&autoload=false`;
	const props = await json(`${native}/props?${routing}`);
	if (!record(props?.default_generation_settings) || typeof props.default_generation_settings.n_ctx !== "number" ||
		!Number.isSafeInteger(props.default_generation_settings.n_ctx) || props.default_generation_settings.n_ctx <= 0) return undefined;
	const template = await json(`${native}/apply-template?autoload=false`, { model: model.trim(), messages });
	if (typeof template?.prompt !== "string" || !template.prompt.length || signal.aborted) return undefined;
	const data = await json(`${native}/tokenize?autoload=false`, { model: model.trim(), content: template.prompt,
		add_special: true, parse_special: true, with_pieces: false });
	return data && tokenIds(data.tokens) ? { tokens: data.tokens.length, method: "llamacpp" } : undefined;
}

// The caller bounds the whole operation and cancels its signal on timeout or completion.
// Only an unambiguous, already loaded instance can provide the selected model's tokenizer.
export async function lmStudioPromptTokens(fetch: ClientFetch, serverUrl: string, model: string,
	messages: ChatMessage[], apiKey: string | undefined, signal: AbortSignal): Promise<PromptTokenCount | undefined> {
	const base = connectionUrl(serverUrl);
	if (!base || !model.trim() || signal.aborted || !Symbol.asyncDispose) return undefined;
	const native = base.replace(/\/v1$/, "");
	const response = await fetch(`${native}/api/v1/models`, {
		headers: apiKey ? { Authorization: `Bearer ${apiKey}` } : {}, signal,
	});
	if (!response.ok || signal.aborted) return undefined;
	const body: unknown = await response.json();
	if (!record(body) || !Array.isArray(body.models)) return undefined;
	const entries = body.models.filter(record).filter(entry => entry.type === "llm");
	const instances = entries.flatMap(entry => Array.isArray(entry.loaded_instances) ? entry.loaded_instances.filter(record) : []);
	let matches = instances.filter(instance => instance.id === model.trim());
	if (!matches.length) {
		const keys = entries.filter(entry => entry.key === model.trim());
		if (keys.length === 1 && Array.isArray(keys[0].loaded_instances)) matches = keys[0].loaded_instances.filter(record);
	}
	if (matches.length !== 1 || typeof matches[0].id !== "string" || signal.aborted) return undefined;
	const selectedId = matches[0].id;
	const { LMStudioClient } = await import("@lmstudio/sdk");
	if (signal.aborted) return undefined;
	const socketUrl = new URL(native);
	socketUrl.protocol = socketUrl.protocol === "https:" ? "wss:" : "ws:";
	const client = new LMStudioClient({ baseUrl: socketUrl.href.replace(/\/+$/, ""), apiToken: apiKey || undefined,
		logger: { debug() {}, info() {}, warn() {}, error() {} } });
	let disposal: Promise<void> | undefined;
	const dispose = () => { disposal ??= client[Symbol.asyncDispose]().catch(() => {}); };
	signal.addEventListener("abort", dispose, { once: true });
	try {
		if (signal.aborted) return undefined;
		const loaded = await client.llm.listLoaded();
		if (signal.aborted) return undefined;
		const selected = loaded.filter(entry => entry.identifier === selectedId);
		if (selected.length !== 1) return undefined;
		if (messages.some(message => message.role === "tool" || message.tool_calls)) return undefined;
		const plain = messages.map(message => ({ role: message.role === "tool" ? "user" as const : message.role, content: message.content }));
		const prompt = await selected[0].applyPromptTemplate(plain);
		if (signal.aborted || typeof prompt !== "string" || !prompt.length) return undefined;
		const tokens = await selected[0].countTokens(prompt);
		return !signal.aborted && Number.isSafeInteger(tokens) && tokens > 0 ? { tokens, method: "lmstudio" } : undefined;
	} finally {
		signal.removeEventListener("abort", dispose);
		dispose();
	}
}
