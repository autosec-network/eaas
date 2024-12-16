#!/usr/bin/env -S npx tsx
import { stringify } from '@iarna/toml';
import type { DatabaseCreateParams } from 'cloudflare/resources/d1/database.mjs';
import { sql } from 'drizzle-orm';
import { exec } from 'node:child_process';
import { unlink, writeFile } from 'node:fs/promises';
import { promisify } from 'node:util';
import yargs from 'yargs';
import { hideBin } from 'yargs/helpers';
import { DBManager, StaticDatabase } from '../shared/db-core/db.mjs';
import type { CliWranglerConfig } from '../shared/db-core/types.mjs';
import { tenants } from '../shared/db-preview/schemas/root';
import { properties } from '../shared/db-preview/schemas/tenant';
import { BufferHelpers } from '../shared/helpers/buffers.mjs';
import { CryptoHelpers } from '../shared/helpers/crypto.mjs';
import { NetHelpers } from '../shared/helpers/net.mjs';
import type { PrefixedUuid, UuidExport } from '../shared/types/d1/index.mjs';

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
								// BufferHelpers.uuidConvert(d1CreateResponse.uuid as UuidExport['utf8']).then((converted_d1_id) =>
								// 	DBManager.getDrizzle(
								// 		{
								// 			accountId: CF_ACCOUNT_ID!,
								// 			apiToken: CICD_CF_API_TOKEN!,
								// 			databaseId: StaticDatabase.Root.eaas_root_p,
								// 		},
								// 		true,
								// 	)
								// 		.insert(tenants)
								// 		.values({
								// 			t_id: sql`unhex(${t_id.hex})`,
								// 			d1_id: sql`unhex(${converted_d1_id.hex})`,
								// 		})
								// 		.then(() => converted_d1_id),
								// ),
							]);
							// .then(([, converted_d1_id]) => {
							// 	if (converted_d1_id.status === 'fulfilled') {
							// 		return DBManager.getDrizzle(
							// 			{
							// 				accountId: CF_ACCOUNT_ID!,
							// 				apiToken: CICD_CF_API_TOKEN!,
							// 				databaseId: converted_d1_id.value.utf8,
							// 			},
							// 			true,
							// 		)
							// 			.insert(properties)
							// 			.values({
							// 				t_id: sql`unhex(${t_id.hex})`,
							// 				d1_id: sql`unhex(${converted_d1_id.value.hex})`,
							// 				name: args.name,
							// 			});
							// 	} else {
							// 		return;
							// 	}
							// })
							// .then(() => console.log(d1CreateResponse))
							// .catch((reason) =>
							// 	NetHelpers.cfApi(CICD_CF_API_TOKEN!)
							// 		.d1.database.delete(d1CreateResponse.uuid!, { account_id: CF_ACCOUNT_ID! })
							// 		.catch((d1DeleteReason) => {
							// 			const message = `Failed to setup, also failed to roll back orphaned D1 ${name} (${d1CreateResponse.uuid})`;
							// 			console.error(new Error(message, { cause: d1DeleteReason }));
							// 		})
							// 		.then(() => {
							// 			const message = 'Failed to setup, successfully rolled back orphaned D1 creation';
							// 			console.warn(new Error(message, { cause: reason }));
							// 		}),
							// );
						});
					}),
			),
	)
	.parse();
