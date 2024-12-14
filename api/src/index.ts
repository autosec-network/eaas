import { WorkerEntrypoint } from 'cloudflare:workers';
import { Hono } from 'hono';
import { bodyLimit } from 'hono/body-limit';
import { cors } from 'hono/cors';
import { csrf } from 'hono/csrf';
import { etag } from 'hono/etag';
import { timing, type TimingVariables } from 'hono/timing';
import type { EnvVars } from '~/types.mjs';
import api from '~/v1/index.mjs';

export default class extends WorkerEntrypoint<EnvVars> {
	override async fetch(request: Request) {
		const app = new Hono<{ Bindings: EnvVars; Variables: TimingVariables }>();

		// Dev debug injection point
		app.use('*', async (c, next) => {
			if (c.env.NODE_ENV === 'development') {
				return next();
			}
		});

		// Security
		app.use('*', csrf());
		// Allow only GET on documentation site
		// app.use('*/docs', cors({ origin: '*', allowMethods: ['GET', 'OPTIONS'], maxAge: 300 }));
		app.use(
			'*',
			cors({
				origin: '*',
				allowMethods: ['GET', 'OPTIONS'],
				maxAge: 300,
			}),
		);

		// Performance
		app.use('*', etag());
		/**
		 * Measured in kb
		 * Set to just worker memory limit
		 * @link https://developers.cloudflare.com/workers/platform/limits/#worker-limits
		 */
		app.use(
			'*',
			bodyLimit({
				maxSize: 100 * 1024,
				onError: (c) => c.json({ errors: [{ message: 'Content overflow', extensions: { code: 413 } }] }, 413),
			}),
		);

		// Debug
		app.use('*', timing());

		app.route('/v1', api);

		return app.fetch(request, this.env, this.ctx);
	}
}
