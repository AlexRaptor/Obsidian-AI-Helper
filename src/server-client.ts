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

export interface ServerClientConfig {
	serverUrl: string;
	apiKey?: string;
}

export type ServerClientError =
	| { code: "unreachable"; detail: string }
	| { code: "http"; detail: string }
	| { code: "invalid-json" };

export type ServerClientResult<T> =
	| { ok: true; value: T }
	| { ok: false; error: ServerClientError };

export interface ServerClient {
	listModels(config: ServerClientConfig): Promise<ServerClientResult<string[]>>;
}

export function createServerClient(fetchImpl: ClientFetch): ServerClient {
	async function listModels(config: ServerClientConfig): Promise<ServerClientResult<string[]>> {
		const url = `${config.serverUrl.replace(/\/+$/, "")}/models`;
		const headers: Record<string, string> = { Accept: "application/json" };
		if (config.apiKey) {
			headers.Authorization = `Bearer ${config.apiKey}`;
		}

		let response: Response;
		try {
			response = await fetchImpl(url, { method: "GET", headers });
		} catch (err) {
			const detail = err instanceof Error ? err.message : String(err);
			return { ok: false, error: { code: "unreachable", detail } };
		}

		if (!response.ok) {
			let detail = "";
			try {
				const body = (await response.json()) as ServerErrorBody;
				if (body.error?.message) {
					detail = body.error.message;
				}
			} catch {
				// non-JSON error body: fall back to the status line
			}
			return {
				ok: false,
				error: {
					code: "http",
					detail: detail || `status ${response.status}`,
				},
			};
		}

		let data: ModelListBody;
		try {
			data = (await response.json()) as ModelListBody;
		} catch {
			return { ok: false, error: { code: "invalid-json" } };
		}

		const ids = (data.data ?? []).map((m) => m.id).filter((id) => id.length > 0);
		return { ok: true, value: ids };
	}

	return { listModels };
}
