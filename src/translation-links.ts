import { stripHeading, type App } from "obsidian";
import { TranslationMarkdownError } from "./translation-markdown";

/** Capture Obsidian's choice for short paths and aliases before any asynchronous read. */
export function snapshotTranslationTargets(app: App, original: string): { paths: string[]; resolved: ReadonlyMap<string, string> } {
	const files = app.vault.getFiles();
	const names = new Set<string>();
	for (const file of files) {
		const parts = file.path.split("/");
		for (let i = 0; i < parts.length; i++) {
			const name = parts.slice(i).join("/"); names.add(name);
			if (name.endsWith(".md")) names.add(name.slice(0, -3));
		}
		const aliases: unknown = app.metadataCache.getFileCache(file)?.frontmatter?.aliases;
		if (typeof aliases === "string") names.add(aliases);
		else if (Array.isArray(aliases)) for (const alias of aliases) if (typeof alias === "string") names.add(alias);
	}
	const resolved = new Map<string, string>();
	for (const name of names) {
		const target = app.metadataCache.getFirstLinkpathDest(name, original);
		if (target) resolved.set(name, target.path);
	}
	return { paths: files.map(file => file.path), resolved };
}

/** Paths are strings copied at launch, never live TFile objects. */
export class TranslationLinks {
	unresolved = false;
	private headings = new Map<string, number>();
	setHeadings(headings: readonly string[]): void {
		for (const heading of headings) this.headings.set(heading, (this.headings.get(heading) ?? 0) + 1);
	}
	private destinations: { marker: string; raw: string; path: string; fragment: string; wiki: boolean }[] = [];
	constructor(private targets: { paths: readonly string[]; resolved: ReadonlyMap<string, string> }, private original: string, private result: string, private marker: string) {}
	capture(raw: string, wiki: boolean): string | undefined {
		if (/^(?:[a-z][a-z\d+.-]*:|\/\/)/i.test(raw)) return raw;
		// Split syntax before URL decoding: %23 belongs to the filename, not the anchor.
		const hash = raw.indexOf("#");
		const rawName = hash < 0 ? raw : raw.slice(0, hash);
		const rawFragment = hash < 0 ? "" : raw.slice(hash);
		const decode = (value: string) => wiki ? value : decodeURIComponent(value.replace(/\\([!"#$%&'()*+,\-./:;<=>?@[\]\\^_`{|}~])/g, "$1"));
		let name: string; let fragment: string;
		try { name = decode(rawName); fragment = decode(rawFragment); }
		catch { this.unresolved = true; return undefined; }
		let path: string | undefined;
		if (!name) path = this.original;
		else {
			path = this.targets.resolved.get(name);
			const local = normalize(this.original.slice(0, this.original.lastIndexOf("/") + 1) + name);
			const root = normalize(name.replace(/^\//, ""));
			path ??= [local, local + ".md", root, root + ".md"].find(candidate => this.targets.paths.includes(candidate));
			if (!path && !/^\.?\.?\//.test(name)) {
				const matches = this.targets.paths.filter(candidate => candidate.endsWith("/" + name) || candidate.endsWith("/" + name + ".md"));
				if (matches.length > 1) throw new TranslationMarkdownError("unsupported");
				path = matches[0];
			}
		}
		if (!path) { this.unresolved = true; return undefined; }
		if (path === this.original && fragment && !fragment.startsWith("#^")) {
			const count = this.headings.get(stripHeading(fragment.slice(1)).toLowerCase()) ?? 0;
			if (!count) { this.unresolved = true; return undefined; }
			if (count > 1) throw new TranslationMarkdownError("unsupported");
		}
		const marker = `${this.marker}link:${this.destinations.length}⟧`;
		this.destinations.push({ marker, raw, path, fragment, wiki });
		return marker;
	}
	assemble(body: string, headings: ReadonlyMap<string, string>): string {
		for (const link of this.destinations) {
			let fragment = link.fragment;
			if (link.path === this.original && fragment && !fragment.startsWith("#^")) {
				const translated = headings.get(stripHeading(fragment.slice(1)).toLowerCase());
				if (!translated || [...headings.values()].filter(value => stripHeading(value).toLowerCase() === stripHeading(translated).toLowerCase()).length > 1) throw new TranslationMarkdownError("unsupported");
				fragment = "#" + translated;
			}
			const target = link.path === this.original ? this.result : link.path;
			const path = link.path === this.original && link.raw.startsWith("#") ? "" : relativePath(this.result, target);
			const destination = link.wiki ? path + fragment : encodeDestination(path).replace(/#/g, "%23") + encodeDestination(fragment);
			body = body.split(link.marker).join(destination);
		}
		return body;
	}
}
function directory(path: string): string { return path.slice(0, path.lastIndexOf("/") + 1); }
function normalize(path: string): string {
	const parts: string[] = [];
	for (const part of path.split("/")) {
		if (part === "..") { if (!parts.length) return ""; parts.pop(); }
		else if (part && part !== ".") parts.push(part);
	}
	return parts.join("/");
}
export function relativePath(from: string, to: string): string {
	const folder = directory(from).split("/").filter(Boolean);
	const target = to.split("/");
	while (folder.length && folder[0] === target[0]) { folder.shift(); target.shift(); }
	return (folder.length ? "../".repeat(folder.length) : "./") + target.join("/");
}
export function encodeDestination(value: string): string {
	return value.replace(/[\s%<>?\[\]\\()]/g, character => encodeURIComponent(character) === character ? `%${character.charCodeAt(0).toString(16).toUpperCase()}` : encodeURIComponent(character));
}
