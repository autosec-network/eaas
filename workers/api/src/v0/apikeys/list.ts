import { createRoute, OpenAPIHono, z } from '@hono/zod-openapi';
import * as tenantSchema from 'db/schemas/tenant/main';
import { eq, sql } from 'drizzle-orm/sql';
import { bearerAuth } from 'hono/bearer-auth';
import { endTime, startTime } from 'hono/timing';
import type { Buffer } from 'node:buffer';
import { createHash } from 'node:crypto';
import { Permissions } from 'types';
import { verifyToken } from '~/base';
import { problemResponse } from '~/errors';
import type { ContextVariables, EnvVars } from '~/types';
import { apikeyOutput } from '~/v0/apikeys/shared';
import { APITags } from '~/v0/extras';

const app = new OpenAPIHono<{ Bindings: EnvVars; Variables: ContextVariables }>();

app.use(
	'*',
	bearerAuth({
		/**
		 * Use sha512 (default uses sha256)
		 * Use node crypto for optimization
		 */
		hashFunction: (data: string) => createHash('sha512').update(data).digest('hex'),
		verifyToken: (token, c) =>
			verifyToken(
				token,
				// eslint-disable-next-line @typescript-eslint/no-unsafe-argument
				c,
				false,
			),
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
		401: problemResponse('Unauthorized: the provided API key does not exist, or has been destroyed.'),
	},
});

app.openapi(route, async (c) => {
	startTime(c, 't_db-list-apikeys');
	const { apiKeyRows, keyringRows } = await c.var.t_db
		.batch([
			c.var.t_db
				.select({
					ak_id: tenantSchema.api_keys.ak_id,
					name: tenantSchema.api_keys.name,
					b_time: tenantSchema.api_keys.b_time,
					m_time: tenantSchema.api_keys.m_time,
					expires: tenantSchema.api_keys.expires,
					c_time: tenantSchema.api_keys.c_time,
					enabled: tenantSchema.api_keys.enabled,
					r_apikeys: tenantSchema.api_keys.r_apikeys,
					r_keyrings: tenantSchema.api_keys.r_keyrings,
				})
				.from(tenantSchema.api_keys)
				.where(c.var.globalPermissions?.r_apikeys === Permissions.None ? eq(tenantSchema.api_keys.ak_id, sql<Buffer>`unhex(${c.var.ak_id.hex})`) : undefined),
			c.var.t_db
				.select({
					ak_id: tenantSchema.api_keys_keyrings.ak_id,
					keyring_name: tenantSchema.keyrings.name,
					r_datakeys: tenantSchema.api_keys_keyrings.r_datakeys,
					r_encrypt: tenantSchema.api_keys_keyrings.r_encrypt,
					r_decrypt: tenantSchema.api_keys_keyrings.r_decrypt,
					r_rewrap: tenantSchema.api_keys_keyrings.r_rewrap,
					r_sign: tenantSchema.api_keys_keyrings.r_sign,
					r_verify: tenantSchema.api_keys_keyrings.r_verify,
					r_hmac: tenantSchema.api_keys_keyrings.r_hmac,
				})
				.from(tenantSchema.api_keys_keyrings)
				.innerJoin(tenantSchema.keyrings, eq(tenantSchema.api_keys_keyrings.kr_id, tenantSchema.keyrings.kr_id))
				.where(c.var.globalPermissions?.r_apikeys === Permissions.None ? eq(tenantSchema.api_keys_keyrings.ak_id, sql<Buffer>`unhex(${c.var.ak_id.hex})`) : undefined),
		])
		.then(([apiKeyRows, keyringRows]) => ({
			apiKeyRows: apiKeyRows.map((row) => ({
				...row,
				ak_id: {
					base64url: row.ak_id.toString('base64url'),
				},
			})),
			keyringRows: keyringRows.map((row) => ({
				...row,
				ak_id: {
					base64url: row.ak_id.toString('base64url'),
				},
			})),
		}));
	endTime(c, 't_db-list-apikeys', 3);

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

	const output = apiKeyRows.map(
		(row) =>
			({
				created: row.b_time.toISOString(),
				expired: row.expires < new Date(),
				expires: row.expires.toISOString(),
				lastModified: row.c_time.toISOString(),
				lastRotation: row.m_time.toISOString(),
				enabled: row.enabled,
				name: row.name,
				token_id: row.ak_id.base64url,
				// It's the string version
				apikeysPermission: Permissions[row.r_apikeys] as unknown as Permissions,
				// It's the string version
				keyringsPermission: Permissions[row.r_keyrings] as unknown as Permissions,
				keyrings: keyringsByApiKey.get(row.ak_id.base64url) ?? {},
			}) satisfies z.output<typeof apikeyOutput>,
	);

	// Always surface the caller's own key at index 0, regardless of DB row order
	const selfIndex = output.findIndex((row) => row.token_id === c.var.ak_id.base64url);
	if (selfIndex > 0) {
		const [selfRow] = output.splice(selfIndex, 1);
		output.unshift(selfRow);
	}

	return c.json(output);
});

export default app;
