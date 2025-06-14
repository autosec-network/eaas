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

			// Initialize unified error handling
			const errors: Array<{ code?: number; message: string; cause?: string }> = [];
			c.set('errors', errors);
			c.set('addError', (error: { code?: number; message: string; cause?: string }) => {
				errors.push(error);
			});
			c.set('addErrors', (newErrors: Array<{ code?: number; message: string; cause?: string }>) => {
				errors.push(...newErrors);
			});
			c.set('hasErrors', () => errors.length > 0);
			c.set('getUnifiedResponse', <T>(response?: T) => ({
				success: errors.length === 0,
				errors,
				...(response !== undefined && { response }),
			}));

			c.set('r_db_session', c.env.EAAS_ROOT.withSession('first-unconstrained'));
			await Promise.all([import('@chainfuse/helpers/common'), import('~shared/db-core/db.mjs')]).then(async ([{ Helpers }, { DBManager }]) => {
				if (Helpers.isLocal(c.env.CF_VERSION_METADATA)) {
					await import('~shared/db-core/db.mjs').then(({ StaticDatabase }) =>
						c.set('r_db', () =>
							DBManager.getDrizzle(
								{
									accountId: c.env.CF_ACCOUNT_ID,
									apiToken: c.env.CF_API_TOKEN,
									databaseId: c.env.ENVIRONMENT === 'production' ? StaticDatabase.Root.eaas_root : StaticDatabase.Root.eaas_root_p,
								},
								{
									logger: c.env.NODE_ENV !== 'production',
								},
							),
						),
					);
				} else {
					c.set('r_db', () => DBManager.getDrizzle(c.env.EAAS_ROOT.withSession(c.var.r_db_session.getBookmark() ?? 'first-unconstrained'), { logger: c.env.NODE_ENV !== 'production' }));
				}
			});

			await next();
		});

		// Global error handling middleware
		app.use('*', async (c, next) => {
			try {
				await next();
			} catch (error) {
				console.error('Unhandled error in middleware chain:', error);
				c.var.addError({
					code: 500,
					message: error instanceof Error ? error.message : 'Internal server error',
					cause: error instanceof Error ? error.cause?.toString() : undefined,
				});

				return c.json(c.var.getUnifiedResponse(), 500 as any);
			}
		});

		// Response formatter middleware - ensures all responses follow unified format
		app.use('*', async (c, next) => {
			await next();

			// If response hasn't been set yet and we have errors, return unified error response
			if (c.var.hasErrors() && !c.res.body) {
				const statusCode = c.var.errors.some((e) => e.code && e.code >= 400) ? Math.max(...c.var.errors.filter((e) => e.code).map((e) => e.code!)) : 400;
				return c.json(c.var.getUnifiedResponse(), statusCode as any);
			}
		});

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
							return c.json({ success: false, errors: [{ message: "API version doesn't exist" }] }, 404);
						}
					},
				),
			),
		);

		await import('~/base.mjs').then(({ default: baseApp }) => app.route('/', baseApp));

		// Response transformation middleware - converts all responses to unified format
		app.use('*', async (c, next) => {
			await next();

			// Only transform if we have a response and it's JSON
			if (c.res.headers.get('Content-Type')?.includes('application/json')) {
				try {
					const responseBody = await c.res.clone().json();

					// Check if response is already in unified format
					if (typeof responseBody === 'object' && responseBody !== null && 'success' in responseBody && 'errors' in responseBody) {
						// Already in unified format, but merge with context errors if any
						if (c.var.hasErrors()) {
							const contextErrors = c.var.errors;
							const existingErrors = Array.isArray((responseBody as any).errors) ? (responseBody as any).errors : [];
							const mergedErrors = [...existingErrors, ...contextErrors];

							const unifiedResponse = {
								success: mergedErrors.length === 0 && (responseBody as any).success,
								errors: mergedErrors,
								...((responseBody as any).response !== undefined && { response: (responseBody as any).response }),
								// Include any other properties from the original response
								...Object.fromEntries(Object.entries(responseBody).filter(([key]) => !['success', 'errors', 'response'].includes(key))),
							};

							const newResponse = new Response(JSON.stringify(unifiedResponse), {
								status: c.res.status,
								headers: c.res.headers,
							});

							c.res = newResponse;
						}
						return;
					}

					// Check if response has success field but not unified format (e.g., { success: true, result: ... })
					if (typeof responseBody === 'object' && responseBody !== null && 'success' in responseBody && !('errors' in responseBody)) {
						const hasErrors = c.var.hasErrors();
						const errors = c.var.errors;

						// Extract the success value and other data
						const { success: responseSuccess, ...otherData } = responseBody as any;
						const isSuccess = responseSuccess && !hasErrors;

						const unifiedResponse = {
							success: isSuccess,
							errors: hasErrors ? errors : [],
							...(isSuccess && Object.keys(otherData).length > 0 && { response: otherData }),
						};

						const newResponse = new Response(JSON.stringify(unifiedResponse), {
							status: c.res.status,
							headers: c.res.headers,
						});

						c.res = newResponse;
						return;
					}

					// Transform non-unified response to unified format
					const hasErrors = c.var.hasErrors();
					const errors = c.var.errors;

					// Determine if this is a success or error response based on status code
					const isSuccess = c.res.status >= 200 && c.res.status < 300 && !hasErrors;

					const unifiedResponse = {
						success: isSuccess,
						errors: hasErrors ? errors : [],
						...(isSuccess && responseBody !== null && { response: responseBody }),
					};

					const newResponse = new Response(JSON.stringify(unifiedResponse), {
						status: c.res.status,
						headers: c.res.headers,
					});

					c.res = newResponse;
				} catch (error) {
					// If response parsing fails, create an error response
					console.error('Failed to parse response for transformation:', error);
					c.var.addError({
						code: 500,
						message: 'Response transformation failed',
						cause: error instanceof Error ? error.message : 'Unknown error',
					});

					const errorResponse = c.var.getUnifiedResponse();
					const newResponse = new Response(JSON.stringify(errorResponse), {
						status: 500,
						headers: { 'Content-Type': 'application/json' },
					});

					c.res = newResponse;
				}
			}
		});

		return app.fetch(request, this.env, this.ctx);
	}
}
