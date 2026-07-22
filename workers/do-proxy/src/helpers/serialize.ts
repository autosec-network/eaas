/**
 * Wire (de)serialization for the customer ↔ `do-proxy` hop.
 *
 * That hop is a `remote: true` service binding in local dev, whose transport can't serialize every structured-cloneable value the Durable Object methods use (notably `ArrayBuffer`, and `Date`) — it throws `"Cannot serialize value: [object ArrayBuffer]"`. So the customer converts method arguments to a JSON-safe wire form before the RPC and back afterwards, and each proxy entrypoint does the inverse before/after touching the real Durable Object (whose own cross-worker RPC structured-clones those types natively). The two sides must use this same pair symmetrically.
 *
 * Only plain objects and arrays are recursed into; class instances and other exotic values are passed through untouched.
 */

const ARRAY_BUFFER_TAG = '$$do-proxy:ArrayBuffer';
const DATE_TAG = '$$do-proxy:Date';

function isPlainObject(value: object): boolean {
	const proto = Object.getPrototypeOf(value) as object | null;
	return proto === Object.prototype || proto === null;
}

/**
 * Convert a value into a JSON-safe wire form: `ArrayBuffer` → tagged byte array, `Date` → tagged ISO string, recursing through plain objects and arrays.
 */
export function toWire(value: unknown): unknown {
	if (value instanceof ArrayBuffer) return { [ARRAY_BUFFER_TAG]: Array.from(new Uint8Array(value)) };
	if (value instanceof Date) return { [DATE_TAG]: value.toISOString() };
	if (Array.isArray(value)) return value.map(toWire);
	if (value !== null && typeof value === 'object' && isPlainObject(value)) {
		return Object.fromEntries(Object.entries(value).map(([key, v]) => [key, toWire(v)]));
	}
	return value;
}

/**
 * Inverse of {@link toWire}: reconstruct `ArrayBuffer`/`Date` from their tagged wire forms, recursing through plain objects and arrays.
 */
export function fromWire(value: unknown): unknown {
	if (Array.isArray(value)) return value.map(fromWire);
	if (value !== null && typeof value === 'object') {
		if (ARRAY_BUFFER_TAG in value) return new Uint8Array((value as Record<typeof ARRAY_BUFFER_TAG, number[]>)[ARRAY_BUFFER_TAG]).buffer;
		if (DATE_TAG in value) return new Date((value as Record<typeof DATE_TAG, string>)[DATE_TAG]);
		if (isPlainObject(value)) return Object.fromEntries(Object.entries(value).map(([key, v]) => [key, fromWire(v)]));
	}
	return value;
}
