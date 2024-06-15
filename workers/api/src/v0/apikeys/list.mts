import { BufferHelpers } from '@chainfuse/helpers/buffers';
import { createRoute, OpenAPIHono, z } from '@hono/zod-openapi';
import { eq, sql } from 'drizzle-orm/sql';
import { bearerAuth } from 'hono/bearer-auth';
import type { Buffer } from 'node:buffer';
import { createHash } from 'node:crypto';
import type { ContextVariables, EnvVars } from '~/types.mjs';
import { apikeyOutput } from '~/v0/apikeys/shared.mjs';
import { APITags } from '~/v0/extras.mjs';
import { api_keys, api_keys_keyrings, keyrings } from '~db/tenant';
import { Permissions } from '~shared/types/d1/index.mjs';

const app = new OpenAPIHono<{ Bindings: EnvVars; Variables: ContextVariables }>();

app.use(
	'*',
	bearerAuth({
		/**
		 * Use sha512 (default uses sha256)
		 * Use node crypto for optimization
		 */
		hashFunction: (data: string) => createHash('sha512').update(data).digest('hex'),
		verifyToken: (token, c) => import('~/base.mjs').then(({ verifyToken }) => verifyToken(token, c, false)),
	}),
);

export const route = createRoute({
	tags: [APITags['API Key Management']],
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
});

app.openapi(route, async (c) =>
	c.var
		.t_db()
		.batch([
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
				.where(c.var.globalPermissions?.r_apikeys === Permissions.None ? eq(api_keys.ak_id, sql<Buffer>`unhex(${c.var.ak_id.hex})`) : undefined),
			c.var
				.t_db()
				.select({
					ak_id: api_keys_keyrings.ak_id,
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
				.where(c.var.globalPermissions?.r_apikeys === Permissions.None ? eq(api_keys_keyrings.ak_id, sql<Buffer>`unhex(${c.var.ak_id.hex})`) : undefined),
		])
		.then(([apiKeyRows, keyringRows]) =>
			Promise.all([
				Promise.all(
					apiKeyRows.map(async (row) => ({
						...row,
						token_id: await BufferHelpers.uuidConvert(row.token_id),
					})),
				),
				Promise.all(
					keyringRows.map(async (row) => ({
						...row,
						ak_id: await BufferHelpers.uuidConvert(row.ak_id),
					})),
				),
			]).then(([apiKeyRows, keyringRows]) => ({ apiKeyRows, keyringRows })),
		)
		.then(({ apiKeyRows, keyringRows }) => {
			// Group keyring permissions by API key ID
			const keyringsByApiKey = new Map<string, Record<string, any>>();
			for (const keyringRow of keyringRows) {
				if (!keyringRow.keyring_name) continue;

				const apiKeyId = keyringRow.ak_id.base64url;
				if (!keyringsByApiKey.has(apiKeyId)) {
					keyringsByApiKey.set(apiKeyId, {});
				}

				keyringsByApiKey.get(apiKeyId)![keyringRow.keyring_name] = {
					r_datakeys: Permissions[keyringRow.r_datakeys] as unknown as Permissions,
					r_encrypt: keyringRow.r_encrypt,
					r_decrypt: keyringRow.r_decrypt,
					r_rewrap: keyringRow.r_rewrap,
					r_sign: keyringRow.r_sign,
					r_verify: keyringRow.r_verify,
					r_hmac: keyringRow.r_hmac,
				};
			}

			return apiKeyRows.map(
				(row) =>
					({
						created: row.b_time,
						expired: new Date(row.expires) < new Date(),
						expires: row.expires,
						lastModified: row.c_time,
						lastRotation: row.m_time,
						name: row.name,
						token_id: row.token_id.base64url,
						// It's the string version
						apikeysPermission: Permissions[row.r_apikeys] as unknown as Permissions,
						// It's the string version
						keyringsPermission: Permissions[row.r_keyrings] as unknown as Permissions,
						keyrings: keyringsByApiKey.get(row.token_id.base64url) ?? {},
					}) satisfies z.output<typeof apikeyOutput>,
			);
		})
		.then((json) => c.json(json)),
);

export default app;
