#!/usr/bin/env -S npx tsx
import yargs from 'yargs';
import { hideBin } from 'yargs/helpers';
import type { CliArgs } from '../db-core/types.mjs';
import { RootMigrator } from './cli-root.mjs';
import { TenantMigrator } from './cli-tenant.mjs';

interface CliMigrateArgs extends CliArgs {
	remote: boolean;
}

yargs(hideBin(process.argv))
	.command<CliArgs>(
		'generate',
		'Generate D1 Migrations',
		(yargs) =>
			yargs
				.option('type', {
					alias: 't',
					choices: ['root', 'tenant'],
				})
				.demandOption('type'),
		(args) => {
			const promises: Promise<void>[] = [];

			if (args.type.includes('root')) promises.push(new RootMigrator({ type: 'generate' })['generate']());

			if (args.type.includes('tenant')) promises.push(new TenantMigrator({ type: 'generate' })['generate']());

			return Promise.allSettled(promises).then(() => {});
		},
	)
	.command<CliMigrateArgs>(
		'migrate',
		'Run D1 Migrations',
		(yargs) =>
			yargs
				.option('type', {
					alias: 't',
					choices: ['root', 'tenant'],
				})
				.demandOption('type')
				.option('remote', {
					alias: 'r',
					type: 'boolean',
					default: false,
				}),
		(args) => {
			const promises: Promise<void>[] = [];

			if (args.type.includes('root')) promises.push(new RootMigrator({ type: 'migrate', remote: args.remote })['migrate']());

			if (args.type.includes('tenant')) promises.push(new TenantMigrator({ type: 'migrate', remote: args.remote })['migrate']());

			return Promise.allSettled(promises).then(() => {});
		},
	)
	.parse();
