import type { NetHelpers } from '@chainfuse/helpers/net';
import { DefaultLogger, type LogWriter } from 'drizzle-orm';
import type { Cache as DrizzleCache } from 'drizzle-orm/cache/core';
import { drizzle as drizzleD1 } from 'drizzle-orm/d1';
import { drizzle as drizzleRest } from 'drizzle-orm/sqlite-proxy';
import type { CustomLogCallback, CustomLoging } from '../types/index.mjs';
import type { ApiDbRef, DistributedD1Database, DrizzleCommonDatabase, FlexibleDbRef } from './types.mjs';

export namespace StaticDatabase {
	export enum Root {
		eaas_root = 'c576d6cf-f202-4845-a971-f95d0e00e95a',
		eaas_root_p = '74b7a7fd-18ea-422f-a888-47214742e4cf',
	}

	// t_00000000-0000-0000-0000-000000000001
	export enum Tenant {}
}

class DebugLogWriter implements LogWriter {
	private connectionType: 'BINDING' | 'REST';

	constructor(connectionType: typeof this.connectionType) {
		this.connectionType = connectionType;
	}

	write(...args: Parameters<CustomLogCallback>) {
		console.debug('D1', this.connectionType.toLocaleUpperCase(), '|', ...args);
	}
}

class CustomLogWriter implements LogWriter {
	protected customCallback: CustomLogCallback;

	constructor(customCallback: CustomLogCallback) {
		this.customCallback = customCallback;
	}

	write(...args: Parameters<CustomLogCallback>) {
		this.customCallback(...args);
	}
}

export class DBManager {
	protected static isApiDbRef(ref: FlexibleDbRef): ref is ApiDbRef {
		// eslint-disable-next-line @typescript-eslint/no-unnecessary-condition
		return 'accountId' in ref && ref.accountId !== undefined && 'apiToken' in ref && ref.apiToken !== undefined && 'databaseId' in ref && ref.databaseId !== undefined;
	}

	protected static isD1Database(ref: FlexibleDbRef): ref is DistributedD1Database {
		return 'batch' in ref && typeof ref.batch === 'function';
	}

