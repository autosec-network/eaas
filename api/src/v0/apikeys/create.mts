import type { z } from '@hono/zod-openapi';
import type { Buffer } from 'node:buffer';
import type { ContextVariables, EnvVars } from '~/types.mjs';
import type { createApikeyOutput } from '~/v0/apikeys/shared.mjs';
import { Permissions, type ISODateString } from '~shared/types/d1/index.mjs';

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

export const route = await Promise.all([import('@hono/zod-openapi'), import('~/v0/apikeys/shared.mjs'), import('~/v0/shared.mjs')]).then(([{ createRoute, z }, { apikeyEditable, createApikeyOutput }, { unifiedResponseNote }]) =>
	createRoute({
		tags: ['apikey management'],
		method: 'post',
		path: '/',
		description: `Create a new API key.${unifiedResponseNote}`,
		request: {
			body: {
				content: {
					'application/json': {
						schema: apikeyEditable,
					},
				},
			},
		},
		responses: {
			201: {
				content: {
					'application/json': {
						schema: createApikeyOutput,
					},
				},
				description: 'API key created successfully.',
			},
			400: {
				content: {
					'application/json': {
						schema: z.object({
							error: z.string(),
						}),
					},
				},
				description: 'Bad request - invalid keyrings.',
			},
			403: {
				content: {
					'application/json': {
						schema: z.object({
							error: z.string(),
						}),
					},
				},
				description: 'Insufficient permissions.',
			},
			500: {
				content: {
					'application/json': {
						schema: z.object({
							error: z.string(),
						}),
					},
				},
				description: 'Internal server error.',
			},
		},
	}),
);

