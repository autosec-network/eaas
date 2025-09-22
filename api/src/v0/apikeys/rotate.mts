import { BufferHelpers } from '@chainfuse/helpers/buffers';
import { CryptoHelpers } from '@chainfuse/helpers/crypto';
import { createRoute, OpenAPIHono, z } from '@hono/zod-openapi';
import { and, count, eq, sql } from 'drizzle-orm/sql';
import { bearerAuth } from 'hono/bearer-auth';
import { Buffer } from 'node:buffer';
import { createHash } from 'node:crypto';
import type { ContextVariables, EnvVars } from '~/types.mjs';
import { apikeyEditable, createApikeyOutput } from '~/v0/apikeys/shared.mjs';
import { APITags } from '~/v0/extras.mjs';
import { api_keys_tenants } from '~shared/db-preview/schemas/root';
import { api_keys } from '~shared/db-preview/schemas/tenant';
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
	method: 'put',
	path: '/',
	description: 'Rotate an API key by generating a new secret and optionally updating expiration.',
	request: {
		params: z.object({
			token_id: createApikeyOutput.shape.token_id,
		}),
		body: {
			content: {
				'application/json': {
					schema: z.object({
						expires: apikeyEditable.shape.expires,
					}),
				},
			},
		},
	},
	responses: {
		200: {
			content: {
				'application/json': {
					schema: createApikeyOutput,
				},
			},
			description: 'API key rotated successfully.',
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
		404: {
			content: {
				'application/json': {
					schema: z.object({
						error: z.string(),
					}),
				},
			},
			description: 'API key not found.',
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

app.openapi(route, async (c) => {
	const { token_id } = c.req.valid('param');
	const body = c.req.valid('json');

	// Set default expiration if not provided (90 days from now)
	const expires = body.expires ? new Date(body.expires) : new Date(Date.now() + 90 * 24 * 60 * 60 * 1000);

	// Check permissions first
	if ((c.var.globalPermissions?.r_apikeys ?? Permissions.None) >= Permissions.Write) {
		const ak_id = await BufferHelpers.uuidConvert(token_id);

		// First, verify the API key exists
		const [row] = await c.var
			.t_db()
			.select({
				count: count(),
			})
			.from(api_keys)
			.where(eq(api_keys.ak_id, sql<Buffer>`unhex(${ak_id.hex})`))
			.limit(1);

		if ((row?.count ?? 0) > 0) {
			// Generate new API key secret
			const { ak_secret_base64url, ak_secret_hash } = await CryptoHelpers.secretBytes(512 / 8).then((ak_secret) =>
				Promise.all([
					// Convert to format for user response
					BufferHelpers.bufferToBase64(ak_secret.buffer, true),
					// Hash to store in db
					CryptoHelpers.getHash('SHA-512', ak_secret.buffer),
				]).then(([ak_secret_base64url, ak_secret_hash]) => ({ ak_secret_base64url, ak_secret_hash })),
			);

			// Update both databases in parallel
			return Promise.all([
				// Update tenant database (hash, expires, m_time auto-updates)
				c.var
					.t_db()
					.update(api_keys)
					.set({
						hash: sql<Buffer>`unhex(${ak_secret_hash})`,
						expires: expires.toISOString() as ISODateString,
						m_time: new Date().toISOString() as ISODateString,
					})
					.where(eq(api_keys.ak_id, sql<Buffer>`unhex(${ak_id.hex})`)),
				// Update root database (expires only)
				c.var
					.r_db()
					.update(api_keys_tenants)
					.set({
						expires: expires.toISOString() as ISODateString,
					})
					.where(and(eq(api_keys_tenants.ak_id, sql<Buffer>`unhex(${ak_id.hex})`), eq(api_keys_tenants.t_id, sql<Buffer>`unhex(${c.var.t_id.hex})`))),
			])
				.then(() =>
					c.json(
						{
							token_id: ak_id.base64url,
							expires: expires.toISOString() as ISODateString,
							token: [ApiKeyVersions['512base64urlSha512'], ak_id.base64url, ak_secret_base64url].join('.'),
						},
						200,
					),
				)
				.catch(() => c.json({ error: 'Failed to update API key' }, 500));
		} else {
			return c.json({ error: 'API key not found' }, 404);
		}
	} else {
		return c.json({ error: 'Insufficient permissions to rotate API keys' }, 403);
	}
});

export default app;
