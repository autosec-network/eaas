#!/usr/bin/env -S npx tsx
import { stringify } from '@iarna/toml';
import type { DatabaseCreateParams } from 'cloudflare/resources/d1/database.mjs';
import { eq, sql } from 'drizzle-orm';
import { exec } from 'node:child_process';
import { unlink, writeFile } from 'node:fs/promises';
import { promisify } from 'node:util';
import yargs from 'yargs';
import { hideBin } from 'yargs/helpers';
import { DBManager, StaticDatabase } from '../shared/db-core/db.mjs';
import type { CliWranglerConfig } from '../shared/db-core/types.mjs';
import { api_keys_tenants, tenants } from '../shared/db-preview/schemas/root';
import { api_keys, api_keys_keyrings, keyrings, properties } from '../shared/db-preview/schemas/tenant';
import { BufferHelpers } from '../shared/helpers/buffers.mjs';
import { CryptoHelpers } from '../shared/helpers/crypto.mjs';
import { NetHelpers } from '../shared/helpers/net.mjs';
import { ApiKeyVersions, BaseBitwardenServer } from '../shared/types/bw/index.mjs';
import { KeyAlgorithms } from '../shared/types/crypto/index.mjs';
import { workersCryptoCatalog } from '../shared/types/crypto/workers-crypto-catalog.mjs';
import type { D1Blob, PrefixedUuid, UuidExport } from '../shared/types/d1/index.mjs';

const { CF_ACCOUNT_ID, CICD_CF_API_TOKEN } = process.env;

function createTempWranglerConfig(name: PrefixedUuid, d1_id: UuidExport['utf8']): CliWranglerConfig {
	return {
		account_id: CF_ACCOUNT_ID!,
		d1_databases: [
			{
				// Binding never has suffix
				binding: name.replace('_p', ''),
				database_name: name,
				database_id: d1_id,
				migrations_dir: `shared/db-preview/schemas/tenant`,
			},
		],
	};
}

