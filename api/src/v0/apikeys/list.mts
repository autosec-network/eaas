import type { ContextVariables, EnvVars } from '~/types.mjs';

const app = await import('@hono/zod-openapi').then(({ OpenAPIHono }) => new OpenAPIHono<{ Bindings: EnvVars; Variables: ContextVariables }>());

app.use('*', (c, next) =>
	Promise.all([import('hono/bearer-auth'), import('node:crypto')]).then(([{ bearerAuth }, { createHash }]) =>
		bearerAuth({
			/**
			 * Use sha512 (default uses sha256)
			 * Use node crypto for optimization
			 */
			hashFunction: (data: string) => createHash('sha512').update(data).digest('hex'),
			verifyToken: (token, c) => {
				console.debug('called');

				return import('~/base.mjs').then(({ verifyToken }) => verifyToken(token, c, false));
			},
		})(c, next),
	),
);

export const route = await Promise.all([import('@hono/zod-openapi'), import('~/v0/keyrings/shared.mjs')]).then(([{ createRoute, z }, { keyringOutput }]) =>
	createRoute({
		tags: ['apikey management'],
		method: 'get',
		path: '/',
		description: 'Get a list of Api Keys.',
		request: {},
		responses: {
			200: {
				content: {
					'application/json': {
						schema: z.array(keyringOutput),
					},
				},
				description: 'Depending on key permissions, list all api keys, or fallback to itself.',
			},
		},
	}),
);

app.openapi(route, async (c) => {
	console.debug(c.var.globalPermissions);

	return c.json({});
});

export default app;
