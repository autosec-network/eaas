#!/usr/bin/env -S npx tsx
import { Worker } from 'node:worker_threads';
import yargs from 'yargs';
import { hideBin } from 'yargs/helpers';
import type { CliArgs, CliWorkerData } from '../db-core/types.mjs';
import { RootMigrator } from './cli-root.mjs';

function workerCreate(path: string): { path: URL; name: string } {
	const finalPath = new URL(path, import.meta.url);

	return {
		path: finalPath,
		name: finalPath.pathname.split('/').pop()!.split('.').shift()!,
	};
}

const ignoreExitCodes: number[] = [0, 13];

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

			if (args.type.includes('tenant')) {
				const workerFile = workerCreate('./cli-tenant.mjs');
				new Worker(workerFile.path, {
					name: workerFile.name,
					workerData: { type: 'generate' } satisfies CliWorkerData,
				})
					.on('message', console.log)
					.once('exit', (exitCode) => {
						console.info('generate', 'tenant', 'exit', exitCode);

						// Exit code 13 comes from `wrangler` that it can't find a regular named `wrangler.toml`
						if (!ignoreExitCodes.includes(exitCode)) {
							console.error(workerFile.name, 'crashed with exit code', exitCode);
						}

						const numberAttempt = Number(ignoreExitCodes.includes(exitCode) ? 0 : process.exitCode);
						process.exitCode = Math.max(isNaN(numberAttempt) ? 0 : numberAttempt, exitCode);
					})
					.once('error', console.error);
			}

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
			if (args.type.includes('root')) {
				const workerFile = workerCreate('./cli-root.mjs');
				new Worker(workerFile.path, {
					name: workerFile.name,
					workerData: { type: 'migrate', remote: args.remote } satisfies CliWorkerData,
				})
					.on('message', console.log)
					.once('exit', (exitCode) => {
						// Exit code 13 comes from `wrangler` that it can't find a regular named `wrangler.toml`
						if (!ignoreExitCodes.includes(exitCode)) {
							console.error(workerFile.name, 'crashed with exit code', exitCode);
						}

						const numberAttempt = Number(ignoreExitCodes.includes(exitCode) ? 0 : process.exitCode);
						process.exitCode = Math.max(isNaN(numberAttempt) ? 0 : numberAttempt, exitCode);
					})
					.once('error', console.error);
			}

			if (args.type.includes('tenant')) {
				const workerFile = workerCreate('./cli-tenant.mjs');
				new Worker(workerFile.path, {
					name: workerFile.name,
					workerData: { type: 'migrate', remote: args.remote } satisfies CliWorkerData,
				})
					.on('message', console.log)
					.once('exit', (exitCode) => {
						// Exit code 13 comes from `wrangler` that it can't find a regular named `wrangler.toml`
						if (!ignoreExitCodes.includes(exitCode)) {
							console.error(workerFile.name, 'crashed with exit code', exitCode);
						}

						const numberAttempt = Number(ignoreExitCodes.includes(exitCode) ? 0 : process.exitCode);
						process.exitCode = Math.max(isNaN(numberAttempt) ? 0 : numberAttempt, exitCode);
					})
					.once('error', console.error);
			}
		},
	)
	.parse();
