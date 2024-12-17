import { zValidator } from '@hono/zod-validator';
import { WorkerEntrypoint } from 'cloudflare:workers';
import { Hono } from 'hono';
import { cors } from 'hono/cors';
import { csrf } from 'hono/csrf';
import { etag } from 'hono/etag';
import { logger } from 'hono/logger';
import { timing } from 'hono/timing';
import { z } from 'zod';
import baseApp from '~/base.mjs';
import docs from '~/docs.mjs';
import type { ContextVariables, EnvVars } from '~/types.mjs';
import { DBManager, StaticDatabase } from '~shared/db-core/db.mjs';
import { Helpers } from '~shared/helpers/index.mjs';

export default class extends WorkerEntrypoint<EnvVars> {
	override async fetch(request: Request) {
		const app = new Hono<{ Bindings: EnvVars; Variables: ContextVariables }>();

		// Dev debug injection point
		app.use('*', async (c, next) => {
			if (c.env.NODE_ENV === 'development') {
			}

			await next();
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

		// Debug
		app.use('*', timing());
		app.use('*', async (c, next) => {
			if (c.env.NODE_ENV === 'development') {
				return logger()(c, next);
			}

			await next();
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
						.refine((version) => z.coerce.number().int().nonnegative().finite().safe().safeParse(version.slice(1)).success),
				}),
				// @ts-expect-error we don't want to always return to all passthrough
				(result, c) => {
					if (!result.success) {
						return c.json({ success: false, errors: [{ message: "API version doesn't exist", extensions: { code: 404 } }] }, 404);
					}
				},
			),
		);

		// DB Setup
		app.use('*', async (c, next) => {
			if (Helpers.isLocal(c.env.CF_VERSION_METADATA)) {
				c.set(
					'r_db',
					DBManager.getDrizzle(
						{
							accountId: c.env.CF_ACCOUNT_ID,
							apiToken: c.env.CF_API_TOKEN,
							databaseId: c.env.ENVIRONMENT === 'production' ? StaticDatabase.Root.eaas_root : StaticDatabase.Root.eaas_root_p,
						},
						c.env.NODE_ENV !== 'production',
					),
				);
			} else {
				DBManager.getDrizzle(c.env.EAAS_ROOT, c.env.NODE_ENV !== 'production');
			}

			await next();
		});

		app.route('/:version/docs', docs);
		app.route('/', baseApp);

		return app.fetch(request, this.env, this.ctx);
	}
}
