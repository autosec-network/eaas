import { WorkerEntrypoint } from 'cloudflare:workers';
import type { ContextVariables, EnvVars } from '~/types.mjs';

export { PqcContainerSidecar } from '~pqc/do/index.mjs';
export { DataKeyRotation } from '../../wf/dataKeyRotation.mjs';

export default class extends WorkerEntrypoint<EnvVars> {
	override async fetch(request: Request) {
		const secondaryRequest = request.clone();
		const app = await import('hono').then(({ Hono }) => new Hono<{ Bindings: EnvVars; Variables: ContextVariables }>());

		// Dev debug injection point
		app.use('*', async (c, next) => {
			if (c.env.NODE_ENV === 'development') {
			}

			await next();
		});

		// Security
		app.use('*', (c, next) => import('hono/csrf').then(({ csrf }) => csrf()(c, next)));
		// Allow only GET on documentation site
		// app.use('*/docs', (c, next) =>
		// 	import('hono/cors').then(({ cors }) =>
		// 		cors({
		// 			origin: '*',
		// 			allowMethods: ['POST', 'OPTIONS'],
		// 			maxAge: 300,
		// 		})(c, next),
		// 	),
		// );
		app.use('*', (c, next) =>
			import('hono/cors').then(({ cors }) =>
				cors({
					origin: '*',
					allowMethods: ['GET', 'OPTIONS'],
					maxAge: 300,
				})(c, next),
			),
		);

		// Performance
		app.use('*', (c, next) => import('hono/etag').then(({ etag }) => etag()(c, next)));

		// Debug
		app.use('*', (c, next) => import('hono/timing').then(({ timing }) => timing()(c, next)));
		app.use('*', async (c, next) => {
			if (c.env.NODE_ENV === 'development') {
				return import('hono/logger').then(({ logger }) => logger()(c, next));
			}

			await next();
		});

		// Variable Setup
		app.use('*', async (c, next) => {
			c.set('bodyClone', secondaryRequest);

			await next();
		});
		app.use('*', async (c, next) =>
			Promise.all([import('~shared/helpers/index.mjs'), import('~shared/db-core/db.mjs')]).then(async ([{ Helpers }, { DBManager }]) => {
				if (Helpers.isLocal(c.env.CF_VERSION_METADATA)) {
					await import('~shared/db-core/db.mjs').then(({ StaticDatabase }) =>
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
						),
					);
				} else {
					c.set('r_db', DBManager.getDrizzle(c.env.EAAS_ROOT, c.env.NODE_ENV !== 'production'));
				}

				await next();
			}),
		);

		await Promise.all([import('@hono/zod-validator'), import('zod')]).then(([{ zValidator }, { z }]) =>
			app.use(
				'/:version/*',
				zValidator(
					'param',
					z.object({
						version: z
							.string()
							.trim()
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
			),
		);

		await import('@scalar/hono-api-reference').then(({ Scalar }) =>
			app.get('/:version/docs', (c, next) => {
				const pathSegments = c.req.path.split('/');

				return Scalar({
					url: [...pathSegments.splice(0, pathSegments.length - 1), 'openapi31'].join('/'),
					theme: 'bluePlanet',
				})(c, next);
			}),
		);
		await import('~/base.mjs').then(({ default: baseApp }) => app.route('/', baseApp));

		return app.fetch(request, this.env, this.ctx);
	}
}
