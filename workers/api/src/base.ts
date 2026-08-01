import { SQLCache } from 'db/cache';
import { DebugLogWriter, drizzleD0 } from 'db/core';
import * as rootSchema from 'db/schemas/root';
import * as tenantSchema from 'db/schemas/tenant/main';
import { DefaultLogger } from 'drizzle-orm/logger';
import { eq, sql } from 'drizzle-orm/sql';
import { Hono, type Context } from 'hono';
import { bearerAuth } from 'hono/bearer-auth';
import { except } from 'hono/combine';
import { prettyJSON } from 'hono/pretty-json';
import { endTime, startTime } from 'hono/timing';
import { Buffer } from 'node:buffer';
import { createHash, timingSafeEqual } from 'node:crypto';
import { ApiKeyVersions } from 'types/bw';
import { problemJson } from '~/errors';
import type { BufferExport, ContextVariables, EnvVars } from '~/types';
import api0 from '~/v0/index';

const app = new Hono<{ Bindings: EnvVars; Variables: ContextVariables }>();

// Security
// eslint-disable-next-line @typescript-eslint/no-empty-object-type
export async function verifyToken(token: string, c: Context<{ Bindings: EnvVars; Variables: ContextVariables }, '*', {}>, failExpire: boolean = true) {
	/**
	 * @link z.regexes.base64url
	 */
	const apiTokenFormat = new RegExp(/^ase_\d+\.[a-z\d_-]+\.[a-z\d_-]+$/i);

	if (apiTokenFormat.test(token)) {
		const [versionPart, ak_id_base64url, ak_secret_base64url] = token.split('.') as [`ase_${ApiKeyVersions}`, string, string];
		const version = versionPart.slice('ase_'.length) as `${ApiKeyVersions}`;
		const versionExists = version in ApiKeyVersions;

		if (versionExists) {
			const ak_id_buffer = Buffer.from(ak_id_base64url, 'base64url');

			c.set('ak_id', {
				buffer: ak_id_buffer,
				hex: ak_id_buffer.toString('hex'),
				base64: ak_id_buffer.toString('base64'),
				base64url: ak_id_base64url,
			});

			startTime(c, 'auth-r_db-fetch');
			const [rootApiKey] = await c.var.r_db
				.select({
					expires: rootSchema.api_keys_tenants.expires,
					enabled: rootSchema.api_keys_tenants.enabled,
					t_id: rootSchema.tenants.t_id,
					jurisdiction: rootSchema.tenants.jurisdiction,
					do_id: rootSchema.tenants.do_id,
				})
				.from(rootSchema.api_keys_tenants)
				.innerJoin(rootSchema.tenants, eq(rootSchema.tenants.t_id, rootSchema.api_keys_tenants.t_id))
				.where(eq(rootSchema.api_keys_tenants.ak_id, sql<Buffer>`unhex(${c.var.ak_id.hex})`))
				.limit(1)
				.then((rows) =>
					rows.map((row) => ({
						...row,
						t_id: {
							buffer: row.t_id,
							hex: row.t_id.toString('hex'),
							base64: row.t_id.toString('base64'),
							base64url: row.t_id.toString('base64url'),
						} satisfies BufferExport,
						do_id: row.do_id.toString('hex'),
					})),
				);
			endTime(c, 'auth-r_db-fetch', 3);

			if (rootApiKey) {
				if (!rootApiKey.enabled) {
					console.error(new Error('Token disabled'));
					return false;
				}

				const expired = rootApiKey.expires < new Date();

				if (expired && failExpire) {
					console.error(new Error('Token expired'));
					return false;
				} else {
					c.set('t_id', rootApiKey.t_id);
					c.set('t_do_id', rootApiKey.do_id);
					c.set('t_jurisdiction', rootApiKey.jurisdiction);
					const doId = rootApiKey.jurisdiction ? c.env.TENANT_D0.jurisdiction(rootApiKey.jurisdiction).idFromString(rootApiKey.do_id) : c.env.TENANT_D0.idFromString(rootApiKey.do_id);
					c.set(
						't_db',
						drizzleD0(c.env.TENANT_D0.get(doId), {
							// ...(c.env.NODE_ENV !== 'production' && { logger: new DefaultLogger({ writer: new DebugLogWriter(row.do_id) }) }),
							logger: new DefaultLogger({ writer: new DebugLogWriter(rootApiKey.do_id) }),
							cache: new SQLCache({
								dbName: rootApiKey.do_id,
								dbType: 'do',
								strategy: c.var.browserCache ? 'all' : 'explicit',
								cacheTTL: parseInt(c.env.SQL_TTL, 10),
								logging: c.env.NODE_ENV !== 'production',
							}),
						}),
					);

					startTime(c, 'auth-t_db-fetch');
					const [tenantApiKey] = await c.var.t_db
						.select({
							hash: tenantSchema.api_keys.hash,
							enabled: tenantSchema.api_keys.enabled,
							r_keyrings: tenantSchema.api_keys.r_keyrings,
							r_apikeys: tenantSchema.api_keys.r_apikeys,
						})
						.from(tenantSchema.api_keys)
						.where(eq(tenantSchema.api_keys.ak_id, sql<Buffer>`unhex(${c.var.ak_id.hex})`))
						.limit(1);
					endTime(c, 'auth-t_db-fetch', 3);

					if (tenantApiKey) {
						if (!tenantApiKey.enabled) {
							console.error(new Error('Token disabled'));
							return false;
						}

						const receivedSecret = Buffer.from(ak_secret_base64url, 'base64url');
						let calculatedHash: Uint8Array;

						// eslint-disable-next-line @typescript-eslint/no-unnecessary-type-assertion
						switch (parseInt(version) as ApiKeyVersions) {
							case ApiKeyVersions['256base64urlSha256']:
								calculatedHash = createHash('sha256').update(receivedSecret).digest();
								break;
							case ApiKeyVersions['384base64urlSha384']:
								calculatedHash = createHash('sha384').update(receivedSecret).digest();
								break;
							case ApiKeyVersions['512base64urlSha512']:
								calculatedHash = createHash('sha512').update(receivedSecret).digest();
								break;
						}

						const hashCheck = timingSafeEqual(calculatedHash, tenantApiKey.hash);

						if (!hashCheck) console.error(new Error('Token hash mismatch'));

						// Don't return anything if hash check fails
						if (hashCheck) {
							c.set('globalPermissions', {
								// Return 0 regardless of actual permission if expired
								r_keyrings: expired ? 0 : tenantApiKey.r_keyrings,
								r_apikeys: expired ? 0 : tenantApiKey.r_apikeys,
							});
						}

						// Set base
						c.set('permissions', {});

						// Don't even try to fetch on bad hash
						if (!expired && hashCheck) {
							startTime(c, 'auth-t_db-fetch-keyrings');
							await c.var.t_db
								.select({
									kr_id: tenantSchema.api_keys_keyrings.kr_id,
									kr_name: tenantSchema.keyrings.name,
									generation_versions: tenantSchema.keyrings.generation_versions,
									retreival_versions: tenantSchema.keyrings.retreival_versions,
									r_datakeys: tenantSchema.api_keys_keyrings.r_datakeys,
									r_encrypt: tenantSchema.api_keys_keyrings.r_encrypt,
									r_decrypt: tenantSchema.api_keys_keyrings.r_decrypt,
									r_rewrap: tenantSchema.api_keys_keyrings.r_rewrap,
									r_sign: tenantSchema.api_keys_keyrings.r_sign,
									r_verify: tenantSchema.api_keys_keyrings.r_verify,
									r_hmac: tenantSchema.api_keys_keyrings.r_hmac,
								})
								.from(tenantSchema.api_keys_keyrings)
								.innerJoin(tenantSchema.api_keys, eq(tenantSchema.api_keys.ak_id, tenantSchema.api_keys_keyrings.ak_id))
								.innerJoin(tenantSchema.keyrings, eq(tenantSchema.keyrings.kr_id, tenantSchema.api_keys_keyrings.kr_id))
								.where(eq(tenantSchema.api_keys.ak_id, sql<Buffer>`unhex(${c.var.ak_id.hex})`))
								.then((rows) =>
									rows.map((row) => ({
										...row,
										kr_id: {
											buffer: row.kr_id,
											hex: row.kr_id.toString('hex'),
											base64: row.kr_id.toString('base64'),
											base64url: row.kr_id.toString('base64url'),
										} satisfies BufferExport,
									})),
								)
								.then((rows) =>
									rows.forEach(({ kr_id, ...row }) => {
										c.set('permissions', {
											...c.var.permissions,
											[kr_id.base64url]: row,
										});
									}),
								);
							endTime(c, 'auth-t_db-fetch-keyrings', 3);
						}

						return hashCheck;
					} else {
						console.error(new Error('Token not found in tenant'));
						return false;
					}
				}
			} else {
				console.error(new Error('Token not found in root'));
				return false;
			}
		} else {
			console.error(new Error('Token unknown version '));
			return false;
		}
	} else {
		console.error(new Error('Token fails regex'));
		return false;
	}
}
app.use(
	'*',
	except(
		[
			// OpenAPI Schemas
			'/:version/generate/*',
			// Has it's own auth check
			'/:version/gss/*',
			'/:version/apikeys/*',
			// Free (non-gated)
			'/:version/random',
			'/:version/hash/:algorithm?',
			'/:version/stats/*',
		],
		bearerAuth({
			/**
			 * Use sha512 (default uses sha256)
			 * Use node crypto for optimization
			 */
			hashFunction: (data: string) => createHash('sha512').update(data).digest('hex'),
			verifyToken,
		}),
	),
);

// Debug
app.use('*', prettyJSON());

// Global error handler — RFC 9457
app.onError((err, c) => {
	console.error(err);
	return problemJson(c, 500, { detail: err.message, errors: [err] });
});

// All api versions go here
app.route('/v0', api0);

export default app;
