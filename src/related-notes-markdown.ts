/** Locale-independent block contract, shared by analysis and saving. */
export const RELATED_NOTES_START = '<!-- ai-helper:related-notes:start -->';
export const RELATED_NOTES_END = '<!-- ai-helper:related-notes:end -->';

/** Preserve offsets while hiding fenced/indented code and inline code examples. */
function withoutCode(text: string): string {
	const blank = (value: string) => value.replace(/[^\r\n]/g, ' ');
	let fence: { character: string; length: number; quotes: number; indentation: number } | undefined;
	const lists: number[] = [];
	let paragraph = false;
	return text.split(/(?<=\n)/).map(line => {
		if (!line.trim()) { paragraph = false; return line; }
		const prefix = line.match(/^(?: {0,3}>[ \t]?)+/)?.[0] ?? '';
		const quotes = (prefix.match(/>/g) ?? []).length;
		if (fence && quotes < fence.quotes) fence = undefined;
		const quoted = fence ? line.replace(new RegExp(`^(?: {0,3}>[ \\t]?){${fence.quotes}}`), '') : line.slice(prefix.length);
		const expanded = quoted.replace(/^\t+/, tabs => ' '.repeat(tabs.length * 4));
		const indent = expanded.match(/^ */)![0].length;
		if (fence && indent < fence.indentation) fence = undefined;
		while (lists.length && indent < lists[lists.length - 1]) lists.pop();
		const base = lists[lists.length - 1] ?? 0;
		const body = expanded.slice(base);
		const match = body.match(/^ {0,3}(`{3,}|~{3,})(.*)/);
		if (fence) {
			if (match && match[1][0] === fence.character && match[1].length >= fence.length && !match[2].trim()) fence = undefined;
			return blank(line);
		}
		if (match) { fence = { character: match[1][0], length: match[1].length, quotes, indentation: base }; paragraph = false; return blank(line); }
		const item = body.match(/^ {0,3}(?:[-+*]|\d+[.)])[ \t]+(?=\S)/);
		if (item) {
			lists.push(base + item[0].length);
			const opening = body.slice(item[0].length).match(/^(`{3,}|~{3,})/);
			if (opening) { fence = { character: opening[1][0], length: opening[1].length, quotes, indentation: lists[lists.length - 1] }; paragraph = false; return blank(line); }
			paragraph = true; return line;
		}
		if (indent >= base + 4 && !paragraph) return blank(line);
		paragraph = !/^ {0,3}(?:#{1,6} |>|---+$|\*\*\*+$)/.test(body);
		return line;
	}).join('').replace(/(`+)([\s\S]*?)\1(?!`)/g, blank);
}

export function relatedNotesBlocks(text: string): { text: string; blocks: { start: number; end: number }[]; malformed: boolean } {
	const visible = withoutCode(text);
	const markers = [...visible.matchAll(/^ {0,3}<!-- ai-helper:related-notes:(start|end) -->[ \t]*(?:\r?\n|$)/gm)];
	const blocks: { start: number; end: number }[] = [];
	let start: number | undefined;
	let depth = 0;
	let nested = false;
	// Unrecognized spellings/inline markers are unsafe for future append operations.
	let malformed = [...visible.matchAll(/<!--\s*ai-helper:related-notes:/g)].length !== markers.length;
	for (const marker of markers) {
		if (marker[1] === 'start') {
			if (depth++) { nested = true; malformed = true; }
			else start = marker.index!;
		} else if (!depth) malformed = true;
		else if (!--depth) {
			if (!nested) blocks.push({ start: start!, end: marker.index! + marker[0].length });
			start = undefined; nested = false;
		}
	}
	malformed ||= depth !== 0;
	let result = ''; let offset = 0;
	for (const block of blocks) { result += text.slice(offset, block.start); offset = block.end; }
	return { text: result + text.slice(offset), blocks, malformed };
}

