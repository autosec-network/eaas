import type { TenantLogQueueMessageSchema } from 'types/tenants/logging';
import type * as zm from 'zod/mini';
import type { ContextVariables, EnvVars } from '~/types';

// Re-export Durable Objects since workerd can only find from wrangler's `main` file
export { BitwardenSession } from '~do/BitwardenSession';
export { TenantD0 } from '~do/TenantD0';
export { TenantD0Logs } from '~do/TenantD0Logs';
export { UserD0 } from '~do/UserD0';

// Re-export Workflows since workerd can only find from from `wrangler.jsonc`'s `main` file
export { DataKeyRotation } from '~wf/dataKeyRotation';

export default {
	async fetch(request, env, ctx) {
		const app = await import('hono').then(({ Hono }) => new Hono<{ Bindings: EnvVars; Variables: ContextVariables }>());

		// Variable Setup
		app.use('*', (c, next) =>
			import('hono/context-storage').then(({ contextStorage }) =>
				contextStorage()(
					// eslint-disable-next-line @typescript-eslint/no-unsafe-argument
					c,
					next,
				),
			),
		);
		app.use('*', async (c, next) => {
			// Browser cache
			const cacheControl = new Set((c.req.header('Cache-Control')?.split(',') ?? []).map((directive) => directive.trim().toLowerCase()));
			// RFC 7234: no-store forbids storing; no-cache/zero max-age require revalidation so we skip reads
			const toCache = cacheControl.has('no-store') || cacheControl.has('no-cache') || cacheControl.has('max-age=0') || cacheControl.has('s-maxage=0');
			const browserCache = !toCache;
			c.set('browserCache', browserCache);

			c.set(
				'a_db',
				await import('db/wae').then(async ({ drizzleAE }) =>
					drizzleAE(
						{ read: { accountId: c.env.CF_ACCOUNT_ID, apiKey: c.env.CF_API_TOKEN } },
						{
							// ...(c.env.NODE_ENV !== 'production' && { logger: await import('drizzle-orm/logger').then(async ({ DefaultLogger }) => new DefaultLogger({ writer: await import('db/core').then(({ DebugLogWriter }) => new DebugLogWriter('wae')) })) }),
							logger: await import('drizzle-orm/logger').then(async ({ DefaultLogger }) => new DefaultLogger({ writer: await import('db/core').then(({ DebugLogWriter }) => new DebugLogWriter('wae')) })),
							cache: await import('db/cache').then(
								({ SQLCache }) =>
									new SQLCache({
										dbName: 'workers',
										dbType: 'ae',
										strategy: browserCache ? 'all' : 'explicit',
										cacheTTL: parseInt(c.env.SQL_TTL, 10),
										logging: c.env.NODE_ENV !== 'production',
									}),
							),
						},
					),
				),
			);

			c.set(
				'r_db',
				await import('drizzle-orm/d1').then(async ({ drizzle }) =>
					drizzle(c.env.DB_ROOT.withSession('first-unconstrained') as unknown as D1Database, {
						// ...(c.env.NODE_ENV !== 'production' && { logger: await import('drizzle-orm/logger').then(async ({ DefaultLogger }) => new DefaultLogger({ writer: await import('db/core').then(({ DebugLogWriter, StaticDatabase }) => new DebugLogWriter(c.env.ENVIRONMENT === 'production' ? StaticDatabase.Root.eaas_root_prod : StaticDatabase.Root.eaas_root_dev)) })) }),
						logger: await import('drizzle-orm/logger').then(async ({ DefaultLogger }) => new DefaultLogger({ writer: await import('db/core').then(({ DebugLogWriter, StaticDatabase }) => new DebugLogWriter(c.env.ENVIRONMENT === 'production' ? StaticDatabase.Root.eaas_root_prod : StaticDatabase.Root.eaas_root_dev)) })),
						cache: await import('db/cache').then(
							async ({ SQLCache }) =>
								new SQLCache({
									dbName: await import('db/core').then(({ StaticDatabase }) => (c.env.ENVIRONMENT === 'production' ? StaticDatabase.Root.eaas_root_prod : StaticDatabase.Root.eaas_root_dev)),
									dbType: 'd1',
									strategy: browserCache ? 'all' : 'explicit',
									cacheTTL: parseInt(c.env.SQL_TTL, 10),
									logging: c.env.NODE_ENV !== 'production',
								}),
						),
					}),
				),
			);

			await next();
		});

		// Dev debug injection point
		app.use('*', async (c, next) => {
			if (c.env.NODE_ENV === 'development') {
				/* empty */
			}

			await next();
		});

		// Security
		app.use('*', (c, next) =>
			import('hono/cors').then(({ cors }) =>
				cors({
					origin: '*',
					maxAge: 300,
				})(
					// eslint-disable-next-line @typescript-eslint/no-unsafe-argument
					c,
					next,
				),
			),
		);
		app.use('*', (c, next) =>
			import('hono/method-not-allowed').then(({ methodNotAllowed }) =>
				methodNotAllowed({ app })(
					// eslint-disable-next-line @typescript-eslint/no-unsafe-argument
					c,
					next,
				),
			),
		);

		// Debug
		app.use('*', (c, next) =>
			import('hono/timing').then(({ timing }) =>
				timing()(
					// eslint-disable-next-line @typescript-eslint/no-unsafe-argument
					c,
					next,
				),
			),
		);
		app.use('*', async (c, next) => {
			if (c.env.NODE_ENV === 'development') {
				return import('hono/logger').then(({ logger }) =>
					logger()(
						// eslint-disable-next-line @typescript-eslint/no-unsafe-argument
						c,
						next,
					),
				);
			}

			await next();
		});

		await Promise.all([import('@hono/zod-validator'), import('zod/v4')]).then(([{ zValidator }, z4]) =>
			app.use(
				'/:version/*',
				zValidator(
					'param',
					z4.object({
						version: z4
							.string()
							.trim()
							.min(2)
							.regex(/^v\d+$/)
							.refine((version) => z4.coerce.number().int().nonnegative().safeParse(version.slice(1)).success),
					}),
					// @ts-expect-error we don't want to always return to all passthrough
					async (result, c) => {
						if (!result.success) {
							const { problemJsonValidation } = await import('~/errors');
							return problemJsonValidation(c, result.error, 404, "API version doesn't exist");
						}
					},
				),
			),
		);

		await import('~/base').then(({ default: baseApp }) => app.route('/', baseApp));

		return app.fetch(request, env, ctx);
	},
	async queue(batch, env, ctx) {
		return import('~/queue').then(({ main }) => main(batch, env, ctx));
	},
} as ExportedHandler<EnvVars, zm.input<typeof TenantLogQueueMessageSchema>>;
