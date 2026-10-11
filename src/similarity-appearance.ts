export const SIMILARITY_COLORS = ["red", "orange", "yellow", "green", "cyan", "blue", "purple", "pink"] as const;
export type SimilarityColor = typeof SIMILARITY_COLORS[number] | `#${string}`;
export interface SimilarityAppearance {
	weakUpper: number;
	mediumUpper: number;
	weakColor: SimilarityColor;
	mediumColor: SimilarityColor;
	strongColor: SimilarityColor;
}
export const DEFAULT_SIMILARITY_APPEARANCE: SimilarityAppearance = {
	weakUpper: 0.3, mediumUpper: 0.5,
	weakColor: "red", mediumColor: "orange", strongColor: "green",
};
export function validSimilarityBoundaries(weak: number, medium: number): boolean {
	return Number.isFinite(weak) && Number.isFinite(medium) && weak >= 0 && weak < medium && medium < 1;
}
export function isSimilarityColor(value: unknown): value is SimilarityColor {
	return SIMILARITY_COLORS.some((color) => color === value) || (typeof value === "string" && /^#[0-9a-f]{6}$/i.test(value));
}
export function normalizeSimilarityAppearance(value: unknown): SimilarityAppearance {
	const saved = value && typeof value === "object" ? value as Partial<SimilarityAppearance> : {};
	const result = { ...DEFAULT_SIMILARITY_APPEARANCE };
	if (typeof saved.weakUpper === "number" && typeof saved.mediumUpper === "number" && validSimilarityBoundaries(saved.weakUpper, saved.mediumUpper)) {
		result.weakUpper = saved.weakUpper; result.mediumUpper = saved.mediumUpper;
	}
	for (const key of ["weakColor", "mediumColor", "strongColor"] as const) {
		const color = saved[key];
		if (isSimilarityColor(color)) result[key] = color;
	}
	return result;
}
export function similarityColor(similarity: number, appearance: SimilarityAppearance): string {
	const color = similarity <= appearance.weakUpper ? appearance.weakColor
		: similarity <= appearance.mediumUpper ? appearance.mediumColor : appearance.strongColor;
	return color.startsWith("#") ? color : `var(--color-${color})`;
}
