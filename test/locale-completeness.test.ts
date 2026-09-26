import { describe, expect, it } from "vitest";
import { en, ru, LOCALES, type LocaleKey, setLanguage, t } from "../src/i18n";

describe("locale completeness", () => {
	it("has the same set of keys in every locale", () => {
		for (const locale of LOCALES) {
			const dict = locale === "en" ? en : ru;
			expect(Object.keys(dict).sort()).toEqual(Object.keys(en).sort());
		}
	});

	it("resolves every key in every locale with a non-empty value", () => {
		for (const locale of LOCALES) {
			setLanguage(locale);
			for (const key of Object.keys(en) as LocaleKey[]) {
				expect(t(key), `${locale}/${key}`).toBeTypeOf("string");
				expect((t(key) ?? "").length, `${locale}/${key}`).toBeGreaterThan(0);
			}
		}
	});
});
