export interface FragmentOptions { noteFragmentSize: number; noteFragmentOverlap: number; }
export const DEFAULT_FRAGMENT_OPTIONS: FragmentOptions = { noteFragmentSize: 4000, noteFragmentOverlap: 200 };
export function isValidFragmentOptions(value: FragmentOptions): boolean {
	return Number.isSafeInteger(value.noteFragmentSize) && value.noteFragmentSize >= 256 && value.noteFragmentSize <= 16000
		&& Number.isSafeInteger(value.noteFragmentOverlap) && value.noteFragmentOverlap >= 0 && value.noteFragmentOverlap <= value.noteFragmentSize / 4;
}
export interface NoteFragment { text: string; headings: string[]; }

// Only the selected note is read. Wiki links and embeds remain literal text.
export function* noteFragments(path: string, raw: string, metadata: Record<string, unknown>, options: FragmentOptions): Generator<NoteFragment> {
	const title = path.split("/").pop()!.replace(/\.md$/i, "");
	const properties = ["tags", "aliases"].flatMap((key) => {
		const value = metadata[key];
		const values = (Array.isArray(value) ? value : [value]).filter((item): item is string => typeof item === "string");
		return values.length ? [`${key}: ${values.join(", ")}`] : [];
	});
	const body = raw.replace(/^\uFEFF?---\r?\n[\s\S]*?\r?\n(?:---|\.\.\.)(?:\r?\n|$)/, "");
	let hierarchy: Array<{ level: number; text: string }> = [];
	const headings = () => hierarchy.map((heading) => heading.text);
	let section = "";
	let fence: string | undefined;
	function* flush(): Generator<NoteFragment> {
		const prefix = [title, path, ...headings(), ...properties].join("\n");
		const capacity = options.noteFragmentSize - prefix.length - 2;
		if (capacity <= options.noteFragmentOverlap) throw new Error("fragment metadata too long");
		let text = section.trim();
		while (text) {
			let end = Math.min(capacity, text.length);
			if (end < text.length) {
				const paragraph = text.lastIndexOf("\n\n", end);
				if (paragraph > options.noteFragmentOverlap) end = paragraph;
			}
			yield { text: `${prefix}\n\n${text.slice(0, end)}`, headings: headings() };
			if (end === text.length) break;
			text = text.slice(end - options.noteFragmentOverlap);
			if (options.noteFragmentOverlap === 0) text = text.trimStart();
		}
		section = "";
	}
	const lines = body.split(/\r?\n/);
	for (let index = 0; index < lines.length; index++) {
		const line = lines[index];
		const delimiter = line.match(/^\s{0,3}(`{3,}|~{3,})/);
		if (delimiter) {
			if (!fence) fence = delimiter[1];
			else if (delimiter[1][0] === fence[0] && delimiter[1].length >= fence.length && /^ {0,3}(?:`+|~+)\s*$/.test(line)) fence = undefined;
			section += line + "\n"; continue;
		}
		const underline = !fence && line.trim() && lines[index + 1]?.match(/^ {0,3}(=+|-+)\s*$/);
		const heading = underline ? ["", underline[1][0] === "=" ? "#" : "##", line.trim()] : !fence && line.match(/^ {0,3}(#{1,6})\s+(.+?)(?:\s+#+)?\s*$/);
		if (heading) {
			if (underline) index++;
			yield* flush();
			hierarchy = hierarchy.filter((parent) => parent.level < heading[1].length);
			hierarchy.push({ level: heading[1].length, text: heading[2] });
		} else section += line + "\n";
	}
	yield* flush();
}
