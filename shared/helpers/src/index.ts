import type { UUID } from 'node:crypto';
import { ApiKeyVersions } from 'types/bw';
import { v7 as uuidv7 } from 'uuid';
import * as zm from 'zod/mini';

export function hexToUuid(hex: string): UUID {
	return `${hex.slice(0, 8)}-${hex.slice(8, 12)}-${hex.slice(12, 16)}-${hex.slice(16, 20)}-${hex.slice(20, 32)}`;
}

export async function createApiKey(_existingAk_id_hex?: string) {
	const existingAk_id_hex = await zm
		.optional(
			zm.hex().check(
				zm.trim(),
				zm.length(32),
				zm.refine(
					(hex) =>
						zm
							.uuidv7()
							.check(zm.trim(), zm.toLowerCase())
							.safeParseAsync(hexToUuid(hex))
							.then(({ success }) => success),
					'Invalid API key id hex value',
				),
			),
		)
		.parseAsync(_existingAk_id_hex);

	const { ak_id_hex, ak_secret_buffer, ak_secret_hash_hex } = await import('node:crypto').then(({ randomBytes, createHash }) => {
		const ak_secret_buffer = randomBytes(512 / 8);

		return {
			ak_id_hex:
				existingAk_id_hex ??
				(
					uuidv7({
						random: (() => {
							const mainBuffer = randomBytes(16);
							return new Uint8Array(mainBuffer.buffer.slice(mainBuffer.byteOffset, mainBuffer.byteOffset + mainBuffer.byteLength));
						})(),
					}) as UUID
				).replaceAll('-', ''),
			ak_secret_buffer,
			ak_secret_hash_hex: createHash('sha512').update(ak_secret_buffer).digest('hex'),
		};
	});

	const ak_id = {
		hex: ak_id_hex,
		base64url: await import('node:buffer').then(({ Buffer }) => Buffer.from(ak_id_hex, 'hex').toString('base64url')),
	} as const;

	return {
		ak_id,
		token: [ApiKeyVersions['512base64urlSha512'], ak_id.base64url, ak_secret_buffer.toString('base64url')].join('.'),
		ak_secret_hash: {
			hex: ak_secret_hash_hex,
		},
	} as const;
}
