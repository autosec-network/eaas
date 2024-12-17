import { eq, sql } from 'drizzle-orm';
import { Hono } from 'hono';
import { bearerAuth } from 'hono/bearer-auth';
import { bodyLimit } from 'hono/body-limit';
import { contextStorage } from 'hono/context-storage';
import { prettyJSON } from 'hono/pretty-json';
import { endTime, startTime } from 'hono/timing';
import { createHash, timingSafeEqual } from 'node:crypto';
import type { ContextVariables, EnvVars } from '~/types.mjs';
import api1 from '~/v0/index.mjs';
import { DBManager, StaticDatabase } from '~shared/db-core/db.mjs';
import { api_keys_tenants, tenants } from '~shared/db-preview/schemas/root';
import { api_keys, api_keys_keyrings } from '~shared/db-preview/schemas/tenant';
import { BufferHelpers } from '~shared/helpers/buffers.mjs';
import { CryptoHelpers } from '~shared/helpers/crypto.mjs';
import { Helpers } from '~shared/helpers/index.mjs';
import { ApiKeyVersions } from '~shared/types/bw/index.mjs';

const app = new Hono<{ Bindings: EnvVars; Variables: ContextVariables }>();

// Security
app.use('*', async (c, next) => {
	if (new RegExp(/^\/v\d+\/openapi3?\/?$/i).test(c.req.path)) {
		await next();
	} else if (new RegExp(/^\/v\d+\/v\d+\.cf-aig\.openapi\.json$/i).test(c.req.path)) {
		await next();
	} else {
		return bearerAuth({
			/**
			 * Use sha512 (default uses sha256)
			 * Use node crypto for optimization
			 */
			hashFunction: (data: string) => createHash('sha512').update(data).digest('hex'),
			verifyToken: (token) => {
				/**
				 * @link https://base64.guru/standards/base64url
				 */
				const apiTokenFormat = new RegExp(/^\d+\.[a-z\d_-]+\.[a-z\d_-]+$/i);

				startTime(c, 'auth-parse-token');
				if (apiTokenFormat.test(token)) {
					const [version, ak_id_base64url, ak_secret_base64url] = token.split('.') as [ApiKeyVersions, string, string];

					if (version in ApiKeyVersions) {
						return BufferHelpers.uuidConvert(ak_id_base64url).then((ak_id) => {
							endTime(c, 'auth-parse-token');

							startTime(c, 'auth-db-fetch-root');

							return (
								Helpers.isLocal(c.env.CF_VERSION_METADATA)
									? DBManager.getDrizzle(
											{
												accountId: c.env.CF_ACCOUNT_ID,
												apiToken: c.env.CF_API_TOKEN,
												databaseId: StaticDatabase.Root.eaas_root_p,
											},
											c.env.NODE_ENV !== 'production',
										)
									: DBManager.getDrizzle(c.env.EAAS_ROOT, c.env.NODE_ENV !== 'production')
							)
								.select({
									expires: api_keys_tenants.expires,
									t_id: tenants.t_id,
									d1_id: tenants.d1_id,
								})
								.from(api_keys_tenants)
								.innerJoin(tenants, eq(tenants.t_id, api_keys_tenants.t_id))
								.where(eq(api_keys_tenants.ak_id, sql`unhex(${ak_id.hex})`))
								.limit(1)
								.then((rows) =>
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
								)
								.catch((e) => {
									console.error('Unknown root lookup db error', e);
									return false;
								})
								.then(async ([row]) => {
									endTime(c, 'auth-db-fetch-root');

									if (row) {
										if (row.expires >= new Date()) {
											startTime(c, 'auth-db-fetch-tenant');

											let t_db = DBManager.getDrizzle(
												{
													accountId: c.env.CF_ACCOUNT_ID,
													apiToken: c.env.CF_API_TOKEN,
													databaseId: row.d1_id.utf8,
												},
												true,
											);

											if (!Helpers.isLocal(c.env.CF_VERSION_METADATA)) {
												const potentialVipBinding = (await CryptoHelpers.getHash('SHA-256', `t_${row.t_id.utf8}_p`)).toUpperCase();

												if (potentialVipBinding in c.env) {
													t_db = DBManager.getDrizzle(c.env[potentialVipBinding] as D1Database, true);
												}
											}

											return t_db
												.select({
													hash: api_keys.hash,
													r_encrypt: api_keys_keyrings.r_encrypt,
													r_decrypt: api_keys_keyrings.r_decrypt,
													r_rewrap: api_keys_keyrings.r_rewrap,
													r_sign: api_keys_keyrings.r_sign,
													r_verify: api_keys_keyrings.r_verify,
													r_hmac: api_keys_keyrings.r_hmac,
													r_random: api_keys_keyrings.r_random,
													r_hash: api_keys_keyrings.r_hash,
												})
												.from(api_keys)
												.innerJoin(api_keys_keyrings, eq(api_keys_keyrings.ak_id, api_keys.ak_id))
												.where(eq(api_keys.ak_id, sql`unhex(${ak_id.hex})`))
												.then((rows) =>
													Promise.all(
														rows.map((row) => ({
															...row,
															hash: new Uint8Array(row.hash),
														})),
													),
												)
												.catch((e) => {
													console.error('Unknown tenant lookup db error', e);
													return false;
												})
												.then(async ([row]) => {
													endTime(c, 'auth-db-fetch-tenant');

													if (row) {
														startTime(c, 'auth-verify-token');
														const receivedSecret = await BufferHelpers.base64ToBuffer(ak_secret_base64url);
														let calculatedHash: Uint8Array;

														if (version == ApiKeyVersions['256base64urlSha256']) {
															calculatedHash = new Uint8Array(await BufferHelpers.hexToBuffer(await CryptoHelpers.getHash('SHA-256', receivedSecret)));
														} else if (version == ApiKeyVersions['384base64urlSha384']) {
															calculatedHash = new Uint8Array(await BufferHelpers.hexToBuffer(await CryptoHelpers.getHash('SHA-384', receivedSecret)));
														} else if (version == ApiKeyVersions['512base64urlSha512']) {
															calculatedHash = new Uint8Array(await BufferHelpers.hexToBuffer(await CryptoHelpers.getHash('SHA-512', receivedSecret)));
														}

														if (timingSafeEqual(calculatedHash!, row.hash)) {
															endTime(c, 'auth-verify-token');

															c.set('permissions', {
																r_encrypt: row.r_encrypt,
																r_decrypt: row.r_decrypt,
																r_rewrap: row.r_rewrap,
																r_sign: row.r_sign,
																r_verify: row.r_verify,
																r_hmac: row.r_hmac,
																r_random: row.r_random,
																r_hash: row.r_hash,
															});

															return true;
														} else {
															endTime(c, 'auth-verify-token');
															console.error(new Error('Token hash mismatch'));
															return false;
														}
													} else {
														console.error(new Error('Token not found in tenant'));
														return false;
													}
												});
										} else {
											console.error(new Error('Token expired'));
											return false;
										}
									} else {
										console.error(new Error('Token not found in root'));
										return false;
									}
								});
						});
					} else {
						console.error(new Error('Token unknown version '));
						return false;
					}
				} else {
					console.error(new Error('Token fails regex'));
					return false;
				}
			},
		})(c, next);
	}
});
/**
 * Measured in kb
 * Set to just worker memory limit
 * @link https://developers.cloudflare.com/workers/platform/limits/#worker-limits
 */
app.use(
	'*',
	bodyLimit({
		maxSize: 100 * 1024 * 1024,
		onError: (c) => c.json({ success: false, errors: [{ message: 'Content size not supported', extensions: { code: 413 } }] }, 413),
	}),
);

// Performance
app.use('*', contextStorage());

// Debug
app.use('*', prettyJSON());

// All api versions go here
app.route('/v0', api1);

export default app;
