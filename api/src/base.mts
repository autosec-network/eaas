import type { Context } from 'hono';
import type { ContextVariables, EnvVars } from '~/types.mjs';
import type { ApiKeyVersions } from '~shared/types/bw/index.mjs';

const app = await import('hono').then(({ Hono }) => new Hono<{ Bindings: EnvVars; Variables: ContextVariables }>());

// Security
// eslint-disable-next-line @typescript-eslint/no-empty-object-type
export async function verifyToken(token: string, c: Context<{ Bindings: EnvVars; Variables: ContextVariables }, '*', {}>, failExpire: boolean = true) {
	/**
	 * @link https://base64.guru/standards/base64url
	 */
	const apiTokenFormat = new RegExp(/^\d+\.[a-z\d_-]+\.[a-z\d_-]+$/i);

	await import('hono/timing').then(({ startTime }) => startTime(c, 'auth-parse-token'));
	if (apiTokenFormat.test(token)) {
		const [version, ak_id_base64url, ak_secret_base64url] = token.split('.') as [`${ApiKeyVersions}`, string, string];

		const versionExists = await import('~shared/types/bw/index.mjs').then(({ ApiKeyVersions }) => version in ApiKeyVersions);

		if (versionExists) {
			c.set('ak_id', await import('@chainfuse/helpers/buffers').then(({ BufferHelpers }) => BufferHelpers.uuidConvert(ak_id_base64url)));

			await import('hono/timing').then(({ endTime, startTime }) => {
				endTime(c, 'auth-parse-token');
				startTime(c, 'auth-db-fetch-root');
			});

			return Promise.all([import('~shared/db-preview/schemas/root'), import('drizzle-orm')])
				.then(([{ api_keys_tenants, tenants }, { eq, sql }]) =>
					c.var
						.r_db()
						.select({
							expires: api_keys_tenants.expires,
							t_id: tenants.t_id,
							d1_id: tenants.d1_id,
						})
						.from(api_keys_tenants)
						.innerJoin(tenants, eq(tenants.t_id, api_keys_tenants.t_id))
						.where(eq(api_keys_tenants.ak_id, sql`unhex(${c.var.ak_id.hex})`))
						.limit(1),
				)
				.then((rows) =>
					import('@chainfuse/helpers/buffers').then(({ BufferHelpers }) =>
						Promise.all(
							rows.map((row) =>
								Promise.all([BufferHelpers.uuidConvert(row.t_id), BufferHelpers.uuidConvert(row.d1_id)]).then(([t_id, d1_id]) => ({
									...row,
									expires: new Date(row.expires),
									t_id,
									d1_id,
								})),
							),
						),
					),
				)
				.then(async ([row]) => {
					await import('hono/timing').then(({ endTime }) => endTime(c, 'auth-db-fetch-root'));

					if (row) {
						const expired = row.expires < new Date();

						if (expired && failExpire) {
							console.error(new Error('Token expired'));
							return false;
						} else {
							await import('hono/timing').then(({ startTime }) => startTime(c, 'auth-db-fetch-tenant'));

							c.set('t_id', row.t_id);
							c.set('t_d1_id', row.d1_id);
							await import('~shared/db-core/db.mjs').then(({ DBManager }) =>
								c.set('t_db', () =>
									DBManager.getDrizzle(
										{
											accountId: c.env.CF_ACCOUNT_ID,
											apiToken: c.env.CF_API_TOKEN,
											databaseId: row.d1_id.utf8,
										},
										{
											logger: c.env.NODE_ENV !== 'production',
										},
									),
								),
							);

							await Promise.all([import('@chainfuse/helpers/common'), import('@chainfuse/helpers/crypto')]).then(async ([{ Helpers }, { CryptoHelpers }]) => {
								if (!Helpers.isLocal(c.env.CF_VERSION_METADATA)) {
									const potentialVipBinding = (await CryptoHelpers.getHash('SHA-256', `t_${row.t_id.utf8}${c.env.NODE_ENV !== 'production' && '_p'}`)).toUpperCase();

									if (potentialVipBinding in c.env) {
										if (!c.var.t_db_session) c.set('t_db_session', (c.env[potentialVipBinding] as D1Database).withSession('first-unconstrained'));

										await import('~shared/db-core/db.mjs').then(({ DBManager }) => c.set('t_db', () => DBManager.getDrizzle((c.env[potentialVipBinding] as D1Database).withSession(c.var.t_db_session.getBookmark() ?? 'first-unconstrained'), { logger: c.env.NODE_ENV !== 'production' })));
									}
								}
							});

							return Promise.all([import('~shared/db-preview/schemas/tenant'), import('drizzle-orm')])
								.then(([{ api_keys }, { eq, sql }]) =>
									c.var
										.t_db()
										.select({
											hash: api_keys.hash,
											r_keyrings: api_keys.r_keyrings,
											r_apikeys: api_keys.r_apikeys,
										})
										.from(api_keys)
										.limit(1)
										.where(eq(api_keys.ak_id, sql`unhex(${c.var.ak_id.hex})`)),
								)
								.then(async ([hashRow]) => {
									if (hashRow) {
										await import('hono/timing').then(({ startTime }) => startTime(c, 'auth-verify-token'));
										const receivedSecret = await import('@chainfuse/helpers/buffers').then(({ BufferHelpers }) => BufferHelpers.base64ToBuffer(ak_secret_base64url));
										let calculatedHash: Uint8Array;

										await Promise.all([import('~shared/types/bw/index.mjs'), import('@chainfuse/helpers/buffers'), import('@chainfuse/helpers/crypto')]).then(async ([{ ApiKeyVersions }, { BufferHelpers }, { CryptoHelpers }]) => {
											switch (parseInt(version)) {
												case ApiKeyVersions['256base64urlSha256']:
													calculatedHash = new Uint8Array(await BufferHelpers.hexToBuffer(await CryptoHelpers.getHash('SHA-256', receivedSecret)));
													break;
												case ApiKeyVersions['384base64urlSha384']:
													calculatedHash = new Uint8Array(await BufferHelpers.hexToBuffer(await CryptoHelpers.getHash('SHA-384', receivedSecret)));
													break;
												case ApiKeyVersions['512base64urlSha512']:
													calculatedHash = new Uint8Array(await BufferHelpers.hexToBuffer(await CryptoHelpers.getHash('SHA-512', receivedSecret)));
													break;
											}
										});

										const hashCheck = await import('node:crypto').then(({ timingSafeEqual }) => timingSafeEqual(calculatedHash!, new Uint8Array(hashRow.hash)));
										await import('hono/timing').then(({ endTime }) => endTime(c, 'auth-verify-token'));

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
										await Promise.all([import('~shared/db-preview/schemas/tenant'), import('drizzle-orm')])
											.then(([{ api_keys, keyrings, api_keys_keyrings }, { eq, sql }]) =>
												c.var
													.t_db()
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
													.where(eq(api_keys.ak_id, sql`unhex(${c.var.ak_id.hex})`)),
											)
											.then((rows) =>
												import('@chainfuse/helpers/buffers').then(({ BufferHelpers }) =>
													Promise.all(
														rows.map((row) =>
															BufferHelpers.uuidConvert(row.kr_id).then((kr_id) => ({
																...row,
																kr_id,
															})),
														),
													),
												),
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

									await import('hono/timing').then(({ endTime }) => endTime(c, 'auth-db-fetch-tenant'));

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
				//OpenAPI Schema
				'/:version/generate/openapi',
				// OpenApi 3.1 Schema
				'/:version/generate/openapi31',
				// OpenAPI Schema for CF API Gateway
				'/:version/generate/v0.cf-aig.openapi',
				// LLMs.txt
				'/:version/generate/llms',
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
		)(c, next),
	),
);

/**
 * Measured in kb
 * Set to just worker memory limit
 * @link https://developers.cloudflare.com/workers/platform/limits/#worker-limits
 */
app.use('*', (c, next) =>
	import('hono/body-limit').then(({ bodyLimit }) =>
		bodyLimit({
			maxSize: 100 * 1024 * 1024,
			onError: (c) => c.json({ success: false, errors: [{ message: 'Content size not supported' }] }, 413),
		})(c, next),
	),
);

// Shared storage
app.use('*', (c, next) => import('hono/context-storage').then(({ contextStorage }) => contextStorage()(c, next)));

// Debug
app.use('*', (c, next) => import('hono/pretty-json').then(({ prettyJSON }) => prettyJSON()(c, next)));

// All api versions go here
await import('~/v0/index.mjs').then(({ default: api0 }) => app.route('/v0', api0));

export default app;
