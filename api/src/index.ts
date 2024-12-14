import { zValidator } from '@hono/zod-validator';
import { WorkerEntrypoint } from 'cloudflare:workers';
import { Hono } from 'hono';
import { bodyLimit } from 'hono/body-limit';
import { cors } from 'hono/cors';
import { csrf } from 'hono/csrf';
import { etag } from 'hono/etag';
import { logger } from 'hono/logger';
import { timing, type TimingVariables } from 'hono/timing';
import { z } from 'zod';
import docs from '~/docs.mjs';
import type { EnvVars } from '~/types.mjs';
import api1 from '~/v1/index.mjs';

export default class extends WorkerEntrypoint<EnvVars> {
	override async fetch(request: Request) {
		const app = new Hono<{ Bindings: EnvVars; Variables: TimingVariables }>();

		// Dev debug injection point
		app.use('*', async (c, next) => {
			if (c.env.NODE_ENV === 'development') {
			}

			return next();
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
		app.use('*', async (c, next) => {
			if (c.env.NODE_ENV === 'development') {
				return logger()(c, next);
			}
		});

		app.use(
			'/:version/*',
			zValidator(
				'param',
				z.object({
					version: z
						.string()
						.min(2)
						.regex(/^v\d+$/)
						.refine((version) => z.coerce.number().int().positive().finite().safe().safeParse(version.slice(1)).success),
				}),
				// @ts-expect-error we don't want to always return to all passthrough
				(result, c) => {
					if (!result.success) {
						return c.json({ errors: [{ message: "API version doesn't exist", extensions: { code: 404 } }] }, 404);
					}
				},
			),
		);

		app.route('/:version/docs', docs);
		app.route('/v1', api1);

		return app.fetch(request, this.env, this.ctx);
	}
}
