import type { z } from '@hono/zod-openapi';
import type { ContextVariables, EnvVars } from '~/types.mjs';
import type { keyringOutput } from '~/v0/keyrings/shared.mjs';

const app = await import('@hono/zod-openapi').then(({ OpenAPIHono }) => new OpenAPIHono<{ Bindings: EnvVars; Variables: ContextVariables }>());

app.use('*', async (c, next) => {
	/**
	 * Check if at least one permission has r_encrypt set to true.
	 * We have to check specifics in the route handler to get the keyring name from fields.
	 */
	if (c.var.globalPermissions.r_keyrings >= 2) {
		await next();
	} else {
		console.error("Token doesn't have permissions");
		return c.json({ success: false, errors: [{ message: 'Access Denied: You do not have permission to perform this action', extensions: { code: 403 } }] }, 403);
	}
});

export const route = await Promise.all([import('@hono/zod-openapi'), import('~/v0/keyrings/shared.mjs')]).then(([{ createRoute }, { keyringEditable, keyringOutput }]) =>
	createRoute({
		tags: ['keyring management'],
		method: 'post',
		path: '/',
		description: 'Create a new keyring.',
		request: {
			body: {
				content: {
					'application/json': {
						schema: keyringEditable,
					},
				},
			},
		},
		responses: {
			200: {
				content: {
					'application/json': {
						schema: keyringOutput,
					},
				},
				description: 'The new keyring created.',
			},
		},
	}),
);

app.openapi(route, (c) => {
	// Needs to be set to a variable or else type isn't inferred
	const json = c.req.valid('json');

	return c.json({
		...json,
		rotation: {
			...json.rotation,
			count: {
				...json.rotation.count,
				threshold: json.rotation.count.threshold?.toString() as unknown as bigint,
				current: BigInt(0).toString() as unknown as bigint,
			},
		},
	} satisfies z.infer<typeof keyringOutput>);
});

export default app;
