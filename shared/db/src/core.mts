import type { DurableObject } from 'cloudflare:workers';
import type { LogWriter } from 'drizzle-orm/logger';
import type { SqliteRemoteDatabase } from 'drizzle-orm/sqlite-proxy';
import { drizzle as drizzleRest } from 'drizzle-orm/sqlite-proxy';
import type { DrizzleConfig } from 'drizzle-orm/utils';

export namespace StaticDatabase {
	export enum Root {
		eaas_root_prod = 'b65299dd-87d5-487b-90fd-86e17465e1d5',
		eaas_root_dev = 'e06d4bdd-d766-4692-a59b-d1efb2c717f3',
	}
	export namespace Tenant {
		export enum Main {
			'eaas-api-prod_TenantD0' = '0e6da39a1737481ab04ac33fb35ee760',
		}
		export enum Logs {
			'eaas-api-prod_TenantD0Logs' = '94f3999066c64215b65bb88afd24f55b',
		}
		export enum BitwardenSessions {
			'eaas-api-prod_BitwardenSession' = '4b5761e008ff4ac19f9be1f2618bc8f1',
		}
	}
	export namespace User {
		export enum Main {
			'eaas-api-prod_UserD0' = '768c1b49ef7a4060b8c70ea61119b48e',
		}
		export enum Sessions {
			'eaas-customer-prod_UserSession' = '9a3b51933c4640cea0b725bcb588bafa',
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

export function drizzleD0<TSchema extends Record<string, unknown> = Record<string, never>, D0 extends BaseD0 = BaseD0, TClient extends DurableObjectStub<D0> = DurableObjectStub<D0>>(client: TClient, config?: Omit<DrizzleConfig<TSchema>, 'casing'>): SqliteRemoteDatabase<TSchema> {
	return drizzleRest<TSchema>(
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
		{
			...config,
			casing: 'snake_case',
		},
	);
}
