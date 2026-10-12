// Obsidian DataAdapter boundary, shared by fresh plugin/search instances.
export function fileIndexAdapter() {
	const files = new Map<string, string>();
	const folders = new Set<string>();
	let unavailable = false;
	const check = () => { if (unavailable) throw new Error("Unavailable adapter"); };
	return {
		files,
		setUnavailable(value: boolean) { unavailable = value; },
		async exists(path: string) { check(); return files.has(path) || folders.has(path); },
		async mkdir(path: string) { check(); folders.add(path); },
		async read(path: string) { check(); if (!files.has(path)) throw new Error("Missing file"); return files.get(path)!; },
		async write(path: string, text: string) { check(); files.set(path, text); },
		async rename(from: string, to: string) { check(); if (!files.has(from)) throw new Error("Missing file"); if (files.has(to)) throw new Error("Destination exists"); files.set(to, files.get(from)!); files.delete(from); },
		async remove(path: string) { check(); files.delete(path); },
	};
}
