import type { DurableObject } from 'cloudflare:workers';
import type { LogWriter } from 'drizzle-orm/logger';
import type { AnyRelations, EmptyRelations } from 'drizzle-orm/relations';
import type { DrizzleSQLiteConfig } from 'drizzle-orm/sqlite-core';
import type { SqliteRemoteDatabase } from 'drizzle-orm/sqlite-proxy';
import { drizzle as drizzleRest } from 'drizzle-orm/sqlite-proxy';

export namespace StaticDatabase {
	export enum Root {
		eaas_root_prod = '754ba831-ff33-4d81-bebb-2a7c158b324d',
		eaas_root_dev = 'c6e00b28-b4b8-4559-9a07-215d74815d50',
	}
	export namespace Tenant {
		export enum Main {
			'eaas-api-prod_TenantD0' = 'cece251abc00477d9541ea4ca4018670',
		}
		export enum Logs {
			'eaas-api-prod_TenantD0Logs' = '69ee03699cb942f694b2c89aafbc2014',
		}
		export enum BitwardenSessions {
			'eaas-api-prod_BitwardenSession' = '94024cb8aa78450784973a7abe6c8c94',
		}
	}
	export namespace User {
		export enum Main {
			'eaas-api-prod_UserD0' = 'dfb3e47cfa1c4da8ae6f98d30d46821c',
		}
		export enum Sessions {
			'eaas-customer-prod_UserSession' = '4c2af9476d5d4018ae2ebf06667beeff',
		}
	}
}

export type CustomLogCallback = (message: string) => void;

export class DebugLogWriter implements LogWriter {
	private dbId: StaticDatabase.Root | string;

	constructor(dbId: typeof this.dbId) {
		this.dbId = dbId;
	}

	write(...args: Parameters<LogWriter['write']>) {
		console.debug(new Date().toISOString(), '|', this.dbId.toLowerCase(), '|', ...args);
	}
}

export declare abstract class BaseD0 extends DurableObject {
	public sqlExec(statements: { query: string; bindings?: any[] }[]): Promise<
		{
			result: Record<string, SqlStorageValue>[];
			rowsRead: number;
			rowsWritten: number;
			duration: number;
			// size: number;
		}[]
	>;

	public nuke(reason?: string): Promise<void>;
}

export function drizzleD0<TRelations extends AnyRelations = EmptyRelations, D0 extends BaseD0 = BaseD0, TClient extends DurableObjectStub<D0> = DurableObjectStub<D0>>(client: TClient, config?: DrizzleSQLiteConfig<TRelations>): SqliteRemoteDatabase<TRelations> {
	return drizzleRest<TRelations>(
		async (sql, params, method) => {
			try {
				const responses = await client.sqlExec([{ query: sql, bindings: params }]);

				if (responses[0]) {
					const results = responses[0].result;

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
					console.error('DO transaction Error');
					return { rows: [] };
				}
			} catch (error) {
				console.error('D0 sqlExec Error', error);
				return { rows: [] };
			}
		},
		async (queries: { sql: string; params: any[]; method: 'all' | 'run' | 'get' | 'values' }[]) => {
			try {
				const batchResponse: { rows: any[][] | any[] }[] = [];

				const responses = await client.sqlExec(queries.map(({ sql, params }) => ({ query: sql, bindings: params })));

				responses.forEach((response, index) => {
					const results = response.result;

					/**
					 * Drizzle always waits for {rows: string[][]} or {rows: string[]} for the return value.
					 * @link https://orm.drizzle.team/docs/get-started-sqlite#http-proxy
					 */
					if (queries[index]?.method === 'get') {
						batchResponse.push({ rows: Object.values(results[0] ?? {}) });
					} else {
						batchResponse.push({ rows: results.map((result) => Object.values(result)) });
					}
				});

				return batchResponse;
			} catch (error) {
				console.error('DO Batch sqlExec Error', error);
				return [];
			}
		},
		config,
	);
}
