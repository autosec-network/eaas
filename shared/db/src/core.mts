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
	export enum Tenant {
		'eaas-api-prod_TenantD0' = 'e5713808931545d7bf502b615f10a142',
	}
	export enum User {
		'eaas-api-prod_UserD0' = '85cffc854b0c4673a5a9d7e0c12618a7',
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
			size: number;
		}[]
	>;

	public nuke(reason?: string): Promise<void>;
}

export function drizzleD0<TSchema extends Record<string, unknown> = Record<string, never>, D0 extends BaseD0 = BaseD0, TClient extends DurableObjectStub<D0> = DurableObjectStub<D0>>(client: TClient, config?: DrizzleConfig<TSchema>): SqliteRemoteDatabase<TSchema> {
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
					console.error('D1 transaction Error');
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
				console.error('D1 Batch sqlExec Error', error);
				return [];
			}
		},
		config,
	);
}
