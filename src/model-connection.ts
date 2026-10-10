import type { ModelCheckErrorCode, ServerClient } from "./server-client";

export interface ModelConnection {
	serverUrl: string;
	apiKey: string;
	model: string;
}

export type ModelConnectionStatus =
	| { state: "idle" | "checking" | "verified" }
	| { state: "error"; code: ModelCheckErrorCode };

export function createModelConnection(client: ServerClient) {
	let connection: ModelConnection = { serverUrl: "", apiKey: "", model: "" };
	let status: ModelConnectionStatus = { state: "idle" };
	let request: AbortController | null = null;
	function cancel(): void {
		request?.abort();
		request = null;
		status = { state: "idle" };
	}
	return {
		get status(): ModelConnectionStatus { return status; },
		configure(next: ModelConnection): void {
			if (connection.serverUrl === next.serverUrl && connection.apiKey === next.apiKey && connection.model === next.model) return;
			cancel();
			connection = { serverUrl: next.serverUrl, apiKey: next.apiKey, model: next.model };
		},
		cancel,
		async verify(): Promise<void> {
			cancel();
			const active = new AbortController();
			request = active;
			status = { state: "checking" };
			const result = await client.verifyModel(connection.serverUrl, connection.model, connection.apiKey, active.signal);
			if (request !== active) return;
			request = null;
			status = result.ok ? { state: "verified" } : { state: "error", code: result.error.code as ModelCheckErrorCode };
		},
	};
}
