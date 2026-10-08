import esbuild from "esbuild";
import process from "process";

const prod = process.argv[2] === "production";

/** @type {import("esbuild").BuildOptions} */
const options = {
	bundle: true,
	entryPoints: ["src/main.ts"],
	external: ["obsidian", "electron"],
	loader: { ".js": "js", ".ts": "ts" },
	outfile: "main.js",
	sourcemap: prod ? false : "inline",
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
		})
		.catch((e) => {
			console.error(e);
			process.exit(1);
		});
}

if (prod) {
	esbuild.build(options).catch((e) => {
		console.error(e);
		process.exit(1);
	});
} else {
	context();
}
