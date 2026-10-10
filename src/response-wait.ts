// Shared normalization for the setting UI and the request boundary.
export function parseResponseWait(raw: string = ""):
	| { valid: false }
	| { valid: true; value: string; seconds?: number } {
	const value = raw.trim();
	if (value === "") return { valid: true, value };
	const seconds = Number(value);
	if (!/^\d+$/.test(value) || !Number.isSafeInteger(seconds) || seconds <= 0) return { valid: false };
	return { valid: true, value, seconds };
}
