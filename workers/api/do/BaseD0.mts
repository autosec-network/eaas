import { DurableObject } from 'cloudflare:workers';
import { DebugLogWriter } from 'db/core';
import type * as tenantLogsSchema from 'db/schemas/tenant/logs';
import type * as tenantSchema from 'db/schemas/tenant/main';
import type * as userSchema from 'db/schemas/user/main';
import { drizzle, type DrizzleSqliteDODatabase } from 'drizzle-orm/durable-sqlite';
import { DefaultLogger } from 'drizzle-orm/logger';
import { hrtime } from 'node:process';
import type { EnvVars } from '~/types.mjs';

export type CursorWithExtras<T extends Record<string, SqlStorageValue> = Record<string, SqlStorageValue>, U extends object = CursorExtras> = SqlStorageCursor<T> & U;
export interface CursorExtras {
	/**
	 * Denotes if the database has been altered in some way, like deleting rows.
	 */
	// changed_db: boolean;
	/**
	 * Rough indication of how many rows were modified by the query, as provided by SQLite's `sqlite3_total_changes()`.
	 */
	// changes: number;
	/**
	 * The duration of the SQL query execution inside the database. Does not include any network communication
	 */
	duration: number;
	/**
	 * The row ID of the last inserted row in a table with an `INTEGER PRIMARY KEY` as provided by SQLite. Tables created with `WITHOUT ROWID` do not populate this.
	 */
	// last_row_id?: number;
	/**
	 * Size of the database after the query committed, in bytes
	 */
	// size_after: number;
}

export abstract class BaseD0 extends DurableObject<EnvVars> {
	protected _storage: DurableObjectStorage;
	protected drizzle: DrizzleSqliteDODatabase<typeof tenantSchema | typeof userSchema | typeof tenantLogsSchema>;

	constructor(ctx: DurableObjectState, env: EnvVars) {
		super(ctx, env);

		this._storage = new Proxy<DurableObjectStorage>(this.ctx.storage, {
			get: (target1, prop1: keyof typeof target1, receiver1) => {
				if (prop1 === 'sql') {
					return new Proxy<SqlStorage>(target1.sql, {
						get: (target2, prop2: keyof typeof target2, receiver2) => {
							if (prop2 === 'exec') {
								return new Proxy(target2.exec.bind(target2), {
									// eslint-disable-next-line @typescript-eslint/no-explicit-any
									apply: (target3: <T extends Record<string, SqlStorageValue>>(query: string, ...bindings: any[]) => CursorWithExtras<T>, thisArg: SqlStorage, args: Parameters<typeof target3>) => {
										const startTime = hrtime.bigint();
										// Actually run it
										const result = Reflect.apply(target3, thisArg, args);
										const nsDuration = hrtime.bigint() - startTime;
										// MS duration but same nanosecond precision as above (as decimal points)
										const msDuration = parseFloat(`${(nsDuration / 1_000_000n).toString()}.${(nsDuration % 1_000_000n).toString().padStart(6, '0')}`);

										// Must do `changes()` not `total_changes()` because that's based on SQLite's connection, which is the entire DO lifespan
										// const { last_row_id, changes } = Reflect.apply(target3<{ last_row_id: number | null; changes: number }>, thisArg, ['SELECT last_insert_rowid() AS last_row_id, changes() AS changes']).one();

										const enhancedResult: CursorWithExtras = Object.assign(result, {
											// changed_db: changes > 0,
											// changes,
											duration: msDuration,
											// ...(last_row_id !== null && { last_row_id }),
											// size_after: target2.databaseSize,
										} satisfies CursorExtras);

										return enhancedResult;
									},
								});
							}

							const other2 = Reflect.get(target2, prop2, receiver2);

							if (typeof other2 === 'function') {
								// Bind functions of DurableObjectStorage properly
								return other2.bind(target2);
							}

							return other2;
						},
					});
				}

				const other1 = Reflect.get(target1, prop1, receiver1);

				if (typeof other1 === 'function') {
					// Bind functions of DurableObjectStorage properly
					return other1.bind(target1);
				}

				return other1;
			},
		});

		this.drizzle = drizzle(this._storage, {
			...(env.NODE_ENV !== 'production' && { logger: new DefaultLogger({ writer: new DebugLogWriter(ctx.id.toString()) }) }),
			casing: 'snake_case',
		});

		// eslint-disable-next-line @typescript-eslint/no-floating-promises
		this.ctx
			.blockConcurrencyWhile(async () => {
				const startTime = hrtime.bigint();
				await this._migrate();
				return hrtime.bigint() - startTime;
			})
			.then((nsDuration) => parseFloat(`${(nsDuration / 1_000_000n).toString()}.${(nsDuration % 1_000_000n).toString().padStart(6, '0')}`))
			.then((msDuration) => console.info('Migration completed in', msDuration.toFixed(4), 'ms'));
	}

	protected abstract _migrate(): Promise<void>;

	// eslint-disable-next-line @typescript-eslint/no-explicit-any
	public sqlExec(statements: { query: string; bindings?: any[] }[]) {
		// eslint-disable-next-line @typescript-eslint/require-await
		return this.ctx.storage.transaction(async () =>
			statements.map(({ query, bindings }) => {
				const sqlExec = (() => {
					let exec: CursorWithExtras;
					if (bindings && bindings.length > 100) {
						throw new Error('Each statement can have a maximum of 100 bindings.', { cause: 'DO SQL BOUND PARAMETERS EXCEEDED' });
					} else if (bindings && bindings.length > 0) {
						// eslint-disable-next-line @typescript-eslint/no-unsafe-argument
						exec = this._storage.sql.exec(query, ...bindings) as CursorWithExtras;
					} else {
						exec = this._storage.sql.exec(query) as CursorWithExtras;
					}
					return exec;
				})();

				return {
					result: sqlExec.toArray(),
					rowsRead: sqlExec.rowsRead,
					rowsWritten: sqlExec.rowsWritten,
					duration: sqlExec.duration,
					// size: sqlExec.size_after,
				};
			}),
		);
	}

	/**
	 * Wipes all persisted state and force-exits the DO.
	 * @param reason Optional reason for the nuke.
	 */
	public async nuke(reason?: string) {
		if (reason) console.warn(reason);
		await this.ctx.storage.deleteAll();
		// To ensure that the DO is fully evicted, this.ctx.abort() is called
		// `ctx.abort` throws an uncatchable error, so we yield to the event loop to avoid capturing it and let handlers finish cleaning up
		setTimeout(() => {
			try {
				this.ctx.abort(`nuked${reason ? `: ${reason}` : ''}`);
				// eslint-disable-next-line @typescript-eslint/no-unused-vars
			} catch (error) {
				// Do nothing
			}
		}, 0);
	}
}
