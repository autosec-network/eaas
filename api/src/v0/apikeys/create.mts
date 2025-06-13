import type { ContextVariables, EnvVars } from '~/types.mjs';
import { Permissions } from '~shared/types/d1/index.mjs';

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

export const route = await Promise.all([import('@hono/zod-openapi'), import('~/v0/apikeys/shared.mjs'), import('~shared/types/d1/index.mjs')]).then(([{ createRoute, z }, { apikeyEditable, createApikeyOutput }, { Permissions }]) =>
	createRoute({
		tags: ['apikey management'],
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
				description: 'Invalid request data.',
			},
			403: {
				description: 'Insufficient permissions to create API keys.',
			},
			404: {
				description: 'Keyring not found.',
			},
		},
	}),
);

app.openapi(route, async (c) => {
	// Check permissions
	if (!c.var.globalPermissions || c.var.globalPermissions.r_apikeys < Permissions.Admin) {
		return c.json({ error: 'Insufficient permissions to create API keys' }, 403);
	}

	const body = c.req.valid('json');

	// Set default expiration if not provided (90 days from now)
	const expires = body.expires ? new Date(body.expires) : new Date(Date.now() + 90 * 24 * 60 * 60 * 1000);

	try {
		// Convert keyring ID from base64url to UUID format
		const kr_id = await import('@chainfuse/helpers/buffers').then(({ BufferHelpers }) => BufferHelpers.uuidConvert(body.kr_id));

		// Check if keyring exists and user has access to it
		const keyringExists = await Promise.all([import('~shared/db-preview/schemas/tenant'), import('drizzle-orm')])
			.then(([{ keyrings }, { eq, sql }]) =>
				c.var
					.t_db()
					.select({ kr_id: keyrings.kr_id })
					.from(keyrings)
					.where(eq(keyrings.kr_id, sql`unhex(${kr_id.hex})`))
					.limit(1),
			)
			.then((rows) => rows.length > 0);

		if (!keyringExists) {
			return c.json({ error: 'Keyring not found' }, 404);
		}

		// Generate new API key ID and secret
		const [ak_id, ak_secret] = await Promise.all([import('@chainfuse/helpers/buffers').then(({ BufferHelpers }) => BufferHelpers.generateUuid), import('@chainfuse/helpers/crypto').then(({ CryptoHelpers }) => CryptoHelpers.secretBytes(512 / 8))]);

		// Create bearer token and hash
		const [ak_secret_base64url, ak_secret_hash] = await Promise.all([import('@chainfuse/helpers/buffers').then(({ BufferHelpers }) => BufferHelpers.bufferToBase64(ak_secret.buffer, true)), import('@chainfuse/helpers/crypto').then(({ CryptoHelpers }) => CryptoHelpers.getHash('SHA-512', ak_secret.buffer))]);

		const apiKeyVersion = await import('~shared/types/bw/index.mjs').then(({ ApiKeyVersions }) => ApiKeyVersions['512base64urlSha512']);

		const bearerToken = [apiKeyVersion, ak_id.base64url, ak_secret_base64url].join('.');

		// Insert into root database (api_keys_tenants)
		await Promise.all([import('~shared/db-preview/schemas/root'), import('drizzle-orm')]).then(([{ api_keys_tenants }, { sql }]) =>
			c.var
				.r_db()
				.insert(api_keys_tenants)
				.values({
					ak_id: sql`unhex(${ak_id.hex})`,
					t_id: sql`unhex(${c.var.t_id.hex})`,
					expires: expires.toISOString() as any,
				}),
		);

		// Insert into tenant database (api_keys)
		const insertedApiKeys = await Promise.all([import('~shared/db-preview/schemas/tenant'), import('drizzle-orm')]).then(([{ api_keys }, { sql }]) =>
			c.var
				.t_db()
				.insert(api_keys)
				.values({
					ak_id: sql`unhex(${ak_id.hex})`,
					name: body.name,
					hash: sql`unhex(${ak_secret_hash})`,
					expires: expires.toISOString() as any,
				})
				.returning({
					token_id: api_keys.ak_id,
					name: api_keys.name,
					expires: api_keys.expires,
					created: api_keys.b_time,
				}),
		);

		const insertedApiKey = insertedApiKeys[0];
		if (!insertedApiKey) {
			throw new Error('Failed to create API key');
		}

		// Link API key to keyring with permissions
		await Promise.all([import('~shared/db-preview/schemas/tenant'), import('drizzle-orm')]).then(([{ api_keys_keyrings }, { sql }]) =>
			c.var
				.t_db()
				.insert(api_keys_keyrings)
				.values({
					ak_id: sql`unhex(${ak_id.hex})`,
					kr_id: sql`unhex(${kr_id.hex})`,
					...(body.permissions?.r_datakeys !== undefined && { r_datakeys: body.permissions.r_datakeys }),
					...(body.permissions?.r_encrypt !== undefined && { r_encrypt: body.permissions.r_encrypt }),
					...(body.permissions?.r_decrypt !== undefined && { r_decrypt: body.permissions.r_decrypt }),
					...(body.permissions?.r_rewrap !== undefined && { r_rewrap: body.permissions.r_rewrap }),
					...(body.permissions?.r_sign !== undefined && { r_sign: body.permissions.r_sign }),
					...(body.permissions?.r_verify !== undefined && { r_verify: body.permissions.r_verify }),
					...(body.permissions?.r_hmac !== undefined && { r_hmac: body.permissions.r_hmac }),
				}),
		);

		// Return the created API key info (same format as list but with token)
		const response = {
			token: bearerToken, // Only difference from list output
			token_id: Buffer.from(insertedApiKey.token_id).toString('base64url'),
			name: insertedApiKey.name,
			created: insertedApiKey.created,
			lastRotation: insertedApiKey.created, // Same as created for new keys
			expires: insertedApiKey.expires,
			expired: new Date(insertedApiKey.expires) < new Date(),
			lastModified: insertedApiKey.created, // Same as created for new keys
			keyringsPermission: await import('~shared/types/d1/index.mjs').then(({ Permissions }) => Permissions[c.var.globalPermissions!.r_keyrings]),
			apikeysPermission: await import('~shared/types/d1/index.mjs').then(({ Permissions }) => Permissions[c.var.globalPermissions!.r_apikeys]),
		};

		return c.json(response, 201);
	} catch (error) {
		console.error('Error creating API key:', error);
		return c.json({ error: 'Internal server error' }, 500);
	}
});

export default app;
