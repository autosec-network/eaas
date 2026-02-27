import type { BaseD0 } from 'api/do/base';
import type { LogWriter } from 'drizzle-orm/logger';
import type { SqliteRemoteDatabase } from 'drizzle-orm/sqlite-proxy';
import { drizzle as drizzleRest } from 'drizzle-orm/sqlite-proxy';
import type { DrizzleConfig } from 'drizzle-orm/utils';

export namespace StaticDatabase {
	export enum Root {
		eaas_root_prod = '96293b84-f813-4d4e-8ac0-f7a2b8e8f39c',
		eaas_root_dev = 'ffa8fdcf-3606-4057-9083-570637870344',
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
