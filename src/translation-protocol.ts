import type { TranslationUnit } from "./translation-markdown";

const marker = /⟦AIH\d+:p\d+:\d+⟧/g;
export type TranslationViolation = "format" | "missing" | "duplicate" | "unknown" | "empty" | "structure";
export class TranslationProtocolError extends Error {
	constructor(readonly violation: TranslationViolation, readonly fragment?: string) { super(violation); }
}
interface Fragment extends TranslationUnit { segment: number }
/** Markers are a private local template, never part of the model protocol. */
function segments(unit: TranslationUnit): { parts: string[]; fragments: Fragment[] } {
	const parts = unit.text.split(/(⟦AIH\d+:p\d+:\d+⟧)/g);
	const fragments = parts.flatMap((text, segment) => segment % 2 || !text.trim() ? [] : [{ id: parts.length === 1 ? unit.id : `${unit.id}~${segment / 2}`, text, segment }]);
	return { parts, fragments };
}
export function translationPayload(units: TranslationUnit[], context = true) {
	return {
		units: units.flatMap(unit => segments(unit).fragments.map(({ id, text }) => ({ id, text }))),
		...(context ? { context: units.filter(unit => /⟦AIH/.test(unit.text)).map(unit => ({
			id: unit.id,
			// A bounded ordered paragraph preview lets the model read across formatting.
			// Protected values (including embed contents and destinations) never leave here.
			parts: unit.text.split(marker).map(text => text.slice(0, 64)).slice(0, 8),
			protectedBetweenParts: true,
		})) } : {}),
	};
}
/** Validate every external fragment, then fill the immutable template locally. */
export function decodeTranslation(content: string, units: TranslationUnit[]): string {
	const fail = (kind: TranslationViolation, id?: string): never => { throw new TranslationProtocolError(kind, id); };
	let value: unknown;
	const trimmed = content.trim();
	const fenced = trimmed.match(/^```(?:json)?[ \t]*\r?\n([\s\S]*?)\r?\n```$/i);
	try { value = JSON.parse(fenced ? fenced[1] : trimmed); } catch { fail("format"); }
	if (!value || typeof value !== "object" || Object.keys(value).length !== 1 || !("units" in value) || !Array.isArray(value.units)) throw new TranslationProtocolError("format");
	const templates = units.map(unit => ({ unit, ...segments(unit) }));
	const expected = new Map(templates.flatMap(template => template.fragments).map(fragment => [fragment.id, fragment]));
	const translated = new Map<string, string>();
	for (const item of value.units) {
		if (!item || typeof item !== "object") fail("format");
		const knownId = typeof item.id === "string" && expected.has(item.id) ? item.id : undefined;
		if (Object.keys(item).sort().join(",") !== "id,text" || typeof item.id !== "string" || typeof item.text !== "string") fail("format", knownId);
		// Never reflect a model-supplied identifier into the UI.
		if (!expected.has(item.id)) fail("unknown");
		if (translated.has(item.id)) fail("duplicate", item.id);
		if (!item.text.trim()) fail("empty", item.id);
		if (/[\r\n⟦⟧<>`*_~#$^|\\{}\[\]\u0000-\u001f]/u.test(item.text.trim())) fail("structure", item.id);
		// Spaces belong to the template, including spaces beside emphasis delimiters.
		translated.set(item.id, item.text.trim());
	}
	for (const id of expected.keys()) if (!translated.has(id)) fail("missing", id);
	return JSON.stringify({ units: templates.map(({ unit, parts, fragments }) => {
		for (const fragment of fragments) {
			const leading = fragment.text.match(/^\s*/u)![0];
			const trailing = fragment.text.match(/\s*$/u)![0];
			parts[fragment.segment] = leading + translated.get(fragment.id)! + trailing;
		}
		return { id: unit.id, text: parts.join("") };
	}) });
}
