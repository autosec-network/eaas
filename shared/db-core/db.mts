import type { D1Database } from '@cloudflare/workers-types/experimental';
import { DefaultLogger, type LogWriter } from 'drizzle-orm';
import { drizzle as drizzleD1 } from 'drizzle-orm/d1';
import { drizzle as drizzleDO } from 'drizzle-orm/durable-sqlite';
import { drizzle as drizzleRest } from 'drizzle-orm/sqlite-proxy';
import { NetHelpers } from '../helpers/net.mjs';
import type { CustomLogCallback, CustomLoging } from '../types/index.mjs';
import type { ApiDbRef, DrizzleCommonDatabase, FlexibleDbRef } from './types.mjs';

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
		return 'accountId' in ref && ref.accountId !== undefined && 'apiToken' in ref && ref.apiToken !== undefined && 'databaseId' in ref && ref.databaseId !== undefined;
	}

	protected static isD1Database(ref: FlexibleDbRef): ref is D1Database {
		return 'batch' in ref && typeof ref.batch === 'function';
	}

	public static getDrizzle<TSchema extends Record<string, unknown> = Record<string, never>>(dbRef: D1Database, logger?: CustomLoging): DrizzleCommonDatabase<TSchema>;
	public static getDrizzle<TSchema extends Record<string, unknown> = Record<string, never>>(dbRef: ApiDbRef, logger?: CustomLoging): DrizzleCommonDatabase<TSchema>;
	public static getDrizzle<TSchema extends Record<string, unknown> = Record<string, never>>(dbRef: FlexibleDbRef, logger: CustomLoging = false) {
		if (this.isApiDbRef(dbRef)) {
			return drizzleRest<TSchema>(
				async (sql, params, method) => {
					try {
						const responses = await NetHelpers.cfApi(dbRef.apiToken, undefined, true).d1.database.query(dbRef.databaseId, { account_id: dbRef.accountId, sql, params });
						if (responses[0]?.success) {
							const results = (responses[0].results ?? []) as Record<string, any>[];

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

							const promises = await Promise.allSettled(queries.map((query) => NetHelpers.cfApi(dbRef.apiToken).d1.database.query(dbRef.databaseId, { account_id: dbRef.accountId, sql: query.sql, params: query.params })));

							promises.forEach((promise) => {
								if (promise.status === 'fulfilled') {
									const responses = promise.value;

									responses.forEach((response, index) => {
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

							const responses = await NetHelpers.cfApi(dbRef.apiToken).d1.database.query(dbRef.databaseId, { account_id: dbRef.accountId, sql: queries.map((query) => query.sql).join(';') });

							responses.forEach((response, index) => {
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
					logger: typeof logger === 'boolean' ? (logger ? new DefaultLogger({ writer: new DebugLogWriter('REST') }) : logger) : new DefaultLogger({ writer: new CustomLogWriter(logger) }),
					casing: 'snake_case',
				},
			) as DrizzleCommonDatabase<TSchema>;
		} else {
			return drizzleD1<TSchema>(dbRef, {
				logger: typeof logger === 'boolean' ? (logger ? new DefaultLogger({ writer: new DebugLogWriter('BINDING') }) : logger) : new DefaultLogger({ writer: new CustomLogWriter(logger) }),
				casing: 'snake_case',
			}) as DrizzleCommonDatabase<TSchema>;
		}
	}

	public static getDoDrizzle<TSchema extends Record<string, unknown> = Record<string, never>>(dbRef: SqlStorage, logger: CustomLoging = false) {
		return drizzleDO<TSchema>(dbRef, {
			logger: typeof logger === 'boolean' ? (logger ? new DefaultLogger({ writer: new DebugLogWriter('BINDING') }) : logger) : new DefaultLogger({ writer: new CustomLogWriter(logger) }),
			casing: 'snake_case',
		});
	}
}
