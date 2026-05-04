/** Convert a hex string (no hyphens) to hyphenated UUID format */
export function hexToUuid(h: string): string {
	return [h.slice(0, 8), h.slice(8, 12), h.slice(12, 16), h.slice(16, 20), h.slice(20)].join('-');
}

/** Get remaining init time as percentage (100 = full 30 days left, 0 = deadline reached) */
export function calcInitProgress(uidHex: string): number {
	const timestampMs = parseInt(uidHex.slice(0, 12), 16);
	const total = 30 * 24 * 60 * 60 * 1000;
	const remaining = timestampMs + total - Date.now();
	return Math.min(100, Math.max(0, Math.round((remaining / total) * 100)));
}

/** Get days remaining until 30-day init deadline from UUIDv7 hex timestamp */
export function calcInitDaysLeft(uidHex: string): number {
	const timestampMs = parseInt(uidHex.slice(0, 12), 16);
	const deadline = new Date(timestampMs + 30 * 24 * 60 * 60 * 1000);
	const remaining = deadline.getTime() - Date.now();
	return Math.max(0, Math.ceil(remaining / (24 * 60 * 60 * 1000)));
}
