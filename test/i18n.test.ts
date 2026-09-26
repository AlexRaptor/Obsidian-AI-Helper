import { describe, expect, it, vi } from "vitest";
import { LOCALES, LOCALE_NAMES, setLanguage, getLanguage, t } from "../src/i18n";

const sampleKeys = ["view-title", "command", "ribbon"] as const;

describe("i18n", () => {
	it("declares exactly English (default) and Russian", () => {
		expect(LOCALES).toEqual(["en", "ru"]);
	});

	it("has a display name for every locale", () => {
		for (const locale of LOCALES) {
			expect(LOCALE_NAMES[locale]).toBeTypeOf("string");
			expect(LOCALE_NAMES[locale].length).toBeGreaterThan(0);
		}
	});

	it("resolves every key in English by default", () => {
		const spy = vi.spyOn(console, "warn");
		setLanguage("en");
		for (const key of sampleKeys) {
			expect(t(key)).toBeTypeOf("string");
			expect(t(key).length).toBeGreaterThan(0);
		}
		spy.mockRestore();
	});

	it("resolves every key in Russian", () => {
		setLanguage("ru");
		for (const key of sampleKeys) {
			expect(t(key)).toBeTypeOf("string");
			expect(t(key).length).toBeGreaterThan(0);
		}
	});

	it("switches the active language via setLanguage", () => {
		setLanguage("en");
		expect(getLanguage()).toBe("en");
		setLanguage("ru");
		expect(getLanguage()).toBe("ru");
	});
});
