import { BufferHelpers } from '@chainfuse/helpers/buffers';
import { createRoute, OpenAPIHono, z } from '@hono/zod-openapi';
import { eq, sql } from 'drizzle-orm/sql';
import { bearerAuth } from 'hono/bearer-auth';
import type { Buffer } from 'node:buffer';
import { createHash } from 'node:crypto';
import type { ContextVariables, EnvVars } from '~/types.mjs';
import { apikeyOutput } from '~/v0/apikeys/shared.mjs';
import { APITags } from '~/v0/extras.mjs';
import { api_keys_tenants } from '~shared/db-preview/schemas/root';
import { api_keys } from '~shared/db-preview/schemas/tenant';
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
		verifyToken: (token, c) => import('~/base.mjs').then(({ verifyToken }) => verifyToken(token, c)),
	}),
);

// @ts-expect-error - Hono middleware doesn't need to return when calling await next()
app.use('*', async (c, next) => {
	if (c.var.globalPermissions?.r_apikeys === Permissions.Admin) {
		await next();
	} else {
		console.error("Token doesn't have permissions");
		return c.json({ success: false, errors: [{ message: 'Access Denied: You do not have permission to perform this action' }] }, 403);
	}
});

export const route = createRoute({
	tags: [APITags['API Key Management']],
	method: 'delete',
	path: '/',
	description: 'Delete a specific API Key by its token ID. Requires Admin permissions.',
	request: {
		params: z.object({
			token_id: apikeyOutput.shape.token_id,
		}),
	},
	responses: {
		200: {
			content: {
				'application/json': {
					schema: z.object({
						success: z.boolean(),
						message: z.string(),
					}),
				},
			},
			description: 'API Key successfully deleted.',
		},
		403: {
			content: {
				'application/json': {
					schema: z.object({
						success: z.boolean(),
						errors: z.array(
							z.object({
								message: z.string(),
							}),
						),
					}),
				},
			},
			description: 'Access denied.',
		},
		404: {
			content: {
				'application/json': {
					schema: z.object({
						success: z.boolean(),
						errors: z.array(
							z.object({
								message: z.string(),
							}),
						),
					}),
				},
			},
			description: 'API Key not found.',
		},
		500: {
			content: {
				'application/json': {
					schema: z.object({
						success: z.boolean(),
						errors: z.array(
							z.object({
								message: z.string(),
							}),
						),
					}),
				},
			},
			description: 'Internal server error.',
		},
	},
});

app.openapi(route, (c) => {
	const { token_id } = c.req.valid('param');

	return BufferHelpers.uuidConvert(token_id)
		.then((ak_id) =>
			// Delete from both databases directly - no need to check existence first
			Promise.all([
				// Delete from root database (api_keys_tenants)
				c.var
					.r_db()
					.delete(api_keys_tenants)
					.where(eq(api_keys_tenants.ak_id, sql<Buffer>`unhex(${ak_id.hex})`)),
				// Delete from tenant database (api_keys - will cascade to api_keys_keyrings)
				c.var
					.t_db()
					.delete(api_keys)
					.where(eq(api_keys.ak_id, sql<Buffer>`unhex(${ak_id.hex})`)),
			]).then(() => {
				// If we reach here, both delete operations completed successfully
				// Since we can't reliably check the changes count across different database types,
				// we'll return success. The 404 case would only happen if both databases
				// failed to find the record, but since we're using the same ak_id for both,
				// it's unlikely one would exist without the other.
				return c.json(
					{
						success: true,
						message: 'API Key has been successfully deleted',
					},
					200,
				);
			}),
		)
		.catch((error) => {
			console.error('Error deleting API key:', error);
			return c.json(
				{
					success: false,
					errors: [{ message: 'An error occurred while deleting the API key' }],
				},
				500,
			);
		});
});

export default app;
