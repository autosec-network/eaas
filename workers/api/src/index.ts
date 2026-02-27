import { WorkerEntrypoint } from 'cloudflare:workers';
import type { ContextVariables, EnvVars } from '~/types.mjs';

// Re-export Durable Objects since workerd can only find from wrangler's `main` file
export { BitwardenSession } from '~do/BitwardenSession.mjs';
export { TenantD0 } from '~do/TenantD0/index.mjs';

export default class extends WorkerEntrypoint<EnvVars> {
	override async fetch(request: Request) {
		const app = await import('hono').then(({ Hono }) => new Hono<{ Bindings: EnvVars; Variables: ContextVariables }>());

		// Variable Setup
		app.use('*', (c, next) => import('hono/context-storage').then(({ contextStorage }) => contextStorage()(c, next)));
		app.use('*', async (c, next) => {
			c.set(
				'r_db',
				await import('drizzle-orm/d1').then(async ({ drizzle }) =>
					drizzle(c.env.DB_ROOT.withSession('first-unconstrained') as unknown as D1Database, {
						...(c.env.NODE_ENV !== 'production' && { logger: await import('drizzle-orm/logger').then(async ({ DefaultLogger }) => new DefaultLogger({ writer: await import('db').then(({ DebugLogWriter, StaticDatabase }) => new DebugLogWriter(c.env.ENVIRONMENT === 'production' ? StaticDatabase.Root.eaas_root_prod : StaticDatabase.Root.eaas_root_dev)) })) }),
						schema: await import('db/schemas/root'),
						casing: 'snake_case',
					}),
				),
			);

			await next();
		});

		// Dev debug injection point
		app.use('*', async (c, next) => {
			if (c.env.NODE_ENV === 'development') {
			}

			await next();
		});

		// Security
		app.use('*', (c, next) =>
			import('hono/cors').then(({ cors }) =>
				cors({
					origin: '*',
					maxAge: 300,
				})(c, next),
			),
		);

		// Debug
		app.use('*', (c, next) => import('hono/timing').then(({ timing }) => timing()(c, next)));
		app.use('*', async (c, next) => {
			if (c.env.NODE_ENV === 'development') {
				return import('hono/logger').then(({ logger }) => logger()(c, next));
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
					(result, c) => {
						if (!result.success) {
							return c.json({ success: false, errors: [{ message: "API version doesn't exist" }] }, 404);
						}
					},
				),
			),
		);

		await import('~/base.mjs').then(({ default: baseApp }) => app.route('/', baseApp));

		return app.fetch(request, this.env, this.ctx);
	}
}
