import type { z } from '@hono/zod-openapi';
import type { ContextVariables, EnvVars } from '~/types.mjs';
import type { apikeyOutput } from '~/v0/apikeys/shared.mjs';
import type { Permissions } from '~shared/types/d1/index.mjs';

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
		description: 'Get a specific Api Key by its token ID.',
		request: {
			params: z.object({
				token_id: apikeyOutput.shape.token_id,
			}),
		},
		responses: {
			200: {
				content: {
					'application/json': {
						schema: apikeyOutput,
					},
				},
				description: 'Returns the specific API key if permissions allow access.',
			},
		},
	}),
);

app.openapi(route, (c) => {
	const { token_id } = c.req.valid('param');

	return import('@chainfuse/helpers/buffers')
		.then(({ BufferHelpers }) => BufferHelpers.uuidConvert(token_id))
		.then((ak_id) => {
			return Promise.all([import('~shared/types/d1/index.mjs'), import('node:crypto')])
				.then(([{ Permissions }, { timingSafeEqual }]) => {
					// Check if user has read permissions for API keys
					if (c.var.globalPermissions?.r_apikeys && c.var.globalPermissions.r_apikeys > Permissions.None) {
						return true;
					}

					const incomingBuffer = Buffer.from(ak_id.blob);
					const originalBuffer = Buffer.from(c.var.ak_id.blob);

					// Or if they're requesting their own key (comparing hex strings)
					return timingSafeEqual(incomingBuffer, originalBuffer) && incomingBuffer.byteLength === originalBuffer.byteLength;
				})
				.then((hasPermission) => {
					if (hasPermission) {
						return Promise.all([import('~shared/db-preview/schemas/tenant'), import('~shared/types/d1/index.mjs'), import('drizzle-orm')])
							.then(([{ api_keys, api_keys_keyrings, keyrings }, { Permissions }, { eq, sql }]) =>
								c.var.t_db().batch([
									c.var
										.t_db()
										.select({
											token_id: api_keys.ak_id,
											name: api_keys.name,
											b_time: api_keys.b_time,
											m_time: api_keys.m_time,
											expires: api_keys.expires,
											c_time: api_keys.c_time,
											r_apikeys: api_keys.r_apikeys,
											r_keyrings: api_keys.r_keyrings,
										})
										.from(api_keys)
										.where(eq(api_keys.ak_id, sql`unhex(${c.var.ak_id.hex})`))
										.limit(1),
									c.var
										.t_db()
										.select({
											keyring_name: keyrings.name,
											r_datakeys: api_keys_keyrings.r_datakeys,
											r_encrypt: api_keys_keyrings.r_encrypt,
											r_decrypt: api_keys_keyrings.r_decrypt,
											r_rewrap: api_keys_keyrings.r_rewrap,
											r_sign: api_keys_keyrings.r_sign,
											r_verify: api_keys_keyrings.r_verify,
											r_hmac: api_keys_keyrings.r_hmac,
										})
										.from(api_keys_keyrings)
										.innerJoin(keyrings, eq(api_keys_keyrings.kr_id, keyrings.kr_id))
										.where(eq(api_keys_keyrings.ak_id, sql`unhex(${c.var.ak_id.hex})`)),
								]),
							)
							.then(([apiKeyRows, keyringRows]) =>
								import('@chainfuse/helpers/buffers').then(({ BufferHelpers }) =>
									Promise.all(
										apiKeyRows.map(async (row) => ({
											...row,
											token_id: await BufferHelpers.uuidConvert(row.token_id),
										})),
									).then((apiKeyRows) => ({ apiKeyRows, keyringRows })),
								),
							)
							.then(({ apiKeyRows, keyringRows }) => {
								const row = apiKeyRows[0];

								if (row) {
									return import('~shared/types/d1/index.mjs')
										.then(
											({ Permissions }) =>
												({
													token_id: row.token_id.base64url,
													name: row.name,
													created: row.b_time,
													lastRotation: row.m_time,
													expires: row.expires,
													expired: new Date(row.expires) < new Date(),
													lastModified: row.c_time,
													apikeysPermission: Permissions[row.r_apikeys] as unknown as Permissions,
													// It's the string version
													keyringsPermission: Permissions[row.r_keyrings] as unknown as Permissions,
													keyrings: keyringRows.reduce(
														(acc, keyringRow) => {
															if (keyringRow.keyring_name) {
																acc[keyringRow.keyring_name] = {
																	r_datakeys: Permissions[keyringRow.r_datakeys] as unknown as Permissions,
																	r_encrypt: keyringRow.r_encrypt,
																	r_decrypt: keyringRow.r_decrypt,
																	r_rewrap: keyringRow.r_rewrap,
																	r_sign: keyringRow.r_sign,
																	r_verify: keyringRow.r_verify,
																	r_hmac: keyringRow.r_hmac,
																};
															}
															return acc;
														},
														{} as Record<string, any>,
													),
												}) satisfies z.output<typeof apikeyOutput>,
										)
										.then((result) => c.json(result, 200));
								} else {
									return c.json({ success: false, errors: [{ message: 'API Key not found' }] }, 404);
								}
							});
					} else {
						return c.json({ success: false, errors: [{ message: 'Access Denied: You do not have permission to perform this action' }] }, 403);
					}
				});
		})
		.catch(() => {
			return c.json({
				success: false,
				errors: [],
			});
		});
});

export default app;
