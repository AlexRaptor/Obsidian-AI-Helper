// OS-level RSS sampling for a desktop acceptance run, never imported by the plugin.
import { execFileSync } from "node:child_process";
import { writeFile } from "node:fs/promises";
import { cpus, totalmem } from "node:os";

const args = process.argv.slice(2);
const option = (key, fallback) => args.includes(key) ? args[args.indexOf(key) + 1] : fallback;
const duration = Number(option("--seconds", "600"));
const renderer = option("--renderer", "5");
const output = option("--output", "/private/tmp/issue24-desktop-memory.json");
const report = { started: new Date().toISOString(), hardware: { cpu: cpus()[0]?.model, memoryBytes: totalmem() }, renderer, samples: [] };
let stopped = false;
process.on("SIGINT", () => { stopped = true; });
while (!stopped && report.samples.length < duration) {
	const rows = execFileSync("/bin/ps", ["-axo", "pid=,rss=,command="], { encoding: "utf8" }).split("\n")
		.filter(row => row.includes("/Applications/Obsidian.app/") && row.includes("--type=renderer"))
		.map(row => { const [, pid, rss] = row.match(/^\s*(\d+)\s+(\d+)/); return { pid: Number(pid), rss: Number(rss) * 1024, selected: row.includes(`--renderer-client-id=${renderer} `) }; });
	report.samples.push({ time: new Date().toISOString(), selected: rows.filter(row => row.selected), allRenderersRss: rows.reduce((sum, row) => sum + row.rss, 0) });
	report.maxSelectedRss = Math.max(...report.samples.flatMap(sample => sample.selected.map(row => row.rss)), 0);
	await writeFile(output, JSON.stringify(report, null, 2) + "\n");
	await new Promise(resolve => setTimeout(resolve, 1000));
}
report.finished = new Date().toISOString();
await writeFile(output, JSON.stringify(report, null, 2) + "\n");
console.log(JSON.stringify({ output, samples: report.samples.length, maxSelectedRss: report.maxSelectedRss }));
