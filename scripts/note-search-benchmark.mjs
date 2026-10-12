// Node-only acceptance runner; never bundled into the Obsidian plugin.
import { build } from "esbuild";
import { mkdtemp, readdir, readFile, writeFile } from "node:fs/promises";
import { pathToFileURL } from "node:url";
import { resolve, relative } from "node:path";
import { monitorEventLoopDelay, performance } from "node:perf_hooks";
import { cpus, totalmem } from "node:os";
import assert from "node:assert/strict";

const args = process.argv.slice(2);
const option = (name, fallback) => args.includes(name) ? args[args.indexOf(name) + 1] : fallback;
const transport = option("--transport", "mock");
const mode = option("--storage", "local");
assert(["mock", "lmstudio"].includes(transport));
assert(["local", "file"].includes(mode));
const count = Number(option("--notes", "500"));
assert(Number.isSafeInteger(count) && count > 0);
const bundle = await build({ stdin: { contents: 'export { createNoteSearch } from "./src/note-index"; export { createServerClient } from "./src/server-client"; export { IDBFactory } from "fake-indexeddb"; export { fileIndexAdapter } from "./test/helpers/file-index";', resolveDir: process.cwd() }, bundle: true, platform: "node", format: "esm", write: false });
const bundlePath = resolve(await mkdtemp("/private/tmp/note-search-benchmark-"), "module.mjs");
await writeFile(bundlePath, bundle.outputFiles[0].text);
const { createNoteSearch, createServerClient, IDBFactory, fileIndexAdapter } = await import(pathToFileURL(bundlePath).href);
const notes = new Map();
const vault = option("--vault", "");
const excluded = option("--exclude", "").split(",").filter(Boolean);
if (vault) {
	async function collect(directory) {
		for (const entry of await readdir(directory, { withFileTypes: true })) {
			const path = resolve(directory, entry.name);
			const name = relative(resolve(vault), path).split("\\").join("/");
			if (entry.name.startsWith(".") || excluded.some(folder => name === folder || name.startsWith(`${folder}/`))) continue;
			if (entry.isDirectory()) await collect(path);
			else if (entry.isFile() && /\.md$/i.test(name)) notes.set(name, await readFile(path, "utf8"));
		}
	}
	await collect(resolve(vault));
} else {
	for (let index = 0; index < count; index++) {
		const sentence = `Запись проекта PROJECT_${index}: поезд Север отправляется в 18:30 с платформы 4. Проверка индексации и поиска по заметкам. `;
		notes.set(`Notes/Project-${index}.md`, `# PROJECT_${index}\n` + sentence.repeat(Math.ceil(12000 / Buffer.byteLength(sentence))));
	}
}
assert(notes.size > 0);
const dimension = 1024;
const vector = Array.from({ length: dimension }, (_, index) => index % 2 ? 0.01 : 0.02);
let requests = 0;
const client = createServerClient(async (url, init) => {
	requests++;
	if (transport === "lmstudio") return fetch(url, init);
	const { input } = JSON.parse(init.body);
	return new Response(JSON.stringify({ data: input.map((_, index) => ({ index, embedding: vector })) }));
});
const adapter = fileIndexAdapter();
let writtenBytes = 0;
const write = adapter.write;
adapter.write = async (path, text) => { writtenBytes += Buffer.byteLength(text); await write(path, text); };
const environment = { client, factory: new IDBFactory(), storageMode: mode, vaultPath: "/isolated-acceptance-benchmark", fileStorage: { adapter, directory: "note-index" }, list: () => [...notes.keys()], read: async path => notes.get(path) ?? null, open: async () => {} };
const configuration = { embeddingServerUrl: "http://127.0.0.1:1234/v1", embeddingApiKey: "", embeddingModel: option("--model", "text-embedding-qwen3-embedding-0.6b@q8_0"), autoUpdateNotes: false };
let search = createNoteSearch(environment); search.configure(configuration);
const delay = monitorEventLoopDelay({ resolution: 10 }); delay.enable();
const initialRss = process.memoryUsage().rss;
let peakRss = initialRss;
const sample = setInterval(() => { peakRss = Math.max(peakRss, process.memoryUsage().rss); }, 50);
const report = { date: new Date().toISOString(), hardware: { cpu: cpus()[0]?.model, memoryBytes: totalmem(), node: process.version }, transport, storage: `${mode} (${mode === "local" ? "fake-indexeddb" : "in-memory DataAdapter"})`, embeddingModel: transport === "lmstudio" ? configuration.embeddingModel : `fixed ${dimension}-dimension vector`, notes: notes.size, bytes: [...notes.values()].reduce((sum, text) => sum + Buffer.byteLength(text), 0), measurements: {} };
report.status = "running";
async function measure(name, action) {
	const before = requests; const start = performance.now();
	await action();
	report.measurements[name] = { milliseconds: Math.round(performance.now() - start), embeddingRequests: requests - before };
	console.log(name, report.measurements[name], search.progress);
}
try {
	let pausedAt = 0;
	let pausePromise;
	const unsubscribe = search.subscribe(() => {
		if (search.progress.state === "indexing" && search.progress.completed >= Math.min(10, notes.size) && !pausePromise) {
			pausedAt = performance.now(); pausePromise = search.pause();
		}
	});
	await measure("firstPart", async () => {
		try { await search.indexVault(); } catch (error) { if (!pausePromise || error.code !== "search-rebuild") throw error; }
		await pausePromise;
	});
	unsubscribe();
	assert.equal(search.progress.state, "paused");
	report.measurements.pause = { milliseconds: Math.round(performance.now() - pausedAt), completed: search.progress.completed };
	search.dispose(); search = createNoteSearch(environment); search.configure(configuration);
	await search.restore(); assert.equal(search.progress.state, "paused");
	const before = requests; await search.resume(); assert.equal(requests, before);
	await measure("resume", () => search.resume(true));
	assert.equal(search.progress.completed, notes.size);
	const path = notes.keys().next().value;
	notes.set(path, notes.get(path) + "\nОбновление BENCH_UPDATE_24.");
	await measure("updateOne", async () => { await search.changed(path); await search.resume(true); });
	for (let index = 0; index < 3; index++) await measure(`search${index + 1}`, async () => {
		const sources = await search.searchSources("BENCH_UPDATE_24");
		assert(sources.some(source => source.path === path));
		for (const source of sources) await search.validateSource(source);
	});
	report.coverage = search.progress;
	report.status = "passed";
} catch (error) {
	report.status = "failed";
	report.error = error.code ?? error.name;
	report.coverage = search.progress;
	throw error;
} finally {
	search.dispose(); clearInterval(sample); delay.disable();
	report.memory = { initialRss, peakRss, finalRss: process.memoryUsage().rss };
	report.eventLoop = { maxMilliseconds: Math.round(delay.max / 1e6), p99Milliseconds: Math.round(delay.percentile(99) / 1e6) };
	report.writtenBytes = writtenBytes;
	if (args.includes("--max-event-loop-ms") && report.eventLoop.maxMilliseconds > Number(option("--max-event-loop-ms"))) { report.status = "failed"; report.error = "event-loop-limit"; }
	if (args.includes("--max-rss-mb") && report.memory.peakRss > Number(option("--max-rss-mb")) * 1024 * 1024) { report.status = "failed"; report.error = "memory-limit"; }
	await writeFile(option("--output", "/private/tmp/note-search-benchmark.json"), JSON.stringify(report, null, 2) + "\n");
}
if (args.includes("--max-event-loop-ms")) assert(report.eventLoop.maxMilliseconds <= Number(option("--max-event-loop-ms")), `Event loop blocked for ${report.eventLoop.maxMilliseconds} ms`);
if (args.includes("--max-rss-mb")) assert(report.memory.peakRss <= Number(option("--max-rss-mb")) * 1024 * 1024, `Peak RSS ${report.memory.peakRss} bytes`);
