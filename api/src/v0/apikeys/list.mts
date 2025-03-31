import type { ContextVariables, EnvVars } from '~/types.mjs';

const app = await import('@hono/zod-openapi').then(({ OpenAPIHono }) => new OpenAPIHono<{ Bindings: EnvVars; Variables: ContextVariables }>());

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
