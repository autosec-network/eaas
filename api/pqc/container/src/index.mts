import type { Http2Bindings } from '@hono/node-server';
import { Hono } from 'hono';
import type { TimingVariables } from 'hono/timing';

class HTTPResponder {
	private server = new Hono<{ Bindings: Http2Bindings; Variables: TimingVariables }>();

	constructor() {
		// Performance
		this.server.use('*', (c, next) => import('hono/compress').then(({ compress }) => compress()(c, next)));
		this.server.use('*', (c, next) => import('hono/etag').then(({ etag }) => etag()(c, next)));

		// Debug
		this.server.use('*', (c, next) => import('hono/timing').then(({ timing }) => timing()(c, next)));
	}

	public listen(port: number = 8080) {
		return Promise.all([import('@hono/node-server'), import('node:http2')]).then(([{ serve }, { createServer }]) =>
			serve(
				{
					fetch: this.server.fetch,
					port,
					createServer,
				},
				(info) => console.log(`Server running at http://${info.address}:${info.port}`),
			),
		);
	}
}

await new HTTPResponder().listen();
