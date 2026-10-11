// Match whole Unicode terms, preserving identifiers such as ERR_AUTH_42 and AB-123.
const STOP_WORDS = new Set("a an the is are was were be to of in on at for from with and or what when where how why does do did can could would should tell me about mean means please что как где когда почему это и или в во на по из с со для о об мне расскажи означает значит ли какой какая какие у за от до не да то же вы мы он его эта этой этом вам кто всё все свой".split(" "));
function terms(text: string): string[] {
	return text.normalize("NFKC").toLocaleLowerCase().match(/[\p{L}\p{N}]+(?:[_-][\p{L}\p{N}]+)*/gu) ?? [];
}
export function lexicalRelevance(question: string, text: string): number {
	const query = [...new Set(terms(question).filter(term => term.length >= 2 && !STOP_WORDS.has(term)))];
	if (!query.length) return 0;
	const document = new Set(terms(text));
	const matches = query.filter(term => document.has(term));
	const identifiers = query.filter(term => /[_\-\d]/u.test(term));
	const matchedIdentifiers = identifiers.filter(term => document.has(term));
	if (matchedIdentifiers.length) return matchedIdentifiers.length / identifiers.length;
	// A complete term/identifier or substantial multi-term coverage is evidence;
	// an isolated common word in a longer question is not.
	const coverage = matches.length / query.length;
	return coverage === 1 || matches.length >= 2 && coverage >= 0.6 ? coverage : 0;
}

export function repeatedFragment(left: string, right: string): boolean {
	// Metadata repeats in every fragment; compare the body only, across notes too.
	const body = (text: string) => text.slice(text.indexOf("\n\n") + 2).normalize("NFKC").toLocaleLowerCase().replace(/\s+/g, " ").trim();
	const a = body(left), b = body(right);
	if (a === b) return true;
	// Near copies can still record different facts: preserve distinct values/IDs.
	const values = (text: string) => [...new Set(terms(text).filter(term => /[\d_-]/u.test(term)))].join("\n");
	if (values(a) !== values(b)) return false;
	const shingles = (text: string) => {
		const words = terms(text);
		return new Set(words.slice(0, -4).map((_, index) => words.slice(index, index + 5).join(" ")));
	};
	const x = shingles(a), y = shingles(b);
	if (!x.size || !y.size) return false;
	const common = [...x].filter(value => y.has(value)).length;
	return common / (x.size + y.size - common) >= 0.8;
}
