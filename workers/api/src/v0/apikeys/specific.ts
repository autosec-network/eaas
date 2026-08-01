import { createRoute, OpenAPIHono, z } from '@hono/zod-openapi';
import * as tenantSchema from 'db/schemas/tenant/main';
import { eq, sql } from 'drizzle-orm/sql';
import { bearerAuth } from 'hono/bearer-auth';
import { endTime, startTime } from 'hono/timing';
import { Buffer } from 'node:buffer';
import { createHash, timingSafeEqual } from 'node:crypto';
import { Permissions } from 'types';
import { problemJson } from '~/errors';
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
			import('~/base').then(({ verifyToken }) =>
				verifyToken(
					token,
					// eslint-disable-next-line @typescript-eslint/no-unsafe-argument
					c,
					false,
				),
			),
	}),
);

export const route = createRoute({
	tags: [APITags['API Key Management']],
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
});

app.openapi(route, async (c) => {
	const { token_id } = c.req.valid('param');

	const ak_id_buffer = Buffer.from(token_id, 'base64url');
	const ak_id = {
		buffer: ak_id_buffer,
	};

	const hasPermission = (() => {
		// Check if user has read permissions for API keys
		if (c.var.globalPermissions?.r_apikeys && c.var.globalPermissions.r_apikeys > Permissions.None) {
			return true;
		}

		const incomingBuffer = Buffer.from(ak_id.buffer);
		const originalBuffer = Buffer.from(c.var.ak_id.buffer);

		// Or if they're requesting their own key (comparing hex strings)
		return timingSafeEqual(incomingBuffer, originalBuffer) && incomingBuffer.byteLength === originalBuffer.byteLength;
	})();

	if (hasPermission) {
		startTime(c, 't_db-fetch-apikey');
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
					.where(eq(tenantSchema.api_keys.ak_id, sql<Buffer>`unhex(${c.var.ak_id.hex})`))
					.limit(1),
				c.var.t_db
					.select({
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
					.where(eq(tenantSchema.api_keys_keyrings.ak_id, sql<Buffer>`unhex(${c.var.ak_id.hex})`)),
			])
			.then(([apiKeyRows, keyringRows]) => ({
				apiKeyRows: apiKeyRows.map((row) => ({
					...row,
					ak_id: {
						base64url: row.ak_id.toString('base64url'),
					},
				})),
				keyringRows,
			}));
		endTime(c, 't_db-fetch-apikey', 3);

		const row = apiKeyRows[0];

		if (row) {
			return c.json(
				{
					token_id: row.ak_id.base64url,
					name: row.name,
					created: row.b_time.toISOString(),
					lastRotation: row.m_time.toISOString(),
					expires: row.expires.toISOString(),
					expired: row.expires < new Date(),
					lastModified: row.c_time.toISOString(),
					enabled: row.enabled,
					apikeysPermission: Permissions[row.r_apikeys] as unknown as Permissions,
					// It's the string version
					keyringsPermission: Permissions[row.r_keyrings] as unknown as Permissions,
					keyrings: keyringRows.reduce((acc, keyringRow) => {
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
					}, {}),
				} satisfies z.output<typeof apikeyOutput>,
				200,
			);
		} else {
			return problemJson(c, 404, { detail: 'API Key not found' });
		}
	} else {
		return problemJson(c, 403, { detail: 'Access Denied: You do not have permission to perform this action' });
	}
});

export default app;
