#!/usr/bin/env node
import { copyFile, readdir } from 'node:fs/promises';
import { extname } from 'node:path';
import { Worker } from 'node:worker_threads';
import yargs from 'yargs';
import { hideBin } from 'yargs/helpers';
import type { CliArgs, CliWorkerData } from '../db-core/types.mjs';

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
			if (args.type.includes('root')) {
				const workerFile = workerCreate('./cli-root.mjs');
				new Worker(workerFile.path, {
					name: workerFile.name,
					workerData: { type: 'generate' } satisfies CliWorkerData,
				})
					.on('message', console.log)
					.once('exit', (exitCode) => {
						console.info('generate', 'root', 'exit', exitCode);

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
	.command<CliArgs>(
		'build-copy',
		'Copy files TS forgets',
		(yargs) =>
			yargs
				.option('type', {
					alias: 't',
					choices: ['root', 'tenant'],
				})
				.demandOption('type'),
		(args) =>
			Promise.allSettled(
				args.type.map((type) =>
					readdir(`src/schemas/${type}`).then((files) => {
						const sqlFiles = files.filter((file) => extname(file).toLowerCase() === '.sql');

						return Promise.allSettled(sqlFiles.map((sqlFile) => copyFile(`src/schemas/${type}/${sqlFile}`, `dist/schemas/${type}/${sqlFile}`)));
					}),
				),
			).then(() => {}),
	)
	.parse();
