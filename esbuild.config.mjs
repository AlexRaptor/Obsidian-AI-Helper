import esbuild from "esbuild";
import process from "process";

const prod = process.argv[2] === "production";

/** @type {import("esbuild").BuildOptions} */
const options = {
	bundle: true,
	entryPoints: ["src/main.ts"],
	external: ["obsidian", "electron", "@codemirror/view", "@codemirror/state"],
	loader: { ".js": "js", ".ts": "ts" },
	outfile: "main.js",
	sourcemap: prod ? false : "inline",
	treeShaking: true,
	minify: prod,
	format: "cjs",
	target: "es2018",
	// Electron exposes process.versions, but this bundle uses browser WebSockets.
	// The SDK must dispose them as browser sockets rather than wait for Node refs.
	define: { "process.versions": "undefined" },
	// The SDK supports browsers, but imports terminal formatting and process helpers.
	// Keep those utilities in the renderer and never bundle their Node implementations.
	plugins: [{
		name: "lmstudio-browser-utilities",
		setup(build) {
			build.onResolve({ filter: /^(chalk|process)$/ }, args => ({ path: args.path, namespace: "browser-utility" }));
			build.onLoad({ filter: /.*/, namespace: "browser-utility" }, args => ({
				contents: args.path === "process"
					? "export default { browser: true, env: {} };"
					: "const plain = value => String(value); export default new Proxy(plain, { get: () => plain });",
				loader: "js",
			}));
		},
	}],
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
