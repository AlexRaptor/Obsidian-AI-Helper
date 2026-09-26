import fs from "fs";
import esbuild from "esbuild";
import process from "process";
import { createRequire } from "module";

const require = createRequire(import.meta.url);
const prod = process.argv[2] === "production";

/** @type {import("esbuild").Plugin} */
const esbuildPluginHtml = {
	name: "html-plugin",
	setup(build) {
		build.onEnd((result) => {
			if (result.errors.length > 0) process.exit(1);
			if (!result.outputFiles.length) return;
			const src = fs.readFileSync("styles.css", "utf8");
			const css = result.outputFiles[0].text;
			result.outputFiles[0].text = `${css}\n\n${src}`;
		});
	},
};

/** @type {import("esbuild").BuildOptions} */
const options = {
	bundle: true,
	entryPoints: ["src/main.ts"],
	external: ["obsidian", "electron"],
	loader: { ".js": "js", ".ts": "ts" },
	plugins: [esbuildPluginHtml],
	outfile: "main.js",
	sourcemap: prod ? false : { sourcesContent: true },
	treeShaking: true,
	minify: prod,
	format: "cjs",
	target: "es2018",
};

async function context() {
	esbuild
		.context(options)
		.then((c) => {
			c.watch();
			c.rebuild();
			process.stdin.on("close", () => c.dispose());
			fs.watch("styles.css", () => c.rebuild());
		})
		.catch((e) => {
			console.error(e);
			process.exit(1);
		});
}

if (prod) {
	esbuild.build(options).catch(() => process.exit(1));
} else {
	context();
}
