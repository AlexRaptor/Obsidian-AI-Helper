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