app.openapi(route, (c) => {
	const { name, apikeysPermission, keyringsPermission, keyrings, ...body } = c.req.valid('json');
	// Set default expiration if not provided (90 days from now)
	const expires = body.expires ? new Date(body.expires) : new Date(Date.now() + 90 * 24 * 60 * 60 * 1000);

	// Check permissions first
	if (c.var.globalPermissions?.r_apikeys === Permissions.Admin) {
		// First, validate keyring names before doing any database writes
		return (async () => {
			if (Object.keys(keyrings).length > 0) {
				const keyringNames = Object.keys(keyrings);
				return Promise.all([import('~shared/db-preview/schemas/tenant'), import('drizzle-orm')])
					.then(([{ keyrings: keyringsTable }, { inArray }]) => {
						return c.var
							.t_db()
							.select({
								kr_id: keyringsTable.kr_id,
								name: keyringsTable.name,
							})
							.from(keyringsTable)
							.where(inArray(keyringsTable.name, keyringNames));
					})
					.then((rows) =>
						import('@chainfuse/helpers/buffers').then(({ BufferHelpers }) =>
							Promise.all(
								rows.map(async (row) => ({
									...row,
									kr_id: await BufferHelpers.uuidConvert(row.kr_id),
								})),
							),
						),
					)
					.then((keyringLookups) => {
						// Check if all requested keyrings exist
						const foundKeyringNames = keyringLookups.map((k) => k.name);
						const missingKeyrings = keyringNames.filter((name) => !foundKeyringNames.includes(name));

						if (missingKeyrings.length > 0) {
							throw new Error(`Keyring(s) not found: ${missingKeyrings.join(', ')}`);
						}

						return keyringLookups;
					});
			} else {
				return [];
			}
		})()
			.then((validatedKeyrings) =>
				// Generation
				import('@chainfuse/helpers/buffers')
					.then(({ BufferHelpers }) =>
						Promise.all([
							// Generate API key ID
							BufferHelpers.generateUuid,
							import('@chainfuse/helpers/crypto').then(({ CryptoHelpers }) =>
								// Generate API key secret
								CryptoHelpers.secretBytes(512 / 8).then((ak_secret) =>
									Promise.all([
										// Convert to format for user response
										BufferHelpers.bufferToBase64(ak_secret.buffer, true),
										// Hash to store in db
										CryptoHelpers.getHash('SHA-512', ak_secret.buffer),
									]).then(([ak_secret_base64url, ak_secret_hash]) => ({ ak_secret_base64url, ak_secret_hash })),
								),
							),
						]).then(([ak_id, { ak_secret_base64url, ak_secret_hash }]) =>
							import('~shared/types/bw/index.mjs').then(({ ApiKeyVersions }) => ({
								ak_id,
								ak_secret_hash,
								// Create the bearer token
								token: [ApiKeyVersions['512base64urlSha512'], ak_id.base64url, ak_secret_base64url].join('.'),
							})),
						),
					)
					// DB Operations
					.then(({ ak_id, token, ak_secret_hash }) =>
						Promise.all([
							// Save to root for authentication
							Promise.all([import('~shared/db-preview/schemas/root'), import('drizzle-orm')]).then(([{ api_keys_tenants }, { sql }]) =>
								c.var
									.r_db()
									.insert(api_keys_tenants)
									.values({
										ak_id: sql`unhex(${ak_id.hex})`,
										expires: expires.toISOString() as ISODateString,
										t_id: sql`unhex(${c.var.t_id.hex})`,
									}),
							),
							// Save to tenant for lookup
							Promise.all([import('~shared/db-preview/schemas/tenant'), import('drizzle-orm')]).then(([{ api_keys }, { sql }]) =>
								c.var
									.t_db()
									.insert(api_keys)
									.values({
										ak_id: sql`unhex(${ak_id.hex})`,
										expires: expires.toISOString() as ISODateString,
										hash: sql`unhex(${ak_secret_hash})`,
										name,
										r_apikeys: apikeysPermission,
										r_keyrings: keyringsPermission,
									})
									.returning({
										b_time: api_keys.b_time,
										m_time: api_keys.m_time,
										c_time: api_keys.c_time,
									}),
							),
						]).then(async ([, [row]]) => {
							if (validatedKeyrings.length > 0) {
								/**
								 * Save keyring permissions
								 * @todo refactor to use batch due to 100 parameter per query limit
								 */
								await Promise.all([import('~shared/db-preview/schemas/tenant'), import('drizzle-orm')]).then(([{ api_keys_keyrings }, { sql }]) =>
									c.var
										.t_db()
										.insert(api_keys_keyrings)
										.values(
											validatedKeyrings.map((keyring) => {
												const permissions = keyrings[keyring.name]!;

												return {
													ak_id: sql<Buffer>`unhex(${ak_id.hex})` as unknown as Buffer,
													kr_id: sql<Buffer>`unhex(${keyring.kr_id.hex})` as unknown as Buffer,
													r_datakeys: permissions.r_datakeys,
													r_encrypt: permissions.r_encrypt,
													r_decrypt: permissions.r_decrypt,
													r_rewrap: permissions.r_rewrap,
													r_sign: permissions.r_sign,
													r_verify: permissions.r_verify,
													r_hmac: permissions.r_hmac,
												} satisfies typeof api_keys_keyrings.$inferInsert;
											}),
										),
								);
							}

							return { ak_id, token, validatedKeyrings, row: row! };
						}),
					),
			)
			.then(({ ak_id, token, validatedKeyrings, row }) => {
				return c.json(
					{
						created: row.b_time,
						expired: expires < new Date(),
						expires: expires.toISOString() as ISODateString,
						lastModified: row.m_time,
						lastRotation: row.c_time,
						name,
						token,
						token_id: ak_id.base64url,
						apikeysPermission: Permissions[apikeysPermission],
						keyringsPermission: Permissions[keyringsPermission],
						keyrings: validatedKeyrings.reduce(
							(acc, keyring) => {
								const permissions = keyrings[keyring.name]!;

								acc[keyring.name] = {
									r_datakeys: Permissions[permissions.r_datakeys],
									r_encrypt: permissions.r_encrypt,
									r_decrypt: permissions.r_decrypt,
									r_rewrap: permissions.r_rewrap,
									r_sign: permissions.r_sign,
									r_verify: permissions.r_verify,
									r_hmac: permissions.r_hmac,
								};
								return acc;
							},
							{} as Exclude<z.input<typeof createApikeyOutput>['keyrings'], undefined>,
						),
					} satisfies z.input<typeof createApikeyOutput>,
					201,
				);
			})
			.catch((error) => {
				const errors = [{ message: 'Failed to create API key' }];

				if (error instanceof Error && error.message && error.message.includes('Keyring(s) not found')) {
					return c.json({ success: false, errors: [...errors, { message: error.message }] }, 422);
				}

				return c.json({ success: false, errors: [{ message: 'Failed to create API key' }] }, 500);
			});
	} else {
		return c.json({ error: 'Insufficient permissions to create API keys' }, 403);
	}
});

export default app;
