import { serve, type HttpBindings } from '@hono/node-server';
import { zValidator } from '@hono/zod-validator';
import { Hono } from 'hono';
import { compress } from 'hono/compress';
import { etag } from 'hono/etag';
import { timing, type TimingVariables } from 'hono/timing';
import { Buffer } from 'node:buffer';
import { createCipheriv, createDecipheriv } from 'node:crypto';
import { z as z4 } from 'zod/v4';

const app = new Hono<{ Bindings: HttpBindings; Variables: TimingVariables }>();

// Performance
app.use('*', compress());
app.use('*', etag());

// Debug
app.use('*', timing());

app.get('/', (c) => {
	return c.text('Hello world');
});

const rawRoutes = app
	.post(
		'/encrypt/:algo',
		zValidator(
			'param',
			z4.object({
				algo: z4.string().trim().nonempty().toLowerCase(),
			}),
		),
		zValidator(
			'json',
			z4.object({
				key: z4.base64().trim().nonempty(),
				chaIv: z4.base64().trim().nonempty(),
				plainText: z4.base64().trim().nonempty(),
			}),
		),
		(c) => {
			const json = c.req.valid('json');
			const { key, chaIv, plainText } = json;

			const cipher = createCipheriv('chacha20-poly1305', Buffer.from(key, 'base64'), Buffer.from(chaIv, 'base64'));

			const cipherText = Buffer.concat([cipher.update(Buffer.from(plainText, 'base64')), cipher.final()]);
			const authTag = cipher.getAuthTag();

			c.header('Content-Type', 'application/octet-stream');
			c.status(200);
			return c.body(Buffer.concat([cipherText, authTag]));

			// return import('hono/streaming').then(({ stream }) =>
			// 	stream(c, async (stream) => {
			// 		// Write a process to be executed when aborted.
			// 		stream.onAbort(() => {
			// 			console.log('Aborted!');
			// 		});
			// 		// Write a Uint8Array.
			// 		await stream.write(new Uint8Array([0x48, 0x65, 0x6c, 0x6c, 0x6f]));
			// 		// Pipe a readable stream.
			// 		await stream.pipe(anotherReadableStream);
			// 	}),
			// );
		},
	)
	.post(
		'/decrypt/:algo',
		zValidator(
			'param',
			z4.object({
				algo: z4.string().trim().nonempty().toLowerCase(),
			}),
		),
		zValidator(
			'json',
			z4.object({
				key: z4.base64().trim().nonempty(),
				chaIv: z4.base64().trim().nonempty(),
				cipherText: z4.base64().trim().nonempty(),
			}),
		),
		(c) => {
			const json = c.req.valid('json');
			const { key, chaIv, cipherText } = json;

			const cipherBuffer = Buffer.from(cipherText, 'base64');

			// For ChaCha20-Poly1305, the auth tag is the last 16 bytes
			const authTagLength = 16;
			const actualCipherText = cipherBuffer.subarray(0, -authTagLength);
			const authTag = cipherBuffer.subarray(-authTagLength);

			const decipher = createDecipheriv('chacha20-poly1305', Buffer.from(key, 'base64'), Buffer.from(chaIv, 'base64'));
			decipher.setAuthTag(authTag);

			const plainText = Buffer.concat([decipher.update(actualCipherText), decipher.final()]);

			c.header('Content-Type', 'application/octet-stream');
			c.status(200);
			return c.body(plainText);
		},
	);

export type routes = typeof rawRoutes;

serve({ fetch: app.fetch, port: 8080 }, (info) => console.log(`Server running at http://${info.address}:${info.port}`));
