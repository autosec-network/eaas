#!/usr/bin/env -S npx tsx
import { stringify } from '@iarna/toml';
import { unlink, writeFile } from 'node:fs/promises';
import { BaseMigrator } from '../db-core/cli-base.mjs';
import { DBManager, StaticDatabase } from '../db-core/db.mjs';
import type { CliWorkerData, CliWorkerDataMigrate, CliWranglerConfig } from '../db-core/types.mjs';
import { BufferHelpers } from '../helpers/buffers.mjs';
import { CryptoHelpers } from '../helpers/crypto.mjs';
import { tenants as rootTenants } from './schemas/root/index.js';

const { CF_ACCOUNT_ID, CICD_CF_API_TOKEN } = process.env;

export class TenantMigrator extends BaseMigrator {
	constructor(workerData: CliWorkerData) {
		super(workerData, 'Tenant');
	}
	public override generate() {
		return this.execPromise(['drizzle-kit', 'generate', '--dialect=sqlite', '--casing=snake_case', '--schema="shared/db-preview/schemas/tenant/index.ts"', '--out="shared/db-preview/schemas/tenant"'].join(' ')).then(({ stdout, stderr }) => {
			console.log(stdout);
			console.error(stderr);
		});
	}
	public override migrate() {
		const workerData = this.workerData as CliWorkerDataMigrate;

		return DBManager.getDrizzle({
			accountId: CF_ACCOUNT_ID!,
			apiToken: CICD_CF_API_TOKEN!,
			databaseId: StaticDatabase.Root.eaas_root_p,
		})
			.select({
				t_id: rootTenants.t_id,
				t_d1_id: rootTenants.d1_id,
			})
			.from(rootTenants)
			.then((tenants) =>
				Promise.all(
					tenants.map(async (tenant) => ({
						t_id: await BufferHelpers.uuidConvert(tenant.t_id),
						t_d1_id: await BufferHelpers.uuidConvert(tenant.t_d1_id),
					})),
				),
			)
			.then((tenants) => {
				this.processingStatus = tenants.reduce(
					(acc, { t_id }) => {
						acc[t_id.utf8] = null;
						return acc;
					},
					{} as typeof this.processingStatus,
				);

				this.processingStarted = true;
				return this.queue.addAll(
					tenants.map((tenant) => () => {
						const tenantWranglerConfig: CliWranglerConfig = {
							account_id: CF_ACCOUNT_ID,
							d1_databases: [
								{
									binding: `t_${tenant.t_id.hex}_p`.toUpperCase(),
									database_name: `t_${tenant.t_id.utf8}_p`,
									database_id: tenant.t_d1_id.utf8,
									migrations_dir: 'shared/db-preview/schemas/tenant',
								},
							],
						};

						// Will never conflict since `database_id` is always unique
						return CryptoHelpers.getHash('SHA-256', JSON.stringify(tenantWranglerConfig)).then((tenantWranglerHashPrefix) =>
							writeFile(`${tenantWranglerHashPrefix}.wrangler.toml`, stringify(tenantWranglerConfig), 'utf8')
								.then(() =>
									this.execPromise(['wrangler', 'd1', 'migrations', 'apply', '--config', `${tenantWranglerHashPrefix}.wrangler.toml`, tenantWranglerConfig.d1_databases[0]!.binding, workerData.remote ? '--remote' : '--local'].join(' '), {
										env: {
											...process.env,
											CLOUDFLARE_ACCOUNT_ID: CF_ACCOUNT_ID,
											CLOUDFLARE_API_TOKEN: CICD_CF_API_TOKEN,
										},
									}).then(({ stdout, stderr }) => {
										console.log(stdout);
										console.error(stderr);

										if (stderr.trim().length > 0) {
											this.processingStatus[tenant.t_id.utf8] = false;
										} else {
											this.processingStatus[tenant.t_id.utf8] = true;
										}
									}),
								)
								.finally(() => unlink(`${tenantWranglerHashPrefix}.wrangler.toml`)),
						);
					}),
				);
			})
			.then(() => {});
	}
}
