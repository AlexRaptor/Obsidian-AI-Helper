import { stripHeading, stripHeadingForLink } from "obsidian";
import type { TranslationLinks } from "./translation-links";
/** Reversible translation ranges. Source syntax and protected contents stay local. */
export interface TranslationUnit { id: string; text: string }
interface Range extends TranslationUnit { start: number; end: number; protected: string[]; headingText: string[] }
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
	private headings: { start: number; end: number; key?: string }[] = [];
	private referenceDefinitions: { start: number; end: number; text: string }[] = [];
	private references = new Map<string, boolean>();
	constructor(private source: string, private links?: TranslationLinks) {
		if (!source.trim()) throw new TranslationMarkdownError("empty");
		let nonce = 0;
		do { this.marker = `⟦AIH${nonce++}:`; } while (source.includes(this.marker));
		const frontmatter = source.match(/^(?:\uFEFF)?---[ \t]*\r?\n(?:[\s\S]*?\r?\n)?(?:---|\.\.\.)[ \t]*(?:\r?\n|$)/);
		if (/^(?:\uFEFF)?---[ \t]*\r?\n/.test(source) && !frontmatter) unsupported();
		this.frontmatterEnd = frontmatter?.[0].length ?? 0;
		this.parseBlocks();
		for (const definition of this.referenceDefinitions) {
			const key = this.referenceKey(definition.text.match(/^ {0,3}\[([^\]]+)\]/)![1]);
			if (this.references.has(key)) unsupported();
			this.references.set(key, true);
		}
		for (const heading of this.headings) {
			heading.key = stripHeading(this.headingRanges(heading).map(range => this.headingLabel(this.source.slice(range.start, range.end))).join(" ")).toLowerCase();
		}
		this.links?.setHeadings(this.headings.map(heading => heading.key!));
		for (const definition of this.referenceDefinitions) {
			const rewritten = this.reference(definition.text);
			const range = this.ranges.find(range => range.start === definition.start)!;
			range.protected[0] = rewritten;
		}
		for (const range of this.ranges) {
			if (!range.text) range.text = this.inline(this.source.slice(range.start, range.end), range);
			// Protected-only ranges still participate in local assembly.
			if (range.text.replace(/⟦AIH\d+:p\d+:\d+⟧/g, "").trim()) this.units.push({ id: range.id, text: range.text });
		}
	}
	private token(range: Range, value: string, headingText?: string): string {
		const token = `${this.marker}${range.id}:${range.protected.length}⟧`;
		range.protected.push(value);
		range.headingText.push(headingText ?? this.headingToken(value));
		return token;
	}
	private headingToken(value: string): string {
		if (/^[*_~]+$|^!?\[$|^\]|^!?\[\[.*\|$/s.test(value)) return "";
		if (/^[ \t]*\\?\r?\n/.test(value)) return " ";
		if (value.startsWith("`")) return value.replace(/^`+|`+$/g, "");
		return value.replace(/^\\/, "");
	}
	private headingRanges(heading: { start: number; end: number }): Range[] {
		return this.ranges.filter(range => range.start >= heading.start && range.end <= heading.end);
	}
	private headingLabel(source: string): string {
		const range: Range = { id: "p0", text: "", start: 0, end: source.length, protected: [], headingText: [] };
		return this.headingProse(range, this.inline(source, range, false));
	}
	private headingProse(range: Range, text: string): string {
		let index = 0;
		return text.replace(/⟦AIH\d+:p\d+:\d+⟧/g, () => range.headingText[index++]);
	}
	private add(start: number, end: number): void {
		const value = this.source.slice(start, end);
		const leading = value.match(/^\s*/u)![0].length;
		const trailing = value.match(/\s*$/u)![0].length;
		if (leading + trailing >= value.length) return;
		const range: Range = { id: `p${this.ranges.length + 1}`, text: "", start: start + leading, end: end - trailing, protected: [], headingText: [] };
		this.ranges.push(range);
	}
	private parseBlocks(): void {
		const lines = [...this.source.slice(this.frontmatterEnd).matchAll(/[^\n]*(?:\n|$)/g)].filter(match => match[0]);
		let offset = this.frontmatterEnd;
		let protectedBlock: { closing: RegExp; quoteDepth: number; indent: number } | undefined;
		let listIndents: number[] = [];
		let footnoteQuote: string | undefined;
		const definitions = new Set<string>();
		let paragraph: { start: number; end: number } | undefined;
		let protectedUntil = 0;
		let setextParagraph: { start: number; next: number; prefix: string } | undefined;
		let table: { columns: number; prefix: string } | undefined;
		const flush = () => { if (paragraph) this.add(paragraph.start, paragraph.end); paragraph = undefined; };
		for (const match of lines) {
			const line = match[0].replace(/\r?\n$/, "");
			const start = offset; offset += match[0].length;
			if (start < protectedUntil) continue;
			if (setextParagraph?.next !== start) setextParagraph = undefined;
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
			let inner = line.slice(quote.length);
			const definition = inner.match(/^ {0,3}\[\^([^\]\s]+)\]:[ \t]*/);
			let footnotePrefix = 0;
			if (definition) {
				flush();
				if (definitions.has(definition[1])) unsupported();
				definitions.add(definition[1]);
				footnoteQuote = quote; listIndents = [];
				footnotePrefix = definition[0].length;
			} else if (footnoteQuote !== undefined && inner.trim()) {
				const continuation = inner.match(/^(?: {4}|\t)/);
				if (quote === footnoteQuote && continuation) footnotePrefix = continuation[0].length;
				else { flush(); footnoteQuote = undefined; listIndents = []; }
			}
			inner = inner.slice(footnotePrefix);
			if (/^ {0,3}(?:(?:\*[ \t]*){3,}|(?:-[ \t]*){3,}|(?:_[ \t]*){3,})$/.test(inner)) { flush(); table = undefined; continue; }
			let item = inner.match(/^(\s*)(?:[-+*]|\d+[.)])[ \t]+(?:\[[ xX]\][ \t]+)?/);
			const indent = inner.match(/^[ \t]*/)![0];
			if (!inner.trim()) { flush(); table = undefined; continue; }
			while (listIndents.length && indent.length < listIndents[listIndents.length - 1]) listIndents.pop();
			const relativeIndent = inner.slice(listIndents[listIndents.length - 1] ?? 0);
			if (/^(?: {4}|\t)/.test(relativeIndent)) {
				if (!paragraph) { flush(); table = undefined; continue; }
				item = null;
			}
			let prefix = quote.length + footnotePrefix;
			if (item) {
				listIndents.push(item[0].replace(/\[[ xX]\][ \t]+$/, "").length);
				prefix += item[0].length;
			} else if (listIndents.length) prefix += listIndents[listIndents.length - 1];
			const content = line.slice(prefix);
			const cells = this.tableCells(content);
			if (table && table.prefix === line.slice(0, prefix) && cells) {
				flush();
				if (cells.length !== table.columns) unsupported();
				for (const cell of cells) this.add(start + prefix + cell.start, start + prefix + cell.end);
				continue;
			}
			table = undefined;
			const nextLine = this.source.slice(offset).match(/^[^\r\n]*/)?.[0] ?? "";
			const delimiter = nextLine.startsWith(line.slice(0, prefix)) ? this.tableCells(nextLine.slice(prefix)) : undefined;
			if (cells && delimiter?.every(cell => /^:?-{3,}:?$/.test(nextLine.slice(prefix + cell.start, prefix + cell.end).trim()))) {
				flush();
				if (cells.length !== delimiter.length) unsupported();
				table = { columns: cells.length, prefix: line.slice(0, prefix) };
				for (const cell of cells) this.add(start + prefix + cell.start, start + prefix + cell.end);
				protectedUntil = offset + nextLine.length;
				continue;
			}
			const trimmed = content.trim();
			if (/^(?: {4}|\t)/.test(content) && !paragraph) { flush(); continue; }
			const opening = content.match(/^ {0,3}(`{3,}|~{3,})(.*)$/);
			if (opening) {
				flush(); if (opening[1][0] === "`" && opening[2].includes("`")) unsupported();
				protectedBlock = { closing: new RegExp(`^ {0,3}${opening[1][0]}{${opening[1].length},}[ \\t]*$`), quoteDepth: (quote.match(/>/g) ?? []).length, indent: prefix - quote.length - footnotePrefix + (definition ? 4 : footnotePrefix) }; continue;
			}
			if (/^\s*\$\$/.test(content)) {
				flush();
				if (!/^\s*\$\$[\s\S]+\$\$\s*$/.test(content)) protectedBlock = { closing: /^\s*\$\$\s*$/, quoteDepth: (quote.match(/>/g) ?? []).length, indent: prefix - quote.length - footnotePrefix + (definition ? 4 : footnotePrefix) };
				continue;
			}
			if (/^ {0,3}(?:(?:\*[ \t]*){3,}|(?:-[ \t]*){3,}|(?:_[ \t]*){3,}|=+[ \t]*|-+[ \t]*)$/.test(content)) { flush(); continue; }
			if (/^ {0,3}\[(?!\^)[^\]]+\]:/.test(content)) {
				flush(); protectedUntil = start + prefix + this.referenceLength(this.source.slice(start + prefix));
				const original = this.source.slice(start + prefix, protectedUntil);
				this.referenceDefinitions.push({ start: start + prefix, end: protectedUntil, text: original });
				this.literal(start + prefix, protectedUntil, original);
				continue;
			}
			const callout = content.match(/^ {0,3}\[![a-z0-9_-]+\][+-]?(?:[ \t]+|$)/i);
			if (quote && callout) {
				flush(); this.add(start + prefix + callout[0].length, start + line.length); continue;
			}
			// Unknown extensions stop before any file can be saved as complete.
			if (/^\s*(?:\[!|:{3,}|[|])/.test(content)) unsupported();
			const heading = content.match(/^ {0,3}#{1,6}[ \t]+/);
			const container = line.slice(0, prefix);
			const nextContent = nextLine.startsWith(container) ? nextLine.slice(container.length) : "";
			if (!heading && !item && !footnotePrefix && !listIndents.length && /^ {0,3}(?:=+|-+)[ \t]*$/.test(nextContent)) {
				const from = setextParagraph?.prefix === container ? setextParagraph.start : start + prefix;
				if (paragraph) { paragraph.end = start + line.length; flush(); }
				else this.add(start + prefix, start + line.length);
				this.headings.push({ start: from, end: start + line.length });
				protectedUntil = offset + nextLine.length; setextParagraph = undefined; continue;
			}
			if (heading || item || quote || footnotePrefix || listIndents.length) {
				flush();
				const from = start + prefix + (heading?.[0].length ?? 0);
				const closing = heading ? content.match(/[ \t]+#+[ \t]*$/)?.[0].length ?? 0 : 0;
				this.add(from, start + line.length - closing);
				if (heading) this.headings.push({ start: from, end: start + line.length - closing });
				else if (quote && !item && !footnotePrefix && !listIndents.length) setextParagraph = { start: setextParagraph?.prefix === container ? setextParagraph.start : from, next: offset, prefix: container };
				continue;
			}
			if (!trimmed) { flush(); continue; }
			if (!paragraph) paragraph = { start, end: start + line.length };
			else paragraph.end = start + line.length;
			setextParagraph = { start: paragraph.start, next: offset, prefix: container };
		}
		flush();
		if (protectedBlock) unsupported();
	}
	/** Unescaped pipes are structural, even inside inline code in an Obsidian table. */
	private tableCells(line: string): { start: number; end: number }[] | undefined {
		const separators: number[] = [];
		for (let i = 0; i < line.length; i++) {
			if (line[i] === "\\") { i++; continue; }
			if (line[i] === "|") separators.push(i);
		}
		if (!separators.length) return undefined;
		const edges = [-1, ...separators, line.length];
		const cells = edges.slice(0, -1).map((edge, index) => ({ start: edge + 1, end: edges[index + 1] }));
		if (!line.slice(0, separators[0]).trim()) cells.shift();
		if (!line.slice(separators[separators.length - 1] + 1).trim()) cells.pop();
		return cells.length ? cells : undefined;
	}
	private literal(start: number, end: number, value: string): void {
		const range: Range = { id: `p${this.ranges.length + 1}`, text: "", start, end, protected: [], headingText: [] };
		range.text = this.token(range, value); this.ranges.push(range);
	}
	private referenceKey(label: string): string { return label.trim().replace(/\s+/g, " ").toLowerCase(); }
	private destination(text: string, start: number): { start: number; end: number; raw: string } {
		let at = start;
		if (text[at] === "<") {
			const end = text.indexOf(">", at + 1); if (end < 0) unsupported();
			return { start: at + 1, end, raw: text.slice(at + 1, end) };
		}
		let depth = 0;
		for (; at < text.length; at++) {
			const char = text[at];
			if (char === "\\") { at++; continue; }
			if (/\s/.test(char)) break;
			if (char === "(") depth++;
			if (char === ")") { if (!depth) break; depth--; }
		}
		if (depth) unsupported();
		return { start, end: at, raw: text.slice(start, at) };
	}
	private reference(text: string): string {
		const label = text.match(/^ {0,3}\[([^\]\r\n]+)\]:[ \t]*(?:\r?\n[ \t]*)?/);
		if (!label) unsupported();
		const key = this.referenceKey(label[1]);
		const destination = this.destination(text, label[0].length);
		const replacement = this.links?.capture(destination.raw, false);
		this.references.set(key, !this.links || replacement !== undefined);
		return replacement === undefined ? text : text.slice(0, destination.start) + replacement + text.slice(destination.end);
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
	private inline(text: string, range: Range, captureLinks = true): string {
		let result = "";
		const protect = (value: string, headingText?: string) => this.token(range, value, headingText);
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
				const destination = separator < 0 ? wiki[2] : wiki[2].slice(0, separator);
				const replacement = captureLinks ? this.links?.capture(destination, true) : undefined;
				if (captureLinks && this.links && replacement === undefined) { result += protect(wiki[0], separator < 0 ? destination : this.headingLabel(wiki[2].slice(separator + 1))); i += wiki[0].length; continue; }
				const target = replacement ?? destination;
				if (separator < 0 || /^\d+(?:x\d+)?$/.test(wiki[2].slice(separator + 1))) result += protect(`${wiki[1]}[[${target}${separator < 0 ? "" : wiki[2].slice(separator)}]]`, destination);
				else {
					result += protect(`${wiki[1]}[[${target}|`);
					result += this.inline(wiki[2].slice(separator + 1), range, captureLinks) + protect("]]");
				}
				i += wiki[0].length; continue;
			}
			const footnote = rest.match(/^\[\^[^\]\s]+\]/);
			if (footnote) { result += protect(footnote[0]); i += footnote[0].length; continue; }
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
					const prefix = suffix.match(/^\]\([ \t]*/)![0].length;
					const destination = this.destination(suffix, prefix);
					const replacement = captureLinks ? this.links?.capture(destination.raw, false) : undefined;
					if (captureLinks && this.links && replacement === undefined) { result += protect(rest.slice(0, tail), this.headingLabel(label)); i += tail; continue; }
					if (replacement !== undefined) suffix = suffix.slice(0, destination.start) + replacement + suffix.slice(destination.end);
				} else if (rest[tail] === "[") {
					const ref = rest.slice(tail).match(/^\[([^\]\n]*)\]/); if (!ref) unsupported();
					tail += ref[0].length; suffix = `][${ref[1] || label}]`;
					if (captureLinks && this.links && !this.references.get(this.referenceKey(ref[1] || label))) { this.links.unresolved = true; result += protect(rest.slice(0, tail), this.headingLabel(label)); i += tail; continue; }
				} else {
					// Shortcut references acquire an explicit immutable reference label.
					if (!this.references.has(this.referenceKey(label))) unsupported();
					if (captureLinks && this.links && !this.references.get(this.referenceKey(label))) { result += protect(rest.slice(0, tail), this.headingLabel(label)); i += tail; continue; }
					suffix = `][${label}]`;
				}
				result += protect(rest.slice(0, open)) + this.inline(label, range, captureLinks) + protect(suffix);
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
		const headingProse = new Map<string, string>();
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
			headingProse.set(unit.id, this.headingProse(range, unit.text.trim()));
		}
		for (const range of this.ranges) {
			if (!translated.has(range.id)) { let index = 0; translated.set(range.id, range.text.replace(/⟦AIH\d+:p\d+:\d+⟧/g, () => range.protected[index++])); }
		}
		const headings = new Map<string, string>();
		for (const heading of this.headings) {
			const value = this.headingRanges(heading).map(range => headingProse.get(range.id) ?? this.headingProse(range, range.text)).join(" ");
			const key = heading.key!;
			if (headings.has(key)) headings.set(key, ""); else headings.set(key, stripHeadingForLink(value));
		}
		let body = ""; let cursor = this.frontmatterEnd;
		for (const range of this.ranges) { body += this.source.slice(cursor, range.start) + translated.get(range.id)!; cursor = range.end; }
		body += this.source.slice(cursor);
		if (this.links) body = this.links.assemble(body, headings);
		const frontmatter = this.source.slice(0, this.frontmatterEnd);
		return frontmatter + (frontmatter && !frontmatter.endsWith("\n") ? "\n" : "") + originalLink + "\n\n" + body;
	}
}
