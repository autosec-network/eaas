import { createRoute, OpenAPIHono, z } from '@hono/zod-openapi';
import type { ContextVariables, EnvVars } from '~/types.mjs';

const app = new OpenAPIHono<{ Bindings: EnvVars; Variables: ContextVariables }>();

const example = new Uint8Array(32);

export const route = await Promise.all([import('validator/es/lib/isHexadecimal'), import('node:buffer')]).then(([{ default: isHexadecimal }, { Buffer }]) =>
	createRoute({
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
								bytes: z.number().int().positive().finite().safe().describe('Specifies the number of bytes to return').openapi({ example: example.byteLength }),
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
										.string()
										.trim()
										.refine((value) => isHexadecimal(value))
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
	}),
);

app.openapi(route, async (c) => {
	const { bytes: byteSize, format, source } = c.req.valid('json');

	if (source === 'lavarand') {
		await import('hono/timing').then(({ startTime }) => startTime(c, 'random-lavarand-generate'));
		const lavarand = crypto.getRandomValues(new Uint8Array(byteSize));
		await import('hono/timing').then(({ endTime, startTime }) => {
			endTime(c, 'random-lavarand-generate');
			startTime(c, 'random-lavarand-encode');
		});
		return import('node:buffer')
			.then(({ Buffer }) => Buffer.from(lavarand).toString(format))
			.then(async (result) => {
				await import('hono/timing').then(({ endTime }) => endTime(c, 'random-lavarand-encode'));

				return c.json({
					success: true,
					result,
				});
			});
	} else if (source === 'platform') {
		await import('hono/timing').then(({ startTime }) => startTime(c, 'random-platform-generate'));
		return import('node:crypto')
			.then(({ randomBytes }) => randomBytes(byteSize))
			.then(async (platform) => {
				await import('hono/timing').then(({ endTime, startTime }) => {
					endTime(c, 'random-platform-generate');
					startTime(c, 'random-platform-encode');
				});

				return import('node:buffer')
					.then(({ Buffer }) => Buffer.from(new Uint8Array(platform.buffer.slice(platform.byteOffset, platform.byteOffset + platform.byteLength))).toString(format))
					.then(async (result) => {
						await import('hono/timing').then(({ endTime }) => endTime(c, 'random-platform-encode'));

						return c.json({
							success: true,
							result,
						});
					});
			});
	} else {
		const randoms: Uint8Array[] = [];
		// Cloudflare LavaRand
		await import('hono/timing').then(({ startTime }) => startTime(c, 'random-lavarand-generate'));
		randoms.push(crypto.getRandomValues(new Uint8Array(byteSize)));
		await import('hono/timing').then(({ endTime }) => endTime(c, 'random-lavarand-generate'));

		// Node.JS platform
		await import('hono/timing').then(({ startTime }) => startTime(c, 'random-platform-encode'));
		const tempBuffer = await import('node:crypto').then(({ randomBytes }) => randomBytes(byteSize));
		await import('hono/timing').then(({ endTime, startTime }) => {
			endTime(c, 'random-platform-generate');
			startTime(c, 'random-platform-encode');
		});
		randoms.push(new Uint8Array(tempBuffer.buffer.slice(tempBuffer.byteOffset, tempBuffer.byteOffset + tempBuffer.byteLength)));
		await import('hono/timing').then(({ endTime }) => endTime(c, 'random-platform-encode'));

		await import('hono/timing').then(({ startTime }) => startTime(c, 'random-combine'));
		/**
		 * Concatenate them
		 * temporary byte arary is length of all of them combined
		 * @link https://jsbm.dev/lKeWPBqz3yYlz
		 */
		const combined = new Uint8Array(randoms.reduce((sum, str) => sum + str.byteLength, 0));
		// Insert each one into combined
		randoms.forEach(async (random, index) => {
			await import('hono/timing').then(({ startTime }) => startTime(c, `random-combine-${index}`));
			combined.set(random, index * byteSize);
			await import('hono/timing').then(({ endTime }) => endTime(c, `random-combine-${index}`));
		});
		await import('hono/timing').then(({ endTime }) => endTime(c, 'random-combine'));

		await import('hono/timing').then(({ startTime }) => startTime(c, 'random-hkdf'));
		// Use HKDF to derive down to the requested number of bytes
		return crypto.subtle
			.importKey('raw', combined, { name: 'HKDF' }, false, ['deriveBits'])
			.then((keyMaterial) =>
				crypto.subtle
					.deriveBits(
						{
							name: 'HKDF',
							/**
							 * Speed optimize
							 * sha256 = 32 bytes
							 * sha384 = 48 bytes
							 * sha512 = 64 bytes
							 */
							hash: byteSize <= 32 ? 'SHA-256' : byteSize <= 48 ? 'SHA-384' : 'SHA-512',
							// Salt must be the same length as the output length
							salt: crypto.getRandomValues(new Uint8Array(byteSize)),
							// This property is required but may be an empty buffer
							info: new Uint8Array(),
						},
						keyMaterial,
						// Convert byte length to bits
						byteSize * 8,
					)
					.then((derivedBits) => new Uint8Array(derivedBits)),
			)
			.then(async (combinedRandom) => {
				await import('hono/timing').then(({ endTime, startTime }) => {
					endTime(c, 'random-hkdf');
					startTime(c, 'random-combine-encode');
				});

				return import('node:buffer')
					.then(({ Buffer }) => Buffer.from(combinedRandom).toString(format))
					.then(async (result) => {
						await import('hono/timing').then(({ endTime }) => endTime(c, 'random-combine-encode'));

						return c.json({
							success: true,
							result,
						});
					});
			});
	}
});

export default app;
