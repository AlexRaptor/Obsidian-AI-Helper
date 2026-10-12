// Controlled HTTP boundary for desktop Obsidian acceptance. Not a model-quality check.
import { createServer } from "node:http";
import { createHash } from "node:crypto";
import { writeFile } from "node:fs/promises";

const log = [];
let offline = false;
let delayMs = 0;
let answer = "Контрольный ответ [1]. Неподтверждённые ссылки: [99], [[Несуществующая заметка]], [сайт](https://example.invalid).";
const vector = Array.from({ length: 1024 }, (_, index) => index === 0 ? 1 : 0);
const server = createServer(async (request, response) => {
	response.setHeader("Access-Control-Allow-Origin", "*");
	response.setHeader("Access-Control-Allow-Headers", "content-type, authorization");
	response.setHeader("Access-Control-Allow-Methods", "GET, POST, OPTIONS");
	response.setHeader("Content-Type", "application/json");
	const send = (status, value) => { response.writeHead(status); response.end(JSON.stringify(value)); };
	if (request.method === "OPTIONS") return send(200, {});
	if (request.url === "/metrics") return send(200, { offline, delayMs, requests: log });
	let raw = "";
	for await (const part of request) {
		raw += part;
		if (raw.length > 1000000) return send(413, { error: { message: "Acceptance request too large" } });
	}
	try {
		const body = raw ? JSON.parse(raw) : {};
		if (request.url === "/control") {
			if (typeof body.offline === "boolean") offline = body.offline;
			if (Number.isSafeInteger(body.delayMs) && body.delayMs >= 0 && body.delayMs <= 10000) delayMs = body.delayMs;
			if (typeof body.answer === "string") answer = body.answer;
			if (body.reset === true) log.length = 0;
			return send(200, { offline, delayMs });
		}
		const row = { time: new Date().toISOString(), endpoint: request.url, offline, inputs: Array.isArray(body.input) ? body.input.map(text => ({ bytes: Buffer.byteLength(text), hash: createHash("sha256").update(text).digest("hex"), note: text.split("\n")[1]?.endsWith(".md") ? text.split("\n")[1] : undefined })) : undefined };
		log.push(row);
		if (offline) return send(503, { error: { message: "Acceptance model server offline" } });
		if (request.url === "/v1/models") return send(200, { data: [{ id: "acceptance-24" }] });
		if (delayMs) await new Promise(resolve => setTimeout(resolve, delayMs));
		if (response.destroyed) return;
		if (request.url === "/v1/embeddings") return send(200, { data: body.input.map((_, index) => ({ index, embedding: vector })) });
		if (request.url === "/v1/chat/completions") return send(200, { choices: [{ message: { content: answer } }], usage: { prompt_tokens: 100, completion_tokens: 50, total_tokens: 150 } });
		return send(404, { error: { message: "Unknown acceptance endpoint" } });
	} catch { return send(400, { error: { message: "Invalid acceptance request" } }); }
});
server.listen(1235, "127.0.0.1", () => console.log("Acceptance transport: http://127.0.0.1:1235/v1"));
process.on("SIGINT", async () => {
	await writeFile("/private/tmp/issue24-desktop-http-log.json", JSON.stringify(log, null, 2) + "\n");
	server.close(() => process.exit(0));
});