/** Resolve destinations from the live text, never from possibly stale link caches. */
export function linkedNotePaths(text: string, resolve: (destination: string) => string | undefined): Set<string> {
	const visible = withoutCode(text).replace(/<!--[\s\S]*?-->/g, '');
	const paths = new Set<string>();
	const add = (raw: string, wiki = false) => {
		let name = raw.split('#')[0];
		if (!wiki) {
			try { name = decodeURIComponent(name.replace(/\\([!"#$%&'()*+,\-./:;<=>?@[\]\\^_`{|}~])/g, '$1')); } catch { return; }
		}
		if (!name || /^(?:[a-z][a-z\d+.-]*:|\/\/)/i.test(name)) return;
		const path = resolve(name); if (path) paths.add(path);
	};
	const key = (value: string) => value.trim().replace(/\s+/g, ' ').toLowerCase();
	const definitions = new Map<string, string>();
	const definitionLines = new Map<number, number>();
	for (const match of visible.matchAll(/^ {0,3}\[([^\]\n]+)\]:[ \t]*(<[^>\n]*>|(?:\\.|[^\s])+)[^\n]*/gm)) {
		definitions.set(key(match[1]), match[2].startsWith('<') ? match[2].slice(1, -1) : match[2]);
		definitionLines.set(match.index!, match.index! + match[0].length);
	}
	for (let offset = 0; offset < visible.length; offset++) {
		const definitionEnd = definitionLines.get(offset);
		if (definitionEnd !== undefined) { offset = definitionEnd; continue; }
		if (visible[offset] === "\\") { offset++; continue; }
		if (visible[offset] !== '[') continue;
		if (visible[offset + 1] === '[') {
			const end = visible.indexOf(']]', offset + 2);
			if (end >= 0 && !visible.slice(offset, end).includes('\n')) { add(visible.slice(offset + 2, end).split('|')[0], true); offset = end + 1; }
			continue;
		}
		const labelEnd = closingBracket(visible, offset);
		if (labelEnd === undefined) continue;
		const label = visible.slice(offset + 1, labelEnd);
		let end = labelEnd;
		let raw: string | undefined;
		if (visible[labelEnd + 1] === '(') {
			const destination = markdownDestination(visible, labelEnd + 2);
			if (destination) { raw = destination.text; end = destination.end; }
		} else if (visible[labelEnd + 1] === '[') {
			const referenceEnd = closingBracket(visible, labelEnd + 1);
			if (referenceEnd !== undefined) { raw = definitions.get(key(visible.slice(labelEnd + 2, referenceEnd) || label)); end = referenceEnd; }
		} else raw = definitions.get(key(label));
		if (raw !== undefined) add(raw);
		offset = end;
	}
	return paths;
}

function closingBracket(text: string, start: number): number | undefined {
	let depth = 1;
	for (let i = start + 1; i < text.length; i++) {
		if (text[i] === "\\") { i++; continue; }
		if (text[i] === '[') depth++;
		if (text[i] === ']' && !--depth) return i;
	}
	return undefined;
}

function markdownDestination(text: string, start: number): { text: string; end: number } | undefined {
	let i = start;
	while (/\s/.test(text[i] ?? '') && i < text.length) i++;
	const begin = i;
	let destination: string;
	if (text[i] === '<') {
		const end = text.indexOf('>', i + 1);
		if (end < 0 || text.slice(i, end).includes('\n')) return undefined;
		destination = text.slice(i + 1, end); i = end + 1;
	} else {
		let depth = 0;
		for (; i < text.length; i++) {
			if (text[i] === "\\") { i++; continue; }
			if (!depth && (/\s/.test(text[i]) || text[i] === ')')) break;
			if (text[i] === '(') depth++;
			if (text[i] === ')') depth--;
		}
		destination = text.slice(begin, i);
	}
	const rest = text.slice(i).match(/^(?:\s+(?:"[^"\n]*"|'[^'\n]*'|\([^()\n]*\)))?\s*\)/);
	return rest ? { text: destination, end: i + rest[0].length - 1 } : undefined;
}

/** Preserve every existing byte, inserting only before the final closing marker. */
export function appendRelatedNotes(text: string, lines: string[], heading: string): string {
	const parsed = relatedNotesBlocks(text);
	if (parsed.malformed) throw new Error("malformed-related-notes");
	const newline = text.includes("\r\n") ? "\r\n" : "\n";
	const tail = parsed.blocks[parsed.blocks.length - 1];
	if (tail && !text.slice(tail.end).trim()) {
		const closing = text.lastIndexOf(RELATED_NOTES_END, tail.end);
		const lineStart = text.lastIndexOf("\n", closing - 1) + 1;
		return text.slice(0, lineStart) + lines.join(newline) + newline + text.slice(lineStart);
	}
	const separator = !text ? "" : text.endsWith(newline + newline) ? "" : text.endsWith(newline) ? newline : newline + newline;
	const next = text + separator + [RELATED_NOTES_START, "## " + heading, ...lines, RELATED_NOTES_END, ""].join(newline);
	const updated = relatedNotesBlocks(next);
	if (updated.malformed || updated.blocks.length !== parsed.blocks.length + 1 || updated.blocks[updated.blocks.length - 1].start !== text.length + separator.length) throw new Error("malformed-related-notes");
	return next;
}
