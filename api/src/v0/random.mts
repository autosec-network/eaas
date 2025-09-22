import { createRoute, OpenAPIHono, z } from '@hono/zod-openapi';
import { endTime, startTime } from 'hono/timing';
import { Buffer } from 'node:buffer';
import { randomBytes } from 'node:crypto';
import type { ContextVariables, EnvVars } from '~/types.mjs';
import { APITags } from '~/v0/extras.mjs';

const app = await new OpenAPIHono<{ Bindings: EnvVars; Variables: ContextVariables }>();

const example = new Uint8Array(32);

export const route = createRoute({
	tags: [APITags.Free],
	method: 'post',
	path: '/',
	security: [],
	description: 'This endpoint returns high-quality random bytes of the specified length',
	request: {
		body: {
			content: {
				'application/json': {
					schema: z
						.object({
							bytes: z
								.number()
								.int()
								.positive()
								/**
								 * Max byte size = max uint8array (64k)
								 */
								.lte(0x10000)
								.describe('Specifies the number of bytes to return')
								.openapi({ example: example.byteLength }),
							format: z.enum(['hex', 'base64', 'base64url']).describe('Specifies the output encoding'),
							source: z.enum(['lavarand', 'platform', 'all']).default('lavarand').describe("Specifies the source of the requested bytes. `lavarand`, the default, sources from Cloudflare's physical sources of entropy. `platform` sources bytes from the platform's entropy source. `all` mixes bytes from all available sources."),
						})
						.openapi('RandomInput'),
				},
			},
		},
	},
	responses: {
		200: {
			content: {
				'application/json': {
					schema: z
						.object({
							success: z.boolean(),
							result: z.union([
								z
									.hex()
									.trim()
									.openapi({ example: Buffer.from(example).toString('hex') }),
								z
									.string()
									.trim()
									.base64()
									.openapi({ example: Buffer.from(example).toString('base64') }),
								z
									.string()
									.trim()
									.base64url()
									.openapi({ example: Buffer.from(example).toString('base64url') }),
							]),
						})
						.openapi('RandomOutput'),
				},
			},
			description: 'Returns high-quality random bytes',
		},
	},
});

app.openapi(route, async (c) => {
	const { bytes: byteSize, format, source } = c.req.valid('json');

	if (source === 'lavarand') {
		const lavarand = crypto.getRandomValues(new Uint8Array(byteSize));

		return c.json({
			success: true,
			result: Buffer.from(lavarand).toString(format),
		});
	} else if (source === 'platform') {
		startTime(c, 'random-platform-generate');
		const platform = randomBytes(byteSize);
		endTime(c, 'random-platform-generate');

		return c.json({
			success: true,
			result: Buffer.from(new Uint8Array(platform.buffer.slice(platform.byteOffset, platform.byteOffset + platform.byteLength))).toString(format),
		});
	} else {
		const randoms: Uint8Array[] = [];
		// Cloudflare LavaRand
		randoms.push(crypto.getRandomValues(new Uint8Array(byteSize)));

		// Node.JS platform
		startTime(c, 'random-platform-generate');
		const tempBuffer = randomBytes(byteSize);
		endTime(c, 'random-platform-generate');
		startTime(c, 'random-platform-encode');
		randoms.push(new Uint8Array(tempBuffer.buffer.slice(tempBuffer.byteOffset, tempBuffer.byteOffset + tempBuffer.byteLength)));
		endTime(c, 'random-platform-encode');

		startTime(c, 'random-combine');
		/**
		 * Concatenate them
		 * temporary byte arary is length of all of them combined
		 * @link https://jsbm.dev/lKeWPBqz3yYlz
		 */
		const combined = new Uint8Array(randoms.reduce((sum, str) => sum + str.byteLength, 0));
		// Insert each one into combined
		randoms.forEach((random, index) => {
			startTime(c, `random-combine-${index}`);
			combined.set(random, index * byteSize);
			endTime(c, `random-combine-${index}`);
		});
		endTime(c, 'random-combine');

		startTime(c, 'random-hkdf');
		// Use HKDF to derive down to the requested number of bytes
		return crypto.subtle
			.importKey('raw', combined, { name: 'HKDF' }, false, ['deriveBits'])
			.then((keyMaterial) => {
				/**
				 * Speed optimize
				 * sha256 = 32 bytes
				 * sha384 = 48 bytes
				 * sha512 = 64 bytes
				 */
				const hash = byteSize <= 32 ? 'SHA-256' : byteSize <= 48 ? 'SHA-384' : 'SHA-512';

				/**
				 * @link https://datatracker.ietf.org/doc/html/rfc5869#section-2.3
				 * Max byte size = 255 * HashLength
				 */
				const maxChunkSize = 255 * { 'SHA-256': 32, 'SHA-384': 48, 'SHA-512': 64 }[hash];
				const chunkCount = Math.ceil(byteSize / maxChunkSize);

				return Promise.all(
					Array.from({ length: chunkCount }, (_, i) => {
						const chunkSize = Math.min(maxChunkSize, byteSize - i * maxChunkSize);

						return crypto.subtle
							.deriveBits(
								{
									name: 'HKDF',
									hash,
									salt: crypto.getRandomValues(new Uint8Array(chunkSize)),
									info: new Uint8Array([i + 1]), // Ensure unique derivation per chunk
								},
								keyMaterial,
								chunkSize * 8, // Convert byte size to bits
							)
							.then((bits) => new Uint8Array(bits));
					}),
				).then((chunks) => {
					const derivedKey = new Uint8Array(byteSize);

					chunks.reduce((offset, chunk) => {
						derivedKey.set(chunk, offset);

						return offset + chunk.length;
					}, 0);

					return derivedKey;
				});
			})
			.then((combinedRandom) => {
				endTime(c, 'random-hkdf');

				return c.json({
					success: true,
					result: Buffer.from(combinedRandom).toString(format),
				});
			});
	}
});

export default app;
