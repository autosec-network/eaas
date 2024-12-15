import { createRoute, OpenAPIHono, z } from '@hono/zod-openapi';
import { randomBytes } from 'node:crypto';
import isHexadecimal from 'validator/es/lib/isHexadecimal';
import type { ContextVariables, EnvVars } from '~/types.mjs';

const app = new OpenAPIHono<{ Bindings: EnvVars; Variables: ContextVariables }>();

const example = new Uint8Array(32);

export const route = createRoute({
	method: 'post',
	path: '/',
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
									.refine((value) => isHexadecimal(value))
									.openapi({ example: Buffer.from(example).toString('hex') }),
								z
									.string()
									.base64()
									.openapi({ example: Buffer.from(example).toString('base64') }),
								z
									.string()
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

app.openapi(route, (c) => {
	const { bytes: byteSize, format, source } = c.req.valid('json');

	if (source === 'lavarand') {
		return c.json({
			success: true,
			result: Buffer.from(crypto.getRandomValues(new Uint8Array(byteSize))).toString(format),
		});
	} else if (source === 'platform') {
		const tempBuffer = randomBytes(byteSize);

		return c.json({
			success: true,
			result: Buffer.from(new Uint8Array(tempBuffer.buffer.slice(tempBuffer.byteOffset, tempBuffer.byteOffset + tempBuffer.byteLength))).toString(format),
		});
	} else {
		const randoms: Uint8Array[] = [];
		// Cloudflare LavaRand
		randoms.push(crypto.getRandomValues(new Uint8Array(byteSize)));

		// Node.JS platform
		const tempBuffer = randomBytes(byteSize);
		randoms.push(new Uint8Array(tempBuffer.buffer.slice(tempBuffer.byteOffset, tempBuffer.byteOffset + tempBuffer.byteLength)));

		/**
		 * Concatenate them
		 * temporary byte arary is length of all of them combined
		 * @link https://jsbm.dev/lKeWPBqz3yYlz
		 */
		const combined = new Uint8Array(randoms.reduce((sum, str) => sum + str.byteLength, 0));
		// Insert each one into combined
		randoms.forEach((random, index) => combined.set(random, index * byteSize));

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
			.then((combinedRandom) =>
				c.json({
					success: true,
					result: Buffer.from(combinedRandom).toString(format),
				}),
			);
	}
});

export default app;
