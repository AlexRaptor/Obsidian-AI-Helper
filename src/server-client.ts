export type ClientFetch = (input: string, init?: RequestInit) => Promise<Response>;

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
	| { ok: false; error: { message: string } };

export interface ChatMessage {
	role: "system" | "user" | "assistant";
	content: string;
}

export interface ChatParams {
	apiKey?: string;
	systemPrompt?: string;
	temperature?: string;
	maxTokens?: string;
	topP?: string;
}

export interface ChatCompletionBody {
	choices?: Array<{ message?: { content?: string } }>;
}

export interface ServerClient {
	listModels(serverUrl: string, apiKey?: string): Promise<ServerClientResult<string[]>>;
	chat(
		serverUrl: string,
		model: string,
		messages: ChatMessage[],
		params?: ChatParams
	): Promise<ServerClientResult<string>>;
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
		const body = (await response.json()) as ServerErrorBody;
		if (body.error?.message) {
			message = body.error.message;
		}
	} catch {
		// non-JSON error body: keep the status message
	}
	return message;
}

function numericParam(raw: string | undefined): number | undefined {
	if (raw === undefined || raw.trim() === "") return undefined;
	const value = Number(raw);
	return Number.isFinite(value) ? value : undefined;
}

export function createServerClient(fetchImpl: ClientFetch): ServerClient {
	async function listModels(serverUrl: string, apiKey?: string): Promise<ServerClientResult<string[]>> {
		const url = `${serverUrl}/models`;

		let response: Response;
		try {
			response = await fetchImpl(url, { method: "GET", headers: bearerHeaders(apiKey) });
		} catch (err) {
			const message = err instanceof Error ? err.message : String(err);
			return { ok: false, error: { message } };
		}

		if (!response.ok) {
			return { ok: false, error: { message: await readErrorMessage(response) } };
		}

		let data: ModelListBody;
		try {
			data = (await response.json()) as ModelListBody;
		} catch {
			return {
				ok: false,
				error: { message: "Model server returned an unparseable model list." },
			};
		}

		const ids = (data.data ?? []).map((m) => m.id).filter((id) => id.length > 0);
		return { ok: true, value: ids };
	}

	async function chat(
		serverUrl: string,
		model: string,
		messages: ChatMessage[],
		params?: ChatParams
	): Promise<ServerClientResult<string>> {
		const url = `${serverUrl}/chat/completions`;

		const body: Record<string, unknown> = {
			model,
			messages: [
				...(params?.systemPrompt ? [{ role: "system", content: params.systemPrompt }] : []),
				...messages,
			],
			stream: false,
		};

		const temperature = numericParam(params?.temperature);
		if (temperature !== undefined) body.temperature = temperature;
		const maxTokens = numericParam(params?.maxTokens);
		if (maxTokens !== undefined) body.max_tokens = maxTokens;
		const topP = numericParam(params?.topP);
		if (topP !== undefined) body.top_p = topP;

		const headers: Record<string, string> = {
			"Content-Type": "application/json",
			...bearerHeaders(params?.apiKey),
		};

		let response: Response;
		try {
			response = await fetchImpl(url, {
				method: "POST",
				headers,
				body: JSON.stringify(body),
			});
		} catch (err) {
			const message = err instanceof Error ? err.message : String(err);
			return { ok: false, error: { message } };
		}

		if (!response.ok) {
			return { ok: false, error: { message: await readErrorMessage(response) } };
		}

		let data: ChatCompletionBody;
		try {
			data = (await response.json()) as ChatCompletionBody;
		} catch {
			return {
				ok: false,
				error: { message: "Model server returned an unparseable response." },
			};
		}

		const content = data.choices?.[0]?.message?.content;
		if (typeof content !== "string") {
			return {
				ok: false,
				error: { message: "Model server returned an empty response." },
			};
		}
		return { ok: true, value: content };
	}

	return { listModels, chat };
}
