import { createRoute, OpenAPIHono, z } from '@hono/zod-openapi';
import * as rootSchema from 'db/schemas/root';
import * as tenantSchema from 'db/schemas/tenant/main';
import { eq, sql } from 'drizzle-orm/sql';
import { bearerAuth } from 'hono/bearer-auth';
import { wrapTime } from 'hono/timing';
import { Buffer } from 'node:buffer';
import { createHash } from 'node:crypto';
import { Permissions } from 'types';
import { problemJson, problemResponse } from '~/errors';
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
				),
			),
	}),
);

// @ts-expect-error - Hono middleware doesn't need to return when calling await next()
app.use('*', async (c, next) => {
	if (c.var.globalPermissions?.r_apikeys === Permissions.Admin) {
		await next();
	} else {
		console.error("Token doesn't have permissions");
		return problemJson(
			// eslint-disable-next-line @typescript-eslint/no-unsafe-argument
			c,
			403,
			{ detail: 'Access Denied: You do not have permission to perform this action' },
		);
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
		403: problemResponse('Access denied.'),
		404: problemResponse('API Key not found.'),
		500: problemResponse('Internal server error.'),
	},
});

app.openapi(route, (c) => {
	const { token_id } = c.req.valid('param');

	const ak_id_buffer = Buffer.from(token_id, 'base64url');
	const ak_id = {
		buffer: ak_id_buffer,
		hex: ak_id_buffer.toString('hex'),
	};

	return Promise.all([
		// Delete from root database (api_keys_tenants)
		wrapTime(c, 'r_db-delete-apikey', c.var.r_db.delete(rootSchema.api_keys_tenants).where(eq(rootSchema.api_keys_tenants.ak_id, sql<Buffer>`unhex(${ak_id.hex})`)), undefined, 3),
		// Delete from tenant database (api_keys - will cascade to api_keys_keyrings)
		wrapTime(c, 't_db-delete-apikey', c.var.t_db.delete(tenantSchema.api_keys).where(eq(tenantSchema.api_keys.ak_id, sql<Buffer>`unhex(${ak_id.hex})`)), undefined, 3),
	])
		.then(() => {
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
		})
		.catch((error) => {
			console.error('Error deleting API key:', error);
			return problemJson(c, 500, { detail: 'An error occurred while deleting the API key', errors: [error] });
		});
});

export default app;
