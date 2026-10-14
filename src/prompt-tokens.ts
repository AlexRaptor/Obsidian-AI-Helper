import { connectionUrl, type ChatMessage, type ClientFetch } from "./server-client";

export interface PromptTokenCount {
	tokens: number;
	method: "lmstudio" | "bytes";
}

export function conservativePromptTokens(messages: ChatMessage[]): PromptTokenCount {
	return { tokens: new TextEncoder().encode(JSON.stringify(messages)).length, method: "bytes" };
}

function record(value: unknown): value is Record<string, unknown> {
	return typeof value === "object" && value !== null && !Array.isArray(value);
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
		const prompt = await selected[0].applyPromptTemplate(messages);
		if (signal.aborted || typeof prompt !== "string" || !prompt.length) return undefined;
		const tokens = await selected[0].countTokens(prompt);
		return !signal.aborted && Number.isSafeInteger(tokens) && tokens > 0 ? { tokens, method: "lmstudio" } : undefined;
	} finally {
		signal.removeEventListener("abort", dispose);
		dispose();
	}
}
