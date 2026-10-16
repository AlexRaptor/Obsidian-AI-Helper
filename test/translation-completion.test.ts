import { expect, it } from "vitest";
import { createServerClient } from "../src/server-client";

it.each(["stop", "length", "content_filter", undefined])("передаёт причину завершения JSON: %s", async reason => {
	const client = createServerClient(async () => new Response(JSON.stringify({ choices: [{ message: { content: "Перевод" }, finish_reason: reason }] })));
	const result = await client.chat("http://server/v1", "model", []);
	expect(result).toMatchObject({ ok: true, value: { content: "Перевод", finishReason: reason } });
});
it.each(["stop", "length", "content_filter", undefined])("передаёт причину завершения SSE: %s", async reason => {
	const events = `data: ${JSON.stringify({ choices: [{ index: 0, delta: { content: "Перевод" }, finish_reason: reason }] })}\n\ndata: [DONE]\n\n`;
	const client = createServerClient(async () => new Response(events, { headers: { "content-type": "text/event-stream" } }));
	expect(await client.chat("http://server/v1", "model", [])).toMatchObject({ ok: true, value: { content: "Перевод", finishReason: reason } });
});
it("отклоняет оборванный поток без причины завершения", async () => {
	const client = createServerClient(async () => new Response('data: {"choices":[{"delta":{"content":"Часть"}}]}\n\n', { headers: { "content-type": "text/event-stream" } }));
	expect(await client.chat("http://server/v1", "model", [])).toMatchObject({ ok: false, error: { code: "incomplete" } });
});


it.each(["http", "json", "sse", "fallback"])("классифицирует структурированную ошибку контекста: %s", async transport => {
	let attempts = 0;
	const error = { code: "context_length_exceeded", message: "Запрос не помещается." };
	const client = createServerClient(async () => {
		if (transport === "fallback" && attempts++ === 0) return Response.json({ error: { message: "streaming is not supported" } }, { status: 400 });
		return transport === "sse" ? new Response(`data: ${JSON.stringify({ error })}\n\n`, { headers: { "content-type": "text/event-stream" } }) : Response.json({ error }, { status: transport === "http" ? 400 : 200 });
	});
	expect(await client.chat("http://server/v1", "model", [])).toMatchObject({ ok: false, error: { code: "context-length" } });
});

it.each([401, 403, 429, 500])("не считает отказ HTTP %s превышением контекста", async status => {
	const client = createServerClient(async () => Response.json({ error: { code: "context_length_exceeded", message: "maximum context length exceeded" } }, { status }));
	const result = await client.chat("http://server/v1", "model", []);
	expect(result.ok).toBe(false);
	if (!result.ok) expect(result.error.code).not.toBe("context-length");
});