yargs(hideBin(process.argv))
	.command(
		'createTenant',
		'Generate new tenant',
		(yargs) =>
			yargs
				.option('name', {
					alias: 'n',
					type: 'string',
				})
				.demandOption('name')
				.option('location_hint', {
					alias: 'lh',
					/**
					 * @link https://developers.cloudflare.com/d1/configuration/data-location/#available-location-hints
					 */
					choices: ['wnam', 'enam', 'weur', 'eeur', 'apac', 'oc'],
				}),
		(args) =>
			BufferHelpers.generateUuid.then((t_id) =>
				NetHelpers.cfApi(CICD_CF_API_TOKEN!)
					.d1.database.create({
						account_id: CF_ACCOUNT_ID!,
						name: `t_${t_id.utf8}_p`,
						...(args.location_hint && { primary_location_hint: args.location_hint as Exclude<DatabaseCreateParams['primary_location_hint'], undefined> }),
					})
					.then(async (d1CreateResponse) => {
						console.log(d1CreateResponse, (await CryptoHelpers.getHash('SHA-256', d1CreateResponse.name!)).toUpperCase());
						return d1CreateResponse;
					})
					.then((d1CreateResponse) => {
						const { name } = d1CreateResponse;
						const tenantWranglerConfig: CliWranglerConfig = createTempWranglerConfig(name as PrefixedUuid, d1CreateResponse.uuid as UuidExport['utf8']);

						return CryptoHelpers.getHash('SHA-256', stringify(tenantWranglerConfig)).then((tenantWranglerHashPrefix) => {
							return Promise.allSettled([
								writeFile(`${tenantWranglerHashPrefix}.wrangler.toml`, stringify(tenantWranglerConfig), 'utf8')
									.then(() =>
										promisify(exec)(['wrangler', 'd1', 'migrations', 'apply', '--config', `${tenantWranglerHashPrefix}.wrangler.toml`, tenantWranglerConfig.d1_databases[0]!.binding, '--remote'].join(' '), {
											env: {
												...process.env,
												CLOUDFLARE_ACCOUNT_ID: CF_ACCOUNT_ID!,
												CLOUDFLARE_API_TOKEN: CICD_CF_API_TOKEN!,
											},
										})
											.then(({ stdout, stderr }) => {
												console.log(stdout);
												console.error(stderr);
											})
											.catch(console.error),
									)
									.finally(() => unlink(`${tenantWranglerHashPrefix}.wrangler.toml`)),
								BufferHelpers.uuidConvert(d1CreateResponse.uuid as UuidExport['utf8']).then((converted_d1_id) =>
									DBManager.getDrizzle(
										{
											accountId: CF_ACCOUNT_ID!,
											apiToken: CICD_CF_API_TOKEN!,
											databaseId: StaticDatabase.Root.eaas_root_p,
										},
										true,
									)
										.insert(tenants)
										.values({
											t_id: sql`unhex(${t_id.hex})`,
											d1_id: sql`unhex(${converted_d1_id.hex})`,
										})
										.then(() => converted_d1_id),
								),
							])
								.then(([, converted_d1_id]) => {
									if (converted_d1_id.status === 'fulfilled') {
										return DBManager.getDrizzle(
											{
												accountId: CF_ACCOUNT_ID!,
												apiToken: CICD_CF_API_TOKEN!,
												databaseId: converted_d1_id.value.utf8,
											},
											true,
										)
											.insert(properties)
											.values({
												t_id: sql`unhex(${t_id.hex})`,
												d1_id: sql`unhex(${converted_d1_id.value.hex})`,
												name: args.name,
												// @ts-expect-error types not yet updated
												bw_url: (d1CreateResponse['created_in_region'] as 'wnam' | 'enam' | 'weur' | 'eeur' | 'apac' | 'oc').toLowerCase().endsWith('nam') ? BaseBitwardenServer[0] : BaseBitwardenServer[1],
											});
									} else {
										return;
									}
								})
								.catch((reason) =>
									NetHelpers.cfApi(CICD_CF_API_TOKEN!)
										.d1.database.delete(d1CreateResponse.uuid!, { account_id: CF_ACCOUNT_ID! })
										.catch((d1DeleteReason) => {
											const message = `Failed to setup, also failed to roll back orphaned D1 ${name} (${d1CreateResponse.uuid})`;
											console.error(new Error(message, { cause: d1DeleteReason }));
										})
										.then(() => {
											const message = 'Failed to setup, successfully rolled back orphaned D1 creation';
											console.warn(new Error(message, { cause: reason }));
										}),
								);
						});
					}),
			),
	)
	.command(
		'createKeyring',
		'Generate a new keyring',
		(yargs) =>
			yargs
				.option('t_id', {
					alias: 't',
					description: 'tenant uuid (with or without hyphens and/or prefixes and/or suffixes)',
					type: 'string',
					coerce: (t_id: string) => BufferHelpers.uuidConvert(t_id),
				})
				.demandOption('t_id')
				.option('name', {
					alias: 'n',
					type: 'string',
				})
				.demandOption('name')
				.option('key_type', {
					choices: Object.values(KeyAlgorithms),
				})
				.demandOption('key_type')
				.option('key_size', {
					type: 'number',
				})
				.option('hash', {
					type: 'string',
					choices: workersCryptoCatalog.hashes,
				})
				.demandOption('hash')
				.option('count_rotation', {
					description: 'Number of encryptions before triggering key rotation. Defaults to 2^32',
					type: 'number',
					default: 2 ** 32,
				}),
		(args) =>
			Promise.all([args.t_id, BufferHelpers.generateUuid]).then(([t_id, kr_id]) =>
				DBManager.getDrizzle(
					{
						accountId: CF_ACCOUNT_ID!,
						apiToken: CICD_CF_API_TOKEN!,
						databaseId: StaticDatabase.Root.eaas_root_p,
					},
					true,
				)
					.select({
						d1_id: tenants.d1_id,
					})
					.from(tenants)
					.where(eq(tenants.t_id, sql`unhex(${t_id.hex})`))
					.limit(1)
					.then((rows) =>
						Promise.all(
							rows.map(async (row) => ({
								...row,
								d1_id: await BufferHelpers.uuidConvert(row.d1_id),
							})),
						),
					)
					.then(([row]) => {
						if (row) {
							const count_rotation = BigInt(args.count_rotation).toString(16);

							return (
								DBManager.getDrizzle(
									{
										accountId: CF_ACCOUNT_ID!,
										apiToken: CICD_CF_API_TOKEN!,
										databaseId: row.d1_id.utf8,
									},
									true,
								)
									.insert(keyrings)
									// @ts-expect-error
									.values({
										kr_id: sql<D1Blob>`unhex(${kr_id.hex})`,
										name: args.name,
										key_type: args.key_type,
										key_size: args.key_size,
										hash: args.hash,
										count_rotation: sql<D1Blob>`unhex(${count_rotation.length % 2 === 0 ? count_rotation : `0${count_rotation}`})`,
									})
									.returning()
									.then(console.log)
							);
						}
					}),
			),
	)
	.command(
		'createApikey',
		'Generate a new api key',
		(yargs) =>
			yargs
				.option('t_id', {
					alias: 't',
					description: 'tenant uuid (with or without hyphens and/or prefixes and/or suffixes)',
					type: 'string',
					coerce: (t_id: string) => BufferHelpers.uuidConvert(t_id),
				})
				.demandOption('t_id')
				.option('kr_id', {
					alias: 'kr',
					description: 'keyring uuid (with or without hyphens)',
					type: 'string',
					coerce: (kr_id: string) => BufferHelpers.uuidConvert(kr_id),
				})
				.demandOption('kr_id')
				.option('name', {
					alias: 'n',
					type: 'string',
				})
				.demandOption('name')
				.option('expires', {
					alias: 'e',
					description: 'Date and/or time when key should expires. Defaults to 90 days from now',
					type: 'string',
					coerce: (expires: string) => new Date(expires),
					// days * hours * minutes * seconds * milliseconds
					default: new Date(Date.now() + 90 * 24 * 60 * 60 * 1000),
				})
				.option('encrypt', {
					type: 'boolean',
					default: api_keys_keyrings.r_encrypt.default,
				})
				.option('decrypt', {
					type: 'boolean',
					default: api_keys_keyrings.r_decrypt.default,
				})
				.option('rewrap', {
					type: 'boolean',
					default: api_keys_keyrings.r_rewrap.default,
				})
				.option('sign', {
					type: 'boolean',
					default: api_keys_keyrings.r_sign.default,
				})
				.option('verify', {
					type: 'boolean',
					default: api_keys_keyrings.r_verify.default,
				})
				.option('hmac', {
					type: 'boolean',
					default: api_keys_keyrings.r_hmac.default,
				})
				.option('random', {
					type: 'boolean',
					default: api_keys_keyrings.r_random.default,
				})
				.option('hash', {
					type: 'boolean',
					default: api_keys_keyrings.r_hash.default,
				}),
		(args) =>
			Promise.all([args.t_id, args.kr_id, BufferHelpers.generateUuid, CryptoHelpers.secretBytes(512 / 8)]).then(([t_id, kr_id, ak_id, ak_secret]) =>
				// Hono's bearerAuth only accepts url safe characters
				Promise.all([BufferHelpers.bufferToBase64(ak_secret.buffer, true), CryptoHelpers.getHash('SHA-512', ak_secret.buffer)]).then(async ([ak_secret_base64url, ak_secret_hash]) => {
					console.log('Bearer', [ApiKeyVersions['512base64urlSha512'], ak_id.base64url, ak_secret_base64url].join('.'));
					console.log('Raw', ApiKeyVersions['512base64urlSha512'], (await BufferHelpers.uuidConvert(ak_id.base64)).utf8, Buffer.from(ak_secret_hash).toString('utf-8'));

					const r_db = DBManager.getDrizzle(
						{
							accountId: CF_ACCOUNT_ID!,
							apiToken: CICD_CF_API_TOKEN!,
							databaseId: StaticDatabase.Root.eaas_root_p,
						},
						true,
					);

					return r_db
						.batch([
							r_db
								.select({
									d1_id: tenants.d1_id,
								})
								.from(tenants)
								.where(eq(tenants.t_id, sql`unhex(${t_id.hex})`))
								.limit(1),
							r_db
								.insert(api_keys_tenants)
								.values({
									ak_id: sql`unhex(${ak_id.hex})`,
									t_id: sql`unhex(${t_id.hex})`,
									expires: args.expires.toISOString(),
								})
								.returning(),
						])
						.then(([rows, insert]) => {
							console.log(insert);

							return Promise.all(
								rows.map(async (row) => ({
									...row,
									d1_id: await BufferHelpers.uuidConvert(row.d1_id),
								})),
							);
						})
						.then(([row]) => {
							if (row) {
								const t_db = DBManager.getDrizzle(
									{
										accountId: CF_ACCOUNT_ID!,
										apiToken: CICD_CF_API_TOKEN!,
										databaseId: row.d1_id.utf8,
									},
									true,
								);

								return t_db
									.insert(api_keys)
									.values({
										ak_id: sql`unhex(${ak_id.hex})`,
										name: args.name,
										hash: sql`unhex(${ak_secret_hash})`,
										expires: args.expires.toISOString(),
									})
									.returning()
									.then(console.log)
									.then(() =>
										t_db
											.insert(api_keys_keyrings)
											.values({
												ak_id: sql`unhex(${ak_id.hex})`,
												kr_id: sql`unhex(${kr_id.hex})`,
												r_encrypt: args.encrypt,
												r_decrypt: args.decrypt,
												r_rewrap: args.rewrap,
												r_sign: args.sign,
												r_verify: args.verify,
												r_hmac: args.hmac,
												r_random: args.random,
												r_hash: args.hash,
											})
											.returning()
											.then(console.log),
									);
							}
						});
				}),
			),
	)
	.parse();
