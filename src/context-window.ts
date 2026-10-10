import type { ClientFetch, ServerClient, ServerClientResult } from "./server-client";
import type { ModelConnection } from "./model-connection";

export interface ContextWindow {
	tokens: number;
	source: string;
}

function record(value: unknown): value is Record<string, unknown> {
	return typeof value === "object" && value !== null && !Array.isArray(value);
}

export function contextTokens(value: unknown): number | undefined {
	return typeof value === "number" && Number.isSafeInteger(value) && value > 0 ? value : undefined;
}

export function effectiveContextWindow(manual: string, automatic?: ContextWindow): number | undefined {
	return manual.trim() ? contextTokens(Number(manual)) : automatic?.tokens;
}

// Only query the configured server; retain reverse-proxy prefixes when replacing /v1.
export async function discoverContextWindow(fetch: ClientFetch, base: string, model: string, apiKey: string | undefined, signal: AbortSignal): Promise<ContextWindow | undefined> {
	const native = base.replace(/\/v1$/, "");
	const get = async (url: string): Promise<Record<string, unknown> | undefined> => {
		if (signal.aborted) return undefined;
		try {
			const response = await fetch(url, { headers: apiKey ? { Authorization: `Bearer ${apiKey}` } : {}, signal });
			if (!response.ok) return undefined;
			const body: unknown = await response.json();
			return record(body) ? body : undefined;
		} catch { return undefined; }
	};
	const list = await get(`${base}/models`);
	const models = Array.isArray(list?.data) ? list.data.filter(record) : [];
	const selected = models.filter((entry) => entry.id === model);
	if (selected.length === 1) {
		const tokens = contextTokens(selected[0].max_model_len);
		if (tokens) return { tokens, source: "vLLM" };
	}
	const lm = await get(`${native}/api/v1/models`);
	if (Array.isArray(lm?.models)) {
		const entries = lm.models.filter(record).filter((entry) => entry.type === "llm");
		const instances = entries.flatMap((entry) => Array.isArray(entry.loaded_instances) ? entry.loaded_instances.filter(record) : []);
		let matches = instances.filter((instance) => instance.id === model);
		if (!matches.length) {
			const keys = entries.filter((entry) => entry.key === model);
			if (keys.length === 1 && Array.isArray(keys[0].loaded_instances)) matches = keys[0].loaded_instances.filter(record);
		}
		if (matches.length === 1 && record(matches[0].config)) {
			const tokens = contextTokens(matches[0].config.context_length);
			if (tokens) return { tokens, source: "LM Studio" };
		}
	}
	const ollama = await get(`${native}/api/ps`);
	if (Array.isArray(ollama?.models)) {
		const normalize = (name: unknown) => typeof name === "string" ? (name.includes(":") ? name : `${name}:latest`) : undefined;
		const matches = ollama.models.filter(record).filter((entry) => normalize(entry.name) === normalize(model) || normalize(entry.model) === normalize(model));
		if (matches.length === 1) {
			const tokens = contextTokens(matches[0].context_length);
			if (tokens) return { tokens, source: "Ollama" };
		}
	}
	// /props is global on single-model servers. Validate the selected id first.
	if (selected.length === 1) {
		const props = await get(`${native}/props?model=${encodeURIComponent(model)}&autoload=false`);
		if (record(props?.default_generation_settings)) {
			const tokens = contextTokens(props.default_generation_settings.n_ctx);
			if (tokens) return { tokens, source: "llama.cpp" };
		}
	}
	return undefined;
}

export function createContextWindowConnection(client: ServerClient) {
	let connection: ModelConnection = { serverUrl: "", apiKey: "", model: "" };
	let value: ContextWindow | undefined;
	let request: AbortController | null = null;
	let checking = false;
	const listeners = new Set<() => void>();
	const notify = () => listeners.forEach((listener) => listener());
	const cancel = () => { request?.abort(); request = null; checking = false; value = undefined; notify(); };
	return {
		get value() { return value; },
		get checking() { return checking; },
		subscribe(listener: () => void): () => void { listeners.add(listener); return () => { listeners.delete(listener); }; },
		configure(next: ModelConnection): boolean {
			const normalized = { serverUrl: next.serverUrl.trim().replace(/\/+$/, ""), apiKey: next.apiKey, model: next.model.trim() };
			if (Object.keys(normalized).every((key) => normalized[key as keyof ModelConnection] === connection[key as keyof ModelConnection])) return false;
			connection = normalized;
			cancel();
			return true;
		},
		cancel,
		async refresh(): Promise<void> {
			cancel();
			if (!connection.serverUrl || !connection.model) return;
			const active = new AbortController();
			request = active;
			checking = true;
			notify();
			let result: ServerClientResult<ContextWindow | undefined>;
			try { result = await client.getContextWindow(connection.serverUrl, connection.model, connection.apiKey, active.signal); }
			catch { result = { ok: false, error: { message: "Context discovery failed." } }; }
			if (request !== active) return;
			value = result.ok ? result.value : undefined;
			request = null;
			checking = false;
			notify();
		},
	};
}
