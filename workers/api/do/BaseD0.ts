import { DurableObject } from 'cloudflare:workers';
import { DebugLogWriter } from 'db/core';
import { drizzle } from 'drizzle-orm/durable-sqlite';
import { DefaultLogger } from 'drizzle-orm/logger';
import { sql } from 'drizzle-orm/sql';
import { hrtime } from 'node:process';
import type { EnvVars } from '~/types';

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
	protected drizzle;

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
		});

		// eslint-disable-next-line @typescript-eslint/no-floating-promises
		this.ctx
			.blockConcurrencyWhile(async () => {
				const startTime = hrtime.bigint();
				await this._migrate();
				return hrtime.bigint() - startTime;
			})
			.then((nsDuration) => {
				/**
				 * > We recommend running this command after making any changes to the schema
				 * @link https://developers.cloudflare.com/d1/sql-api/sql-statements/#pragma-optimize
				 * Since drizzle doesn't expose if a migration changed the database, we use the duration of the migration as a heuristic. Since time doesn't advance if no I/O is done, no changes always returns 0.
				 */
				if (nsDuration > 0n)
					this.ctx.waitUntil(
						// Don't use `Promise.resolve` to actually create background thread and not block
						// eslint-disable-next-line @typescript-eslint/require-await
						(async () => this.optimize())(),
					);

				const msDuration = parseFloat(`${(nsDuration / 1_000_000n).toString()}.${(nsDuration % 1_000_000n).toString().padStart(6, '0')}`);

				console.info('Migration completed in', msDuration.toFixed(4), 'ms');
			});
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
					result: sqlExec.toArray().map((row) =>
						Object.fromEntries(
							Object.entries(row).map(([key, value]) => [
								key,
								value instanceof ArrayBuffer
									? // ArrayBuffer is structured-cloneable (RPC), but not JSON-serializable, number like array
										Array.from(new Uint8Array(value))
									: value,
							]),
						),
					),
					rowsRead: sqlExec.rowsRead,
					rowsWritten: sqlExec.rowsWritten,
					duration: sqlExec.duration,
					// size: sqlExec.size_after,
				};
			}),
		);
	}

	/**
	 * Optimizes the database by executing the `PRAGMA optimize` command.
	 *
	 * This pragma is similar to `PRAGMA integrity_check` but skips verifying UNIQUE constraints and index consistency, allowing it to run faster.
	 * While `PRAGMA integrity_check` operates in O(NlogN) time, this pragma runs in O(N) time, where N is the total number of rows in the database.
	 * Use this method to perform a quick database optimization.
	 */
	public optimize() {
		return this.drizzle.run(sql`PRAGMA optimize`);
	}

	public getBookmark(timestamp?: number | Date) {
		if (timestamp !== undefined) {
			return this.ctx.storage.getBookmarkForTime(timestamp);
		} else {
			return this.ctx.storage.getCurrentBookmark();
		}
	}

	public async restoreToBookmark(bookmark: string) {
		await this.ctx.storage.onNextSessionRestoreBookmark(bookmark);
		// Restart the Durable Object, thus completing the point-in-time recovery
		// `ctx.abort` throws an uncatchable error, so we yield to the event loop to avoid capturing it and let handlers finish cleaning up
		setTimeout(() => {
			try {
				this.ctx.abort('restoring to bookmark');
				// eslint-disable-next-line @typescript-eslint/no-unused-vars
			} catch (error) {
				// Do nothing
			}
		}, 0);
	}

	/**
	 * Wipes all persisted state and (by default) force-exits the DO.
	 * @param reason Optional reason for the nuke.
	 * @param [hard=true] Optionally force exit the DO
	 */
	public async nuke(reason?: string, hard: boolean = true) {
		if (reason) console.warn(reason);
		await this.ctx.storage.deleteAll({ allowConcurrency: false });
		// To ensure that the DO is fully evicted, this.ctx.abort() is called
		// `ctx.abort` throws an uncatchable error, so we yield to the event loop to avoid capturing it and let handlers finish cleaning up
		if (hard) {
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
}
