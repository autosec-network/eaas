import { Hono, type Context } from 'hono';
import { endTime, startTime } from 'hono/timing';
import type { Buffer } from 'node:buffer';
import { ApiKeyVersions } from 'types/bw';
import type { BufferExport, ContextVariables, EnvVars } from '~/types.mjs';
import api0 from '~/v0/index.mjs';

const app = new Hono<{ Bindings: EnvVars; Variables: ContextVariables }>();

// Security
// eslint-disable-next-line @typescript-eslint/no-empty-object-type
export async function verifyToken(token: string, c: Context<{ Bindings: EnvVars; Variables: ContextVariables }, '*', {}>, failExpire: boolean = true) {
	/**
	 * @link z.regexes.base64url
	 */
	const apiTokenFormat = new RegExp(/^\d+\.[a-z\d_-]+\.[a-z\d_-]+$/i);

	if (apiTokenFormat.test(token)) {
		const [version, ak_id_base64url, ak_secret_base64url] = token.split('.') as [`${ApiKeyVersions}`, string, string];
		const versionExists = version in ApiKeyVersions;

		if (versionExists) {
			const ak_id_buffer = await import('node:buffer').then(({ Buffer }) => Buffer.from(ak_id_base64url, 'base64url'));
			c.set('ak_id', {
				buffer: ak_id_buffer,
				hex: ak_id_buffer.toString('hex'),
				base64: ak_id_buffer.toString('base64'),
				base64url: ak_id_base64url,
			});

			startTime(c, 'auth-db-fetch-root');

			return Promise.all([import('db/schemas/root'), import('drizzle-orm/sql')])
				.then(([{ api_keys_tenants, tenants }, { eq, sql }]) =>
					c.var.r_db
						.select({
							expires: api_keys_tenants.expires,
							t_id: tenants.t_id,
							do_id: tenants.do_id,
						})
						.from(api_keys_tenants)
						.innerJoin(tenants, eq(tenants.t_id, api_keys_tenants.t_id))
						.where(eq(api_keys_tenants.ak_id, sql<Buffer>`unhex(${c.var.ak_id.hex})`))
						.limit(1),
				)
				.then((rows) =>
					rows.map((row) => ({
						...row,
						expires: new Date(row.expires),
						t_id: {
							buffer: row.t_id,
							hex: row.t_id.toString('hex'),
							base64: row.t_id.toString('base64'),
							base64url: row.t_id.toString('base64url'),
						} satisfies BufferExport,
						do_id: {
							buffer: row.do_id,
							hex: row.do_id.toString('hex'),
							base64: row.do_id.toString('base64'),
							base64url: row.do_id.toString('base64url'),
						} satisfies BufferExport,
					})),
				)
				.then(async ([row]) => {
					endTime(c, 'auth-db-fetch-root');

					if (row) {
						const expired = row.expires < new Date();

						if (expired && failExpire) {
							console.error(new Error('Token expired'));
							return false;
						} else {
							startTime(c, 'auth-db-fetch-tenant');

							c.set('t_id', row.t_id);
							c.set('t_do_id', row.do_id);
							c.set(
								't_db',
								await import('db').then(async ({ drizzleD0 }) =>
									drizzleD0(c.env.TENANT_D0.getByName(row.do_id.hex), {
										...(c.env.NODE_ENV !== 'production' && { logger: await import('drizzle-orm/logger').then(async ({ DefaultLogger }) => new DefaultLogger({ writer: await import('db').then(({ DebugLogWriter }) => new DebugLogWriter(row.do_id.hex)) })) }),
										schema: await import('db/schemas/root'),
										casing: 'snake_case',
										cache: await import('helpers/db').then(
											({ SQLCache }) =>
												new SQLCache({
													dbName: row.do_id.hex,
													dbType: 'do',
													strategy: 'all',
													cacheTTL: parseInt(c.env.SQL_TTL, 10),
													logging: c.env.NODE_ENV !== 'production',
												}),
										),
									}),
								),
							);

							return Promise.all([import('db/schemas/tenant'), import('drizzle-orm/sql')])
								.then(([{ api_keys }, { eq, sql }]) =>
									c.var.t_db
										.select({
											hash: api_keys.hash,
											r_keyrings: api_keys.r_keyrings,
											r_apikeys: api_keys.r_apikeys,
										})
										.from(api_keys)
										.limit(1)
										.where(eq(api_keys.ak_id, sql<Buffer>`unhex(${c.var.ak_id.hex})`)),
								)
								.then(async ([hashRow]) => {
									if (hashRow) {
										startTime(c, 'auth-verify-token');
										const receivedSecret = await import('node:buffer').then(({ Buffer }) => Buffer.from(ak_secret_base64url, 'base64url'));
										let calculatedHash: Uint8Array;

										switch (parseInt(version) as ApiKeyVersions) {
											case ApiKeyVersions['256base64urlSha256']:
												calculatedHash = await import('node:crypto').then(({ createHash }) => createHash('sha256').update(receivedSecret).digest());
												break;
											case ApiKeyVersions['384base64urlSha384']:
												calculatedHash = await import('node:crypto').then(({ createHash }) => createHash('sha384').update(receivedSecret).digest());
												break;
											case ApiKeyVersions['512base64urlSha512']:
												calculatedHash = await import('node:crypto').then(({ createHash }) => createHash('sha512').update(receivedSecret).digest());
												break;
										}

										const hashCheck = await import('node:crypto').then(({ timingSafeEqual }) => timingSafeEqual(calculatedHash!, hashRow.hash));
										endTime(c, 'auth-verify-token');

										if (!hashCheck) console.error(new Error('Token hash mismatch'));

										// Don't return anything if hash check fails
										if (hashCheck) {
											c.set('globalPermissions', {
												// Return 0 regardless of actual permission if expired
												r_keyrings: expired ? 0 : hashRow.r_keyrings,
												r_apikeys: expired ? 0 : hashRow.r_apikeys,
											});
										}

										return hashCheck;
									} else {
										console.error(new Error('Token not found in tenant'));
										return false;
									}
								})
								.then(async (hashCheck) => {
									// Don't even try to fetch on bad hash
									if (!expired && hashCheck) {
										await Promise.all([import('db/schemas/tenant'), import('drizzle-orm/sql')])
											.then(([{ api_keys_keyrings, keyrings, api_keys }, { eq, sql }]) =>
												c.var.t_db
													.select({
														kr_id: api_keys_keyrings.kr_id,
														kr_name: keyrings.name,
														generation_versions: keyrings.generation_versions,
														retreival_versions: keyrings.retreival_versions,
														r_datakeys: api_keys_keyrings.r_datakeys,
														r_encrypt: api_keys_keyrings.r_encrypt,
														r_decrypt: api_keys_keyrings.r_decrypt,
														r_rewrap: api_keys_keyrings.r_rewrap,
														r_sign: api_keys_keyrings.r_sign,
														r_verify: api_keys_keyrings.r_verify,
														r_hmac: api_keys_keyrings.r_hmac,
													})
													.from(api_keys_keyrings)
													.innerJoin(api_keys, eq(api_keys.ak_id, api_keys_keyrings.ak_id))
													.innerJoin(keyrings, eq(keyrings.kr_id, api_keys_keyrings.kr_id))
													.where(eq(api_keys.ak_id, sql<Buffer>`unhex(${c.var.ak_id.hex})`)),
											)
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
									} else {
										c.set('permissions', {});
									}

									endTime(c, 'auth-db-fetch-tenant');

									return hashCheck;
								});
						}
					} else {
						console.error(new Error('Token not found in root'));
						return false;
					}
				});
		} else {
			console.error(new Error('Token unknown version '));
			return false;
		}
	} else {
		console.error(new Error('Token fails regex'));
		return false;
	}
}
app.use('*', (c, next) =>
	Promise.all([import('hono/combine'), import('hono/bearer-auth'), import('node:crypto')]).then(([{ except }, { bearerAuth }, { createHash }]) =>
		except(
			[
				// OpenAPI Schemas
				'/:version/generate/*',
				// Has it's own auth check
				'/:version/apikeys',
				// Free (non-gated)
				'/:version/random',
				'/:version/hash/:algorithm?',
			],
			bearerAuth({
				/**
				 * Use sha512 (default uses sha256)
				 * Use node crypto for optimization
				 */
				hashFunction: (data: string) => createHash('sha512').update(data).digest('hex'),
				verifyToken,
			}),
		)(
			// eslint-disable-next-line @typescript-eslint/no-unsafe-argument
			c,
			next,
		),
	),
);

// Debug
app.use('*', (c, next) =>
	import('hono/pretty-json').then(({ prettyJSON }) =>
		prettyJSON()(
			// eslint-disable-next-line @typescript-eslint/no-unsafe-argument
			c,
			next,
		),
	),
);

// All api versions go here
app.route('/v0', api0);

export default app;
