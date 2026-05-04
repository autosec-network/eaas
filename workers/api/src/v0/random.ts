import { createRoute, OpenAPIHono, z } from '@hono/zod-openapi';
import { endTime, startTime } from 'hono/timing';
import { Buffer } from 'node:buffer';
import { randomBytes } from 'node:crypto';
import type { ContextVariables, EnvVars } from '~/types';
import { APITags } from '~/v0/extras';

const app = new OpenAPIHono<{ Bindings: EnvVars; Variables: ContextVariables }>();

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
					schema: z.object({
						bytes: z
							.int()
							.positive()
							/**
							 * Max byte size = max uint8array (64k)
							 */
							.lte(0x10000)
							.describe('Specifies the number of bytes to return')
							.openapi({ example: example.byteLength }),
						format: z.enum(['hex', 'base64', 'base64url', 'raw']).describe('Specifies the output encoding'),
						source: z.enum(['lavarand', 'platform', 'all']).default('lavarand').describe("Specifies the source of the requested bytes. `lavarand`, the default, sources from Cloudflare's physical sources of entropy. `platform` sources bytes from the platform's entropy source. `all` mixes bytes from all available sources."),
						sink: z.boolean().default(false).describe('When true, continuously streams random bytes in chunks of the specified `bytes` size until the client disconnects. Uses `application/octet-stream` for `raw` format, or `text/plain` with each line containing a formatted chunk.'),
					}),
				},
			},
		},
	},
	responses: {
		200: {
			content: {
				'application/json': {
					schema: z.union([
						z.object({
							success: z.boolean(),
							result: z.union([
								z
									.hex()
									.trim()
									.openapi({ example: Buffer.from(example).toString('hex') }),
								z
									.base64()
									.trim()
									.openapi({ example: Buffer.from(example).toString('base64') }),
								z
									.base64url()
									.trim()
									.openapi({ example: Buffer.from(example).toString('base64url') }),
							]),
						}),
					]),
				},
				'application/octet-stream': {
					schema: z.string().openapi({ format: 'binary' }),
				},
				'text/plain': {
					schema: z.string().openapi({ description: 'Streaming text output of formatted random bytes, one chunk per line' }),
				},
			},
			description: 'Returns high-quality random bytes',
		},
	},
});

app.openapi(route, async (c) => {
	const { bytes: byteSize, format, source, sink } = c.req.valid('json');

	const generateBytes = async (timing: boolean): Promise<Uint8Array> => {
		if (source === 'lavarand') {
			return crypto.getRandomValues(new Uint8Array(byteSize));
		} else if (source === 'platform') {
			if (timing) startTime(c, 'random-platform-generate');
			const buf = randomBytes(byteSize);
			if (timing) endTime(c, 'random-platform-generate');

			return new Uint8Array(buf.buffer.slice(buf.byteOffset, buf.byteOffset + buf.byteLength));
		} else {
			// 'all' - combine lavarand + platform via HKDF
			const lava = crypto.getRandomValues(new Uint8Array(byteSize));

			if (timing) startTime(c, 'random-platform-generate');
			const plat = randomBytes(byteSize);
			if (timing) endTime(c, 'random-platform-generate');

			if (timing) startTime(c, 'random-platform-encode');
			const platArr = new Uint8Array(plat.buffer.slice(plat.byteOffset, plat.byteOffset + plat.byteLength));
			if (timing) endTime(c, 'random-platform-encode');

			if (timing) startTime(c, 'random-combine');
			/**
			 * Concatenate them
			 * temporary byte array is length of all of them combined
			 * @link https://jsbm.dev/lKeWPBqz3yYlz
			 */
			const combined = new Uint8Array(lava.byteLength + platArr.byteLength);
			combined.set(lava, 0);
			if (timing) startTime(c, 'random-combine-0');
			combined.set(platArr, lava.byteLength);
			if (timing) endTime(c, 'random-combine-0');
			if (timing) endTime(c, 'random-combine');

			if (timing) startTime(c, 'random-hkdf');

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

			const keyMaterial = await crypto.subtle.importKey('raw', combined, { name: 'HKDF' }, false, ['deriveBits']);

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

				if (timing) endTime(c, 'random-hkdf');

				return derivedKey;
			});
		}
	};

	if (sink) {
		if (format === 'raw') {
			return import('hono/streaming').then(({ stream }) =>
				stream(c, async (stream) => {
					c.header('Content-Type', 'application/octet-stream');
					while (!c.req.raw.signal.aborted) {
						await stream.write(await generateBytes(false));
					}
				}),
			);
		} else {
			return import('hono/streaming').then(({ streamText }) => {
				c.header('Content-Encoding', 'Identity');
				return streamText(c, async (stream) => {
					while (!c.req.raw.signal.aborted) {
						await stream.writeln(Buffer.from(await generateBytes(false)).toString(format));
					}
				});
			});
		}
	} else {
		const result = await generateBytes(true);

		if (format === 'raw') {
			c.header('Content-Type', 'application/octet-stream');
			return c.body(Buffer.from(result), 200);
		} else {
			return c.json({
				success: true,
				result: Buffer.from(result).toString(format),
			});
		}
	}
});

export default app;
