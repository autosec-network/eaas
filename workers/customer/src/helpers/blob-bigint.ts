import type { Buffer } from 'node:buffer';

/**
 * `keyrings.count_rotation` and `datakeys.generation_count` are big-endian blobs standing in for bigints, because drizzle's native bigint is broken for SQLite.
 *
 * @link https://github.com/drizzle-team/drizzle-orm/issues/2902
 * @link https://github.com/drizzle-team/drizzle-orm/issues/3609
 */
export function blobToBigInt(blob: Buffer | null | undefined): bigint | null {
	if (!blob) return null;
	// `BigInt('0x')` throws rather than returning 0n, so a zero-length blob has to be caught before the parse
	return blob.byteLength === 0 ? BigInt(0) : BigInt(`0x${blob.toString('hex')}`);
}

/**
 * The inverse, as the hex `unhex()` expects. SQLite's `unhex()` rejects an odd-length string, so the digits are left-padded to a whole number of bytes.
 */
export function bigIntToHex(value: bigint): string {
	const hex = value.toString(16);
	return hex.length % 2 === 0 ? hex : `0${hex}`;
}

/**
 * A bigint as a decimal string, which is how these values cross to the browser - `JSON.stringify` refuses a `BigInt`, and Qwik serializes loader output as JSON.
 */
export function blobToDecimalString(blob: Buffer | null | undefined): string | null {
	const value = blobToBigInt(blob);
	return value === null ? null : value.toString(10);
}