	public static getDrizzle<C extends DrizzleCache, TSchema extends Record<string, unknown> = Record<string, never>>(
		dbRef: DistributedD1Database,
		config?: {
			logger?: CustomLoging;
			cache?: C;
		},
	): DrizzleCommonDatabase<TSchema>;
	public static getDrizzle<C extends DrizzleCache, TSchema extends Record<string, unknown> = Record<string, never>>(
		dbRef: ApiDbRef,
		config?: {
			logger?: CustomLoging;
			cfLogging?: Parameters<typeof NetHelpers.cfApi>[1];
			cache?: C;
		},
	): DrizzleCommonDatabase<TSchema>;
	public static getDrizzle<C extends DrizzleCache, TSchema extends Record<string, unknown> = Record<string, never>>(
		dbRef: FlexibleDbRef,
		config: {
			logger?: CustomLoging;
			cfLogging?: Parameters<typeof NetHelpers.cfApi>[1];
			cache?: C;
		} = {
			logger: false,
		},
	) {
		if (this.isApiDbRef(dbRef)) {
			return drizzleRest<TSchema>(
				async (sql, params, method) => {
					try {
						const responses = await import('@chainfuse/helpers/net').then(({ NetHelpers }) => NetHelpers.cfApi(dbRef.apiToken, config.cfLogging).then((cf) => cf.d1.database.query(dbRef.databaseId, { account_id: dbRef.accountId, sql, params })));

						if (responses.result[0]?.success) {
							const results = (responses.result[0].results ?? []) as Record<string, any>[];

							/**
							 * Drizzle always waits for {rows: string[][]} or {rows: string[]} for the return value.
							 * @link https://orm.drizzle.team/docs/get-started-sqlite#http-proxy
							 */
							if (method === 'get') {
								return { rows: Object.values(results[0] ?? {}) };
							} else {
								return { rows: results.map((result) => Object.values(result)) };
							}
						} else {
							console.error('D1 Rest Error');
							return { rows: [] };
						}
					} catch (error) {
						console.error('D1 Rest Error', error);
						return { rows: [] };
					}
				},
				async (queries: { sql: string; params: any[]; method: 'all' | 'run' | 'get' | 'values' }[]) => {
					const hasParams = queries.some((query) => (query.params ?? []).length > 0);
					if (hasParams) {
						// params with multiple statements is not supported
						try {
							const batchResponse: { rows: any[][] | any[] }[] = [];

							const promises = await import('@chainfuse/helpers/net').then(({ NetHelpers }) => Promise.allSettled(queries.map((query) => NetHelpers.cfApi(dbRef.apiToken, config.cfLogging).then((cf) => cf.d1.database.query(dbRef.databaseId, { account_id: dbRef.accountId, sql: query.sql, params: query.params })))));

							promises.forEach((promise) => {
								if (promise.status === 'fulfilled') {
									const responses = promise.value;

									responses.result.forEach((response, index) => {
										if (response.success) {
											const results = (response.results ?? []) as Record<string, any>[];

											/**
											 * Drizzle always waits for {rows: string[][]} or {rows: string[]} for the return value.
											 * @link https://orm.drizzle.team/docs/get-started-sqlite#http-proxy
											 */
											if (queries[index]?.method === 'get') {
												batchResponse.push({ rows: Object.values(results[0] ?? {}) });
											} else {
												batchResponse.push({ rows: results.map((result) => Object.values(result)) });
											}
										} else {
											console.error('D1 Batch Rest Error', queries[index]);
											batchResponse.push({ rows: [] });
										}
									});
								} else {
									console.error('D1 Batch Rest Error', promise.reason);
									batchResponse.push({ rows: [] });
								}
							});

							return batchResponse;
						} catch (error) {
							console.error('D1 Batch Rest Error', error);
							return [];
						}
					} else {
						// Less HTTP Calls
						try {
							const batchResponse: { rows: any[][] | any[] }[] = [];

							const responses = await import('@chainfuse/helpers/net').then(({ NetHelpers }) => NetHelpers.cfApi(dbRef.apiToken, config.cfLogging).then((cf) => cf.d1.database.query(dbRef.databaseId, { account_id: dbRef.accountId, sql: queries.map((query) => query.sql).join(';') })));

							// Merge back together into final result
							responses.result.forEach((response, index) => {
								if (response.success) {
									const results = (response.results ?? []) as Record<string, any>[];

									/**
									 * Drizzle always waits for {rows: string[][]} or {rows: string[]} for the return value.
									 * @link https://orm.drizzle.team/docs/get-started-sqlite#http-proxy
									 */
									if (queries[index]?.method === 'get') {
										batchResponse.push({ rows: Object.values(results[0] ?? {}) });
									} else {
										batchResponse.push({ rows: results.map((result) => Object.values(result)) });
									}
								} else {
									console.error('D1 Batch Rest Error', queries[index]);
									batchResponse.push({ rows: [] });
								}
							});

							return batchResponse;
						} catch (error) {
							console.error('D1 Batch Rest Error', error);
							return [];
						}
					}
				},
				{
					logger: typeof config.logger === 'boolean' ? (config.logger ? new DefaultLogger({ writer: new DebugLogWriter('REST') }) : config.logger) : new DefaultLogger({ writer: new CustomLogWriter(config.logger!) }),
					casing: 'snake_case',
					cache: config.cache,
				},
			) as DrizzleCommonDatabase<TSchema>;
		} else {
			return drizzleD1<TSchema>(dbRef as D1Database, {
				logger: typeof config.logger === 'boolean' ? (config.logger ? new DefaultLogger({ writer: new DebugLogWriter('BINDING') }) : config.logger) : new DefaultLogger({ writer: new CustomLogWriter(config.logger!) }),
				casing: 'snake_case',
				cache: config.cache,
			}) as DrizzleCommonDatabase<TSchema>;
		}
	}
}
