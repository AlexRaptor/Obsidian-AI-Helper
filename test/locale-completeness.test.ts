import { describe, expect, it } from "vitest";
import { en, ru, LOCALES, LocaleKey, setLanguage, t } from "../src/i18n";

describe("locale completeness", () => {
	it("resolves every dictionary key in every locale", () => {
		const dictionaries = { en, ru };
		for (const [code, dict] of Object.entries(dictionaries)) {
			for (const key of Object.keys(dict) as LocaleKey[]) {
				expect(dict[key], `${code}/${key}`).toBeTypeOf("string");
				expect(dict[key]!.length, `${code}/${key}`).toBeGreaterThan(0);
			}
		}
	});

	it("resolves every key at runtime through t() in every locale", () => {
		for (const locale of LOCALES) {
			setLanguage(locale);
			for (const key of Object.keys(en) as LocaleKey[]) {
				expect(t(key), `${locale}/${key}`).toBeTypeOf("string");
				expect(t(key)!.length, `${locale}/${key}`).toBeGreaterThan(0);
			}
		}
	});
});
