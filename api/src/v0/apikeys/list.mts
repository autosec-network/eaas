import type { z } from '@hono/zod-openapi';
import type { ContextVariables, EnvVars } from '~/types.mjs';
import type { apikeyOutput } from '~/v0/apikeys/shared.mjs';

const app = await import('@hono/zod-openapi').then(({ OpenAPIHono }) => new OpenAPIHono<{ Bindings: EnvVars; Variables: ContextVariables }>());

app.use('*', (c, next) =>
	Promise.all([import('hono/bearer-auth'), import('node:crypto')]).then(([{ bearerAuth }, { createHash }]) =>
		bearerAuth({
			/**
			 * Use sha512 (default uses sha256)
			 * Use node crypto for optimization
			 */
			hashFunction: (data: string) => createHash('sha512').update(data).digest('hex'),
			verifyToken: (token, c) => import('~/base.mjs').then(({ verifyToken }) => verifyToken(token, c, false)),
		})(c, next),
	),
);

export const route = await Promise.all([import('@hono/zod-openapi'), import('~/v0/apikeys/shared.mjs')]).then(([{ createRoute, z }, { apikeyOutput }]) =>
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
						schema: z.array(apikeyOutput),
					},
				},
				description: 'Depending on key permissions, list all api keys, or fallback to itself.',
			},
		},
	}),
);

app.openapi(route, async (c) =>
	Promise.all([import('~shared/db-preview/schemas/tenant'), import('~shared/types/d1/index.mjs'), import('drizzle-orm')])
		.then(([{ api_keys }, { Permissions }, { eq, sql }]) =>
			c.var
				.t_db()
				.select({
					token_id: api_keys.ak_id,
					name: api_keys.name,
					b_time: api_keys.b_time,
					m_time: api_keys.m_time,
					expires: api_keys.expires,
					c_time: api_keys.c_time,
				})
				.from(api_keys)
				.where(c.var.globalPermissions?.r_apikeys === Permissions.None ? eq(api_keys.ak_id, sql`unhex(${c.var.ak_id.hex})`) : undefined),
		)
		.then((rows) =>
			import('~shared/types/d1/index.mjs').then(({ Permissions }) =>
				rows.map(
					(row) =>
						({
							token_id: Buffer.from(row.token_id).toString('base64url'),
							name: row.name,
							created: row.b_time,
							lastRotation: row.m_time,
							expires: row.expires,
							expired: new Date(row.expires) < new Date(),
							lastModified: row.c_time,
							keyringsPermission: Permissions[c.var.globalPermissions!.r_keyrings],
							apikeysPermission: Permissions[c.var.globalPermissions!.r_apikeys],
						}) satisfies z.infer<typeof apikeyOutput>,
				),
			),
		)
		.then((json) => c.json(json)),
);

export default app;
