import { Buffer } from 'node:buffer';
import { hexUuid4Regex, hexUuid7Regex, hexUuidRegex } from 'types/zod/mini';
import * as zm from 'zod/mini';
import { hexToUuid } from '../index.js';

export function ZodUuidUtf8(version?: 4 | 7) {
	return (version === 4 ? zm.uuidv4() : version === 7 ? zm.uuidv7() : zm.uuid()).check(zm.trim());
}
export function ZodUuidHex(version?: 4 | 7) {
	const hexRegex = version === 4 ? hexUuid4Regex : version === 7 ? hexUuid7Regex : hexUuidRegex;
	return zm.hex().check(zm.trim(), zm.length(32), zm.regex(hexRegex));
}
export function ZodUuidBase64(version?: 4 | 7) {
	const hexRegex = version === 4 ? hexUuid4Regex : version === 7 ? hexUuid7Regex : hexUuidRegex;
	return zm.base64().check(
		zm.trim(),
		zm.length(24),
		// eslint-disable-next-line zod-mini/require-error-message
		zm.refine((v) => hexRegex.test(Buffer.from(v, 'base64').toString('hex'))),
	);
}
export function ZodUuidBase64url(version?: 4 | 7) {
	const hexRegex = version === 4 ? hexUuid4Regex : version === 7 ? hexUuid7Regex : hexUuidRegex;
	return zm.base64url().check(
		zm.trim(),
		zm.length(22),
		// eslint-disable-next-line zod-mini/require-error-message
		zm.refine((v) => hexRegex.test(Buffer.from(v, 'base64url').toString('hex'))),
	);
}

export function ZodUuidInput(version?: 4 | 7) {
	return zm.union([ZodUuidUtf8(version), ZodUuidHex(version), ZodUuidBase64(version), ZodUuidBase64url(version)]);
}

export function ZodUuidInputConvertedSchema(version?: 4 | 7) {
	return zm.object({
		utf8: ZodUuidUtf8(version),
		hex: ZodUuidHex(version),
		base64: ZodUuidBase64(version),
		base64url: ZodUuidBase64url(version),
	});
}

export function ZodUuidInputConverted(version?: 4 | 7) {
	return zm.union([
		zm.codec(ZodUuidUtf8(version), ZodUuidInputConvertedSchema(version), {
			decode: (uuid) => {
				const hex = uuid.replaceAll('-', '');
				const buffer = Buffer.from(hex, 'hex');

				return {
					utf8: uuid,
					hex,
					base64: buffer.toString('base64'),
					base64url: buffer.toString('base64url'),
				};
			},
			encode: ({ utf8 }) => utf8,
		}),
		zm.codec(ZodUuidHex(version), ZodUuidInputConvertedSchema(version), {
			decode: (hex) => ({
				utf8: hexToUuid(hex),
				hex,
				base64: Buffer.from(hex, 'hex').toString('base64'),
				base64url: Buffer.from(hex, 'hex').toString('base64url'),
			}),
			encode: ({ hex }) => hex,
		}),
		zm.codec(ZodUuidBase64(version), ZodUuidInputConvertedSchema(version), {
			decode: (base64) => {
				const buffer = Buffer.from(base64, 'base64');
				const hex = buffer.toString('hex');

				return {
					utf8: hexToUuid(hex),
					hex,
					base64,
					base64url: buffer.toString('base64url'),
				};
			},
			encode: ({ base64 }) => base64,
		}),
		zm.codec(ZodUuidBase64url(version), ZodUuidInputConvertedSchema(version), {
			decode: (base64url) => {
				const buffer = Buffer.from(base64url, 'base64url');
				const hex = buffer.toString('hex');

				return {
					utf8: hexToUuid(hex),
					hex,
					base64: buffer.toString('base64'),
					base64url,
				};
			},
			encode: ({ base64url }) => base64url,
		}),
	]);
}
