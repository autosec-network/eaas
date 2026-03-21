import type { DurableObject } from 'cloudflare:workers';
import type { LogWriter } from 'drizzle-orm/logger';
import type { SqliteRemoteDatabase } from 'drizzle-orm/sqlite-proxy';
import { drizzle as drizzleRest } from 'drizzle-orm/sqlite-proxy';
import type { DrizzleConfig } from 'drizzle-orm/utils';
import * as waeSchema from './schemas/analyticsEngine.js';

export namespace StaticDatabase {
	export enum Root {
		eaas_root_prod = 'b65299dd-87d5-487b-90fd-86e17465e1d5',
		eaas_root_dev = 'e06d4bdd-d766-4692-a59b-d1efb2c717f3',
	}
	export namespace Tenant {
		export enum Main {
			'eaas-api-prod_TenantD0' = '4f8ee07fa49c4fa3b584530cabf088da',
		}
		export enum Logs {
			'eaas-api-prod_TenantD0Logs' = '6cea5a5563734ed9a72273f86d06d9bf',
		}
		export enum BitwardenSessions {
			'eaas-api-prod_BitwardenSession' = '3cbbb3fc932a4fb1a38aa734f07e8e29',
		}
	}
	export namespace User {
		export enum Main {
			'eaas-api-prod_UserD0' = '27a5f657bf8b441996a68d5d7096bd80',
		}
		export enum Sessions {
			'eaas-customer-prod_UserSession' = '03f350205c5d451eabd3cd54c5d77b76',
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
			size: number;
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
		{
			...config,
			casing: 'snake_case',
		},
	);
}

export function drizzleAE(
	client: {
		read?: {
			accountId: string;
			apiKey: string;
		};
		write?: Record<keyof typeof waeSchema, AnalyticsEngineDataset>;
	},
	config?: Omit<DrizzleConfig<typeof waeSchema>, 'casing' | 'schema'>,
) {
	return drizzleRest(
		(sql, params, method) => {},
		(queries) => {},
		{
			...config,
			schema: waeSchema,
		},
	);
}
