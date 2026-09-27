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

export interface ServerClient {
	listModels(serverUrl: string, apiKey?: string): Promise<ServerClientResult<string[]>>;
}

export function createServerClient(fetchImpl: ClientFetch): ServerClient {
	async function listModels(serverUrl: string, apiKey?: string): Promise<ServerClientResult<string[]>> {
		const url = `${serverUrl}/models`;
		const headers: Record<string, string> = {};
		if (apiKey) {
			headers.Authorization = `Bearer ${apiKey}`;
		}

		let response: Response;
		try {
			response = await fetchImpl(url, { method: "GET", headers });
		} catch (err) {
			const message = err instanceof Error ? err.message : String(err);
			return { ok: false, error: { message } };
		}

		if (!response.ok) {
			let message = `Model server responded with status ${response.status}`;
			try {
				const body = (await response.json()) as ServerErrorBody;
				if (body.error?.message) {
					message = body.error.message;
				}
			} catch {
				// non-JSON error body: keep the status message
			}
			return { ok: false, error: { message } };
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

	return { listModels };
}
