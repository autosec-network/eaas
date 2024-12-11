#!/usr/bin/env -S npx tsx
import { stringify } from '@iarna/toml';
import { copyFile, readdir, unlink, writeFile } from 'node:fs/promises';
import { extname } from 'node:path';
import { BaseMigrator } from '../db-core/cli-base.mjs';
import type { CliWorkerDataMigrate, CliWranglerConfig } from '../db-core/types.mjs';
import { CryptoHelpers } from '../helpers/crypto.mjs';

const { CF_ACCOUNT_ID, CICD_CF_API_TOKEN, EAAS_ROOT_P } = process.env;

class RootMigrator extends BaseMigrator {
	public override generate() {
		return this.execPromise(['drizzle-kit', 'generate', '--dialect=sqlite', '--casing=snake_case', '--schema="src/schemas/root/index.ts"', '--out="src/schemas/root"'].join(' '))
			.then(({ stdout, stderr }) => {
				console.log(stdout);
				console.error(stderr);
			})
			.then(() => readdir('src/schemas/root').then((files) => Promise.allSettled(files.filter((file) => extname(file).toLowerCase() === '.sql').map((sqlFile) => copyFile(`src/schemas/root/${sqlFile}`, `dist/schemas/root/${sqlFile}`)))));
	}

	public override migrate() {
		const workerData = RootMigrator.workerData as CliWorkerDataMigrate;
		const database_name = 'eaas_root_p';
		const wranglerConfig: CliWranglerConfig = {
			account_id: CF_ACCOUNT_ID,
			d1_databases: [
				{
					binding: database_name.replace('_p', ''),
					database_name,
					database_id: EAAS_ROOT_P!,
					migrations_dir: 'src/schemas/root',
				},
			],
		};

		// Will never conflict since `database_id` is always unique
		return CryptoHelpers.getHash('SHA-256', JSON.stringify(wranglerConfig)).then((wranglerHashPrefix) =>
			writeFile(`${wranglerHashPrefix}.wrangler.toml`, stringify(wranglerConfig), 'utf8')
				.then(() =>
					this.execPromise(['wrangler', 'd1', 'migrations', 'apply', '--config', `${wranglerHashPrefix}.wrangler.toml`, wranglerConfig.d1_databases[0]!.binding, workerData.remote ? '--remote' : '--local'].join(' '), {
						env: {
							...process.env,
							CLOUDFLARE_ACCOUNT_ID: CF_ACCOUNT_ID,
							CLOUDFLARE_API_TOKEN: CICD_CF_API_TOKEN,
						},
					})
						.then(({ stdout, stderr }) => {
							console.log(stdout);
							console.error(stderr);
						})
						.catch(console.error),
				)
				// Use `allSettled()` to make sure all files are deleted if 1 of them didn't get made
				.finally(() => unlink(`${wranglerHashPrefix}.wrangler.toml`)),
		);
	}
}

await new RootMigrator()[RootMigrator.workerData.type]();
