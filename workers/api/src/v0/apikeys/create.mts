import { BufferHelpers } from '@chainfuse/helpers/buffers';
import { CryptoHelpers } from '@chainfuse/helpers/crypto';
import { createRoute, OpenAPIHono, z } from '@hono/zod-openapi';
import { inArray, sql } from 'drizzle-orm/sql';
import { bearerAuth } from 'hono/bearer-auth';
import type { Buffer } from 'node:buffer';
import { createHash } from 'node:crypto';
import type { ContextVariables, EnvVars } from '~/types.mjs';
import { apikeyEditable, createApikeyOutput } from '~/v0/apikeys/shared.mjs';
import { APITags } from '~/v0/extras.mjs';
import { api_keys_tenants } from '~shared/db-preview/schemas/root';
import { api_keys, api_keys_keyrings, keyrings as keyringsTable } from '~shared/db-preview/schemas/tenant';
import { ApiKeyVersions } from '~shared/types/bw/index.mjs';
import { Permissions, type ISODateString } from '~shared/types/d1/index.mjs';

const app = new OpenAPIHono<{ Bindings: EnvVars; Variables: ContextVariables }>();

app.use(
	'*',
	bearerAuth({
		/**
		 * Use sha512 (default uses sha256)
		 * Use node crypto for optimization
		 */
		hashFunction: (data: string) => createHash('sha512').update(data).digest('hex'),
		verifyToken: (token, c) => import('~/base.mjs').then(({ verifyToken }) => verifyToken(token, c)),
	}),
);

export const route = createRoute({
	tags: [APITags['API Key Management']],
	method: 'post',
	path: '/',
	description: 'Create a new API key.',
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
});

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
				return c.var
					.t_db()
					.select({
						kr_id: keyringsTable.kr_id,
						name: keyringsTable.name,
					})
					.from(keyringsTable)
					.where(inArray(keyringsTable.name, keyringNames))
					.then((rows) =>
						Promise.all(
							rows.map(async (row) => ({
								...row,
								kr_id: await BufferHelpers.uuidConvert(row.kr_id),
							})),
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
				Promise.all([
					// Generate API key ID
					BufferHelpers.generateUuid7(),
					// Generate API key secret
					CryptoHelpers.secretBytes(512 / 8).then((ak_secret) =>
						Promise.all([
							// Convert to format for user response
							BufferHelpers.bufferToBase64(ak_secret.buffer, true),
							// Hash to store in db
							CryptoHelpers.getHash('SHA-512', ak_secret.buffer),
						]).then(([ak_secret_base64url, ak_secret_hash]) => ({ ak_secret_base64url, ak_secret_hash })),
					),
				])
					.then(([ak_id, { ak_secret_base64url, ak_secret_hash }]) => ({
						ak_id,
						ak_secret_hash,
						// Create the bearer token
						token: [ApiKeyVersions['512base64urlSha512'], ak_id.base64url, ak_secret_base64url].join('.'),
					}))
					// DB Operations
					.then(({ ak_id, token, ak_secret_hash }) =>
						Promise.all([
							// Save to root for authentication
							c.var
								.r_db()
								.insert(api_keys_tenants)
								.values({
									ak_id: sql<Buffer>`unhex(${ak_id.hex})`,
									expires: expires.toISOString() as ISODateString,
									t_id: sql<Buffer>`unhex(${c.var.t_id.hex})`,
								}),
							// Save to tenant for lookup
							c.var
								.t_db()
								.insert(api_keys)
								.values({
									ak_id: sql<Buffer>`unhex(${ak_id.hex})`,
									expires: expires.toISOString() as ISODateString,
									hash: sql<Buffer>`unhex(${ak_secret_hash})`,
									name,
									r_apikeys: apikeysPermission,
									r_keyrings: keyringsPermission,
								})
								.returning({
									b_time: api_keys.b_time,
									m_time: api_keys.m_time,
									c_time: api_keys.c_time,
								}),
						]).then(async ([, [row]]) => {
							if (validatedKeyrings.length > 0) {
								/**
								 * Save keyring permissions
								 * @todo refactor to use batch due to 100 parameter per query limit
								 */
								await c.var
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
