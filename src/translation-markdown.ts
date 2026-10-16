/** Reversible translation ranges. Source syntax and protected contents stay local. */
export interface TranslationUnit { id: string; text: string }
interface Range extends TranslationUnit { start: number; end: number; protected: string[] }
export class TranslationMarkdownError extends Error {
	constructor(readonly kind: "unsupported" | "invalid" | "empty") { super(kind); }
}
function unsupported(): never { throw new TranslationMarkdownError("unsupported"); }
function invalid(): never { throw new TranslationMarkdownError("invalid"); }

export class TranslationMarkdown {
	readonly units: TranslationUnit[] = [];
	readonly frontmatterEnd: number;
	private ranges: Range[] = [];
	private marker = "";
	constructor(private source: string) {
		if (!source.trim()) throw new TranslationMarkdownError("empty");
		let nonce = 0;
		do { this.marker = `⟦AIH${nonce++}:`; } while (source.includes(this.marker));
		const frontmatter = source.match(/^(?:\uFEFF)?---[ \t]*\r?\n(?:[\s\S]*?\r?\n)?(?:---|\.\.\.)[ \t]*(?:\r?\n|$)/);
		if (/^(?:\uFEFF)?---[ \t]*\r?\n/.test(source) && !frontmatter) unsupported();
		this.frontmatterEnd = frontmatter?.[0].length ?? 0;
		this.parseBlocks();
	}
	private token(range: Range, value: string): string {
		const token = `${this.marker}${range.id}:${range.protected.length}⟧`;
		range.protected.push(value);
		return token;
	}
	private add(start: number, end: number): void {
		const value = this.source.slice(start, end);
		const leading = value.match(/^\s*/u)![0].length;
		const trailing = value.match(/\s*$/u)![0].length;
		if (leading + trailing >= value.length) return;
		const range: Range = { id: `p${this.ranges.length + 1}`, text: "", start: start + leading, end: end - trailing, protected: [] };
		range.text = this.inline(this.source.slice(range.start, range.end), range);
		// A range containing only protected syntax needs no model round-trip.
		if (!range.text.replace(/⟦AIH\d+:p\d+:\d+⟧/g, "").trim()) return;
		this.ranges.push(range);
		this.units.push({ id: range.id, text: range.text });
	}
	private parseBlocks(): void {
		const lines = [...this.source.slice(this.frontmatterEnd).matchAll(/[^\n]*(?:\n|$)/g)].filter(match => match[0]);
		let offset = this.frontmatterEnd;
		let protectedBlock: { closing: RegExp; quoteDepth: number; indent: number } | undefined;
		let listIndents: number[] = [];
		let paragraph: { start: number; end: number } | undefined;
		let protectedUntil = 0;
		const flush = () => { if (paragraph) this.add(paragraph.start, paragraph.end); paragraph = undefined; };
		for (const match of lines) {
			const line = match[0].replace(/\r?\n$/, "");
			const start = offset; offset += match[0].length;
			if (start < protectedUntil) continue;
			if (protectedBlock) {
				let content = line;
				for (let depth = 0; depth < protectedBlock.quoteDepth; depth++) {
					const prefix = content.match(/^ {0,3}>[ \t]?/);
					if (!prefix) unsupported();
					content = content.slice(prefix[0].length);
				}
				if (content.trim() && content.match(/^[ \t]*/)![0].length < protectedBlock.indent) unsupported();
				content = content.slice(protectedBlock.indent);
				if (protectedBlock.closing.test(content)) protectedBlock = undefined;
				continue;
			}
			// Containers are local syntax. List continuation indentation is relative
			// to the most recent item, so nested prose is not mistaken for code.
			const quote = line.match(/^(?: {0,3}>[ \t]?)+/)?.[0] ?? "";
			const inner = line.slice(quote.length);
			if (/^ {0,3}(?:(?:\*[ \t]*){3,}|(?:-[ \t]*){3,}|(?:_[ \t]*){3,})$/.test(inner)) { flush(); continue; }
			let item = inner.match(/^(\s*)(?:[-+*]|\d+[.)])[ \t]+(?:\[[ xX]\][ \t]+)?/);
			const indent = inner.match(/^[ \t]*/)![0];
			if (!inner.trim()) { flush(); continue; }
			while (listIndents.length && indent.length < listIndents[listIndents.length - 1]) listIndents.pop();
			const relativeIndent = inner.slice(listIndents[listIndents.length - 1] ?? 0);
			if (/^(?: {4}|\t)/.test(relativeIndent)) {
				if (!paragraph) { flush(); continue; }
				item = null;
			}
			let prefix = quote.length;
			if (item) {
				listIndents.push(item[0].replace(/\[[ xX]\][ \t]+$/, "").length);
				prefix += item[0].length;
			} else if (listIndents.length) prefix += listIndents[listIndents.length - 1];
			const content = line.slice(prefix);
			const trimmed = content.trim();
			if (/^(?: {4}|\t)/.test(content) && !paragraph) { flush(); continue; }
			const opening = content.match(/^ {0,3}(`{3,}|~{3,})(.*)$/);
			if (opening) {
				flush(); if (opening[1][0] === "`" && opening[2].includes("`")) unsupported();
				protectedBlock = { closing: new RegExp(`^ {0,3}${opening[1][0]}{${opening[1].length},}[ \\t]*$`), quoteDepth: (quote.match(/>/g) ?? []).length, indent: prefix - quote.length }; continue;
			}
			if (/^\s*\$\$/.test(content)) {
				flush();
				if (!/^\s*\$\$[\s\S]+\$\$\s*$/.test(content)) protectedBlock = { closing: /^\s*\$\$\s*$/, quoteDepth: (quote.match(/>/g) ?? []).length, indent: prefix - quote.length };
				continue;
			}
			if (/^ {0,3}(?:(?:\*[ \t]*){3,}|(?:-[ \t]*){3,}|(?:_[ \t]*){3,}|=+[ \t]*|-+[ \t]*)$/.test(content)) { flush(); continue; }
			if (/^ {0,3}\[(?!\^)[^\]]+\]:/.test(content)) {
				flush(); protectedUntil = start + prefix + this.referenceLength(this.source.slice(start + prefix)); continue;
			}
			// Tables, footnotes, callouts, HTML and extension syntax are deliberately
			// not guessed in this slice. No partial file is saved on this boundary.
			if (/^\s*(?:\[\^|\[!|:{3,}|[|])/.test(content)) unsupported();
			const heading = content.match(/^ {0,3}#{1,6}[ \t]+/);
			if (heading || item || quote || listIndents.length) {
				flush();
				const from = start + prefix + (heading?.[0].length ?? 0);
				const closing = heading ? content.match(/[ \t]+#+[ \t]*$/)?.[0].length ?? 0 : 0;
				this.add(from, start + line.length - closing); continue;
			}
			if (!trimmed) { flush(); continue; }
			if (!paragraph) paragraph = { start, end: start + line.length };
			else paragraph.end = start + line.length;
		}
		flush();
		if (protectedBlock) unsupported();
	}
	private referenceLength(text: string): number {
		const label = text.match(/^ {0,3}\[(?!\^)[^\]\r\n]+\]:[ \t]*/)![0];
		let at = label.length;
		const skipSpace = () => { while (/[ \t]/.test(text[at] ?? "") && at < text.length) at++; };
		const nextLine = () => { const line = text.slice(at).match(/^\r?\n[ \t]*/); if (line) at += line[0].length; };
		nextLine();
		if (text[at] === "<") {
			const end = text.indexOf(">", at + 1); if (end < 0 || /[\r\n]/.test(text.slice(at, end))) unsupported(); at = end + 1;
		} else {
			const destination = text.slice(at).match(/^(?:\\.|[^\s\\])+/); if (!destination) unsupported(); at += destination[0].length;
		}
		skipSpace();
		const destinationEnd = at;
		nextLine();
		const open = text[at];
		if (open === '"' || open === "'" || open === "(") {
			const close = open === "(" ? ")" : open;
			for (at++; at < text.length; at++) { if (text[at] === "\\") { at++; continue; } if (text[at] === close) break; }
			if (at >= text.length) unsupported(); at++; skipSpace();
		} else at = destinationEnd;
		if (at < text.length && text[at] !== "\r" && text[at] !== "\n") unsupported();
		const newline = text.slice(at).match(/^\r?\n/); return at + (newline?.[0].length ?? 0);
	}
	private inline(text: string, range: Range): string {
		let result = "";
		const protect = (value: string) => this.token(range, value);
		for (let i = 0; i < text.length;) {
			const rest = text.slice(i);
			if (/^[\u0000-\u0008\u000b\u000c\u000e-\u001f]/.test(rest)) unsupported();
			const literalMarker = rest.match(/^⟦AIH\d+:p\d+:\d+⟧/);
			if (literalMarker) { result += protect(literalMarker[0]); i += literalMarker[0].length; continue; }
			const lineBreak = rest.match(/^(?:[ \t]*\\?\r?\n)[ \t]*/);
			if (lineBreak) { result += protect(lineBreak[0]); i += lineBreak[0].length; continue; }
			if (rest === "\\") { result += protect(rest); i++; continue; }
			const escaped = rest.match(/^\\[!"#$%&'()*+,\-./:;<=>?@[\]\\^_`{|}~]/);
			if (escaped) { result += protect(escaped[0]); i += escaped[0].length; continue; }
			if (rest[0] === "`") {
				const ticks = rest.match(/^`+/)![0];
				let end = ticks.length;
				while (end < rest.length) { const next = rest.indexOf(ticks, end); if (next < 0) unsupported(); if (rest[next - 1] !== "`" && rest[next + ticks.length] !== "`") { end = next + ticks.length; break; } end = next + ticks.length; }
				if (end <= ticks.length || end > rest.length || !rest.slice(ticks.length, end).endsWith(ticks)) unsupported();
				result += protect(rest.slice(0, end)); i += end; continue;
			}
			if (rest[0] === "$") {
				const delimiter = rest.startsWith("$$") ? "$$" : "$";
				let end = delimiter.length;
				do { end = rest.indexOf(delimiter, end); if (end < 0) unsupported(); if (rest[end - 1] !== "\\") break; end++; } while (true);
				end += delimiter.length; result += protect(rest.slice(0, end)); i += end; continue;
			}
			const wiki = rest.match(/^(!?)\[\[([^\]\n]+)\]\]/);
			if (wiki) {
				const separator = wiki[2].indexOf("|");
				if (separator < 0 || /^\d+(?:x\d+)?$/.test(wiki[2].slice(separator + 1))) result += protect(wiki[0]);
				else {
					result += protect(`${wiki[1]}[[${wiki[2].slice(0, separator + 1)}`);
					result += this.inline(wiki[2].slice(separator + 1), range) + protect("]]");
				}
				i += wiki[0].length; continue;
			}
			if (rest.startsWith("![") || rest[0] === "[") {
				const open = rest.startsWith("![") ? 2 : 1;
				let end = open; let depth = 1;
				for (; end < rest.length; end++) { if (rest[end] === "\\") { end++; continue; } if (rest[end] === "[") depth++; if (rest[end] === "]" && --depth === 0) break; }
				if (end >= rest.length || rest[open] === "^" || rest[open] === "!") unsupported();
				const label = rest.slice(open, end);
				let tail = end + 1;
				let suffix: string;
				if (rest[tail] === "(") {
					let balance = 1; let angle = false; let quote = "";
					for (tail++; tail < rest.length; tail++) {
						const char = rest[tail];
						if (char === "\\") { tail++; continue; }
						if (quote) { if (char === quote) quote = ""; continue; }
						if (!angle && /[ \t]/.test(rest[tail - 1]) && (char === '"' || char === "'")) { quote = char; continue; }
						if (char === "<") angle = true; if (char === ">") angle = false;
						if (!angle) { if (char === "(") balance++; if (char === ")" && --balance === 0) break; }
					}
					if (tail >= rest.length) unsupported(); tail++;
					suffix = rest.slice(end, tail);
				} else if (rest[tail] === "[") {
					const ref = rest.slice(tail).match(/^\[([^\]\n]*)\]/); if (!ref) unsupported();
					tail += ref[0].length; suffix = `][${ref[1] || label}]`;
				} else {
					// Shortcut references acquire an explicit immutable reference label.
					const escaped = label.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
					if (!new RegExp(`^ {0,3}\\[${escaped}\\]:`, "im").test(this.source)) unsupported();
					suffix = `][${label}]`;
				}
				result += protect(rest.slice(0, open)) + this.inline(label, range) + protect(suffix);
				i += tail; continue;
			}
			const tag = rest.match(/^#[\p{L}\p{N}_/-]+/u);
			if (tag && (i === 0 || !/[\p{L}\p{N}_/]/u.test(text[i - 1])) && /[\p{L}_/-]/u.test(tag[0])) { result += protect(tag[0]); i += tag[0].length; continue; }
			const block = rest.match(/^\^[\p{L}\p{N}-]+(?=[ \t]*$)/u);
			if (block) { result += protect(block[0]); i += block[0].length; continue; }
			const entity = rest.match(/^&(?:#\d+|#x[\da-f]+|[a-z][a-z\d]+);/i);
			if (entity) { result += protect(entity[0]); i += entity[0].length; continue; }
			const emptyMarkup = rest.match(/^(?:<!--[ \t\r\n]*-->|<(?:br|hr|wbr)[ \t]*\/?[ \t]*>)/i);
			if (emptyMarkup) { result += protect(emptyMarkup[0]); i += emptyMarkup[0].length; continue; }
			const autolink = rest.match(/^<(?:https?:\/\/[^<>\s]+|[^<>\s@]+@[^<>\s@]+)>/i);
			if (autolink) { result += protect(autolink[0]); i += autolink[0].length; continue; }
			const url = rest.match(/^(?:https?:\/\/|obsidian:\/\/)[^\s<>]+/i);
			if (url) { result += protect(url[0]); i += url[0].length; continue; }
			if (rest.startsWith("==") || rest.startsWith("%%") || /[⟦⟧<>|{}\[\]\\]/.test(rest[0])) unsupported();
			const emphasis = rest.match(/^(?:\*+|_+|~+)/);
			if (emphasis) { result += protect(emphasis[0]); i += emphasis[0].length; continue; }
			result += rest[0]; i++;
		}
		return result;
	}
	assemble(content: string, originalLink: string): string {
		let value: unknown;
		const trimmed = content.trim();
		const fenced = trimmed.match(/^```(?:json)?[ \t]*\r?\n([\s\S]*?)\r?\n```$/i);
		try { value = JSON.parse(fenced ? fenced[1] : trimmed); } catch { invalid(); }
		if (!value || typeof value !== "object" || !("units" in value) || !Array.isArray(value.units) || value.units.length !== this.units.length) invalid();
		const translated = new Map<string, string>();
		for (const unit of value.units) {
			const range = this.ranges.find(range => range.id === unit?.id);
			if (!range || translated.has(unit.id) || typeof unit.text !== "string" || !unit.text.trim()) invalid();
			const tokens = unit.text.match(/⟦AIH\d+:p\d+:\d+⟧/g) ?? [];
			const expected = range.protected.map((_, index) => `${this.marker}${range.id}:${index}⟧`);
			if (tokens.length !== expected.length || tokens.some((token: string, i: number) => token !== expected[i])) invalid();
			for (let i = 0; i < expected.length; i++) {
				if (!/^[*_~]+$/.test(range.protected[i])) continue;
				const token = expected[i];
				const originalAt = range.text.indexOf(token);
				const translatedAt = unit.text.indexOf(token);
				const boundary = (text: string, at: number) => at < 0 || at >= text.length ? "edge" : /\s/u.test(text[at]) ? "space" : "text";
				if (boundary(range.text, originalAt - 1) !== boundary(unit.text, translatedAt - 1)
					|| boundary(range.text, originalAt + token.length) !== boundary(unit.text, translatedAt + token.length)) invalid();
			}
			const segments = (text: string) => text.trim().split(/⟦AIH\d+:p\d+:\d+⟧/g);
			const originalSegments = segments(range.text);
			if (segments(unit.text).some((segment: string, index: number) => !!segment.trim() !== !!originalSegments[index].trim())) invalid();
			let lineIndex = 0;
			const proseLines = unit.text.trim().replace(/⟦AIH\d+:p\d+:\d+⟧/g, () => /^[ \t]*\\?\r?\n[ \t]*$/.test(range.protected[lineIndex++]) ? "\n" : "");
			if (/(^|\n)[ \t]*(?:[=-]+[ \t]*(?:\n|$)|(?:[-+>:=]|\d+[.)])(?:\s|$))/.test(proseLines)) invalid();
			const plain = unit.text.trim().replace(/⟦AIH\d+:p\d+:\d+⟧/g, "");
			// Model prose cannot create local structure, placeholders, or Markdown.
			if (!plain.trim() || /[\r\n⟦⟧<>`*_~#$^|\\{}\[\]\u0000-\u0008]/u.test(plain) || /\n[ \t]*\n|(^|\n)\s*(?:[-+>:=]|\d+[.)])(?:\s|$)/u.test(plain)) invalid();
			let index = 0;
			const restored = unit.text.trim().replace(/⟦AIH\d+:p\d+:\d+⟧/g, () => range.protected[index++]);
			translated.set(unit.id, restored);
		}
		let body = ""; let cursor = this.frontmatterEnd;
		for (const range of this.ranges) { body += this.source.slice(cursor, range.start) + translated.get(range.id)!; cursor = range.end; }
		body += this.source.slice(cursor);
		const frontmatter = this.source.slice(0, this.frontmatterEnd);
		return frontmatter + (frontmatter && !frontmatter.endsWith("\n") ? "\n" : "") + originalLink + "\n\n" + body;
	}
}
