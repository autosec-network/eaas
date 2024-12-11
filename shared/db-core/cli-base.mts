#!/usr/bin/env -S npx tsx
import { exec } from 'node:child_process';
import { promisify } from 'node:util';
import { workerData } from 'node:worker_threads';
import PQueue from 'p-queue';
import type { CliWorkerData } from './types.mjs';

export abstract class BaseMigrator {
	protected processingStatus: Record<string, boolean | null> = {};
	protected processingStarted = false;
	protected queue: PQueue = new PQueue({
		throwOnTimeout: true,
		/**
		 * (max requests - root) / 1 types of d1s
		 * @link https://developers.cloudflare.com/fundamentals/api/reference/limits
		 */
		intervalCap: (1200 - 1) / 1,
		/**
		 * minutes * seconds * milliseconds
		 * @link https://developers.cloudflare.com/fundamentals/api/reference/limits
		 */
		interval: 5 * 60 * 1000,
	});

	public static get workerData(): CliWorkerData {
		return workerData;
	}

	protected get execPromise() {
		return promisify(exec);
	}

	public abstract generate(): Promise<any>;
	public abstract migrate(): Promise<any>;

	constructor(type?: string) {
		const formatStatus = () => {
			return Object.fromEntries(Object.entries(this.processingStatus).map(([key, value]) => [key, value === true ? '✅' : value === false ? '❌' : '⏳']));
		};

		this.queue.on('add', () => {
			if (type) console.log(`Processing ${type}`);
			console.table(formatStatus());
		});
		this.queue.on('next', () => {
			if (type) console.log(`Processing ${type}`);
			console.table(formatStatus());
		});
		this.queue.onIdle().then(() => {
			if (this.processingStarted && type) {
				process.exit(0);
			}
		});
	}
}
