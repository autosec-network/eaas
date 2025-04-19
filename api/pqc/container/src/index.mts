import type { HttpBindings } from '@hono/node-server';
import { zValidator } from '@hono/zod-validator';
import { Hono } from 'hono';
import type { TimingVariables } from 'hono/timing';
import { z } from 'zod';

class HTTPResponder {
	private server = new Hono<{ Bindings: HttpBindings; Variables: TimingVariables }>();

	constructor() {
		// Performance
		this.server.use('*', (c, next) => import('hono/compress').then(({ compress }) => compress()(c, next)));
		this.server.use('*', (c, next) => import('hono/etag').then(({ etag }) => etag()(c, next)));

		// Debug
		this.server.use('*', (c, next) => import('hono/timing').then(({ timing }) => timing()(c, next)));

		this.server.get('/', (c) => {
			return c.text('Hello world');
		});

		this.server.post(
			'/encrypt/:algo',
			zValidator(
				'param',
				z.object({
					algo: z.string().trim().nonempty().toLowerCase(),
				}),
			),
			zValidator(
				'json',
				z.object({
					key: z.string().trim().nonempty().base64(),
					chaIv: z.string().trim().nonempty().base64(),
					plainText: z.string().trim().nonempty().base64(),
				}),
			),
			(c) =>
				Promise.all([import('node:crypto'), import('node:buffer')]).then(([{ createCipheriv }, { Buffer }]) => {
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
				}),
		);
	}

	public listen(port: number = 8080) {
		return Promise.all([import('@hono/node-server')]).then(([{ serve }]) =>
			serve(
				{
					fetch: this.server.fetch,
					port,
				},
				(info) => console.log(`Server running at http://${info.address}:${info.port}`),
			),
		);
	}
}

await new HTTPResponder().listen();
