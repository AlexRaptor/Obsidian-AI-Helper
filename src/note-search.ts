import { connectionUrl, type ServerClient, type EmbeddingErrorCode } from "./server-client";

export interface EmbeddingConnection {
	embeddingServerUrl: string;
	embeddingApiKey: string;
	embeddingModel: string;
}

/** Configuration only: availability and successful verification are not prerequisites. */
export function isEmbeddingConfigured(connection: EmbeddingConnection | undefined): boolean {
	return !!connection && !!connection.embeddingModel.trim() && connectionUrl(connection.embeddingServerUrl) !== undefined;
}

export type EmbeddingStatus =
	| { state: "idle" | "checking" }
	| { state: "verified"; dimensions: number }
	| { state: "error"; code: EmbeddingErrorCode };

export function createNoteSearchConnection(client: ServerClient) {
	let connection: EmbeddingConnection = { embeddingServerUrl: "", embeddingApiKey: "", embeddingModel: "" };
	let status: EmbeddingStatus = { state: "idle" };
	let request: AbortController | null = null;
	function cancel() {
		request?.abort();
		request = null;
		status = { state: "idle" };
	}
	return {
		get status(): EmbeddingStatus { return status; },
		configure(next: EmbeddingConnection): void {
			if (connection.embeddingServerUrl === next.embeddingServerUrl && connection.embeddingApiKey === next.embeddingApiKey && connection.embeddingModel === next.embeddingModel) return;
			cancel();
			connection = { embeddingServerUrl: next.embeddingServerUrl, embeddingApiKey: next.embeddingApiKey, embeddingModel: next.embeddingModel };
		},
		cancel,
		async verify(): Promise<void> {
			cancel();
			const active = new AbortController();
			request = active;
			status = { state: "checking" };
			// Synthetic texts only: never read or send notes as part of a connection check.
			const result = await client.embeddings(connection.embeddingServerUrl, connection.embeddingModel,
				["A cat sits by the window.", "The train arrives at the station."], connection.embeddingApiKey, active.signal);
			if (request !== active) return;
			request = null;
			status = result.ok ? { state: "verified", dimensions: result.value[0].length }
				: { state: "error", code: result.error.code as EmbeddingErrorCode };
		},
	};
}
