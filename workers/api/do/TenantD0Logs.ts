import { parseCronExpression } from 'cron-schedule';
import { TENANT_LOGS_SYSTEM_ALARMS } from 'db';
import { DebugLogWriter, StaticDatabase } from 'db/core';
import * as tenantLogsSchema from 'db/schemas/tenant/logs';
import { drizzle } from 'drizzle-orm/durable-sqlite';
import { DefaultLogger } from 'drizzle-orm/logger';
import { and, asc, eq, gt, gte, inArray, lte, sql } from 'drizzle-orm/sql';
import { hexToUuid } from 'helpers';
import type { Buffer } from 'node:buffer';
import type { UUID } from 'node:crypto';
import type { MethodNames } from 'types';
import { v7 as uuidv7 } from 'uuid';
import type { EnvVars } from '~/types';
import { BaseD0 } from '~do/BaseD0';

// https://developers.cloudflare.com/durable-objects/platform/limits/#what-happens-when-a-durable-object-exceeds-its-storage-limit

export class TenantD0Logs extends BaseD0 {
	/**
	 * Self-imposed ceiling on `ctx.storage.sql.databaseSize` (which reports **bytes**). The hard limit is 10 GB, but Durable Object performance tanks past ~8.5 GB, so prune down to that instead of riding the `SQLITE_FULL` fallback all the way up.
	 * GB * MB * KB * B
	 */
	private static readonly MAX_DATABASE_SIZE = 8.5 * 1000 * 1000 * 1000;

	constructor(ctx: DurableObjectState, env: EnvVars) {
		super(ctx, env);

		// eslint-disable-next-line @typescript-eslint/no-floating-promises
		this.ctx.blockConcurrencyWhile(() => this._setupSystemAlarms());
	}

	protected override async _migrate() {
		await import('drizzle-orm/durable-sqlite/migrator').then(async ({ migrate }) =>
			migrate(
				drizzle(this.ctx.storage, {
					...(this.env.NODE_ENV !== 'production' && { logger: new DefaultLogger({ writer: new DebugLogWriter(this.env.ENVIRONMENT === 'production' ? StaticDatabase.Root.eaas_root_prod : StaticDatabase.Root.eaas_root_dev) }) }),
				}),
				(await import('db/schemas/tenant/logs/migrations')).default,
			),
		);
	}

	public override sqlExec(statements: { query: string; bindings?: any[] }[]) {
		const attemptExec = (): ReturnType<BaseD0['sqlExec']> =>
			super.sqlExec(statements).catch(async (error) => {
				if (error instanceof Error && error.message.toUpperCase().includes('SQLITE_FULL')) {
					const deletedLog = await this._deleteOldestLog();

					if (deletedLog) {
						console.warn('Storage full: Deleted log from', deletedLog.toISOString());
						return attemptExec();
					} else {
						throw new Error('Storage is full and there are no logs to delete.');
					}
				} else {
					throw error;
				}
			});

		// Enforce our own ceiling only once the incoming statements have landed, so the newest log is never the one evicted
		return attemptExec().then(async (results) => {
			await this._enforceStorageLimit();
			return results;
		});
	}

	/**
	 * Deletes the single oldest log, returning when it was created (the timestamp baked into its UUIDv7 id) or `undefined` if there was nothing left to delete.
	 */
	private async _deleteOldestLog() {
		const [deletedLog] = await this.drizzle
			.delete(tenantLogsSchema.logs)
			// Oldest log first
			.orderBy(asc(tenantLogsSchema.logs.id))
			// Only 1 at a time
			.limit(1)
			.returning({ timestamp: tenantLogsSchema.logs.timestamp });

		return deletedLog?.timestamp;
	}

	/**
	 * Deletes the oldest logs until the database is back under {@link TenantD0Logs.MAX_DATABASE_SIZE}. Complements the `SQLITE_FULL` handling in {@link sqlExec}, which only kicks in at the platform's hard ceiling.
	 */
	private async _enforceStorageLimit() {
		// Sync getter, so the overwhelmingly common under-limit case costs nothing. Read off `ctx.storage` rather than the instrumented `_storage` proxy, whose `Reflect.get` would invoke this native getter with the wrong receiver.
		while (this.ctx.storage.sql.databaseSize > TenantD0Logs.MAX_DATABASE_SIZE) {
			const deletedLog = await this._deleteOldestLog();

			if (deletedLog) {
				console.warn('Storage limit exceeded: Deleted log from', deletedLog.toISOString());
			} else {
				console.error('Storage limit exceeded and there are no logs to delete.');
				break;
			}
		}
	}

	private async _setupSystemAlarms() {
		const systemAlarmEntries = Object.entries(TENANT_LOGS_SYSTEM_ALARMS) as [UUID, (typeof TENANT_LOGS_SYSTEM_ALARMS)[UUID]][];

		if (systemAlarmEntries.length > 0) {
			const existingSystemAlarmIds = await this.drizzle
				.select({
					id: tenantLogsSchema.alarms.id,
				})
				.from(tenantLogsSchema.alarms)
				.where(inArray(tenantLogsSchema.alarms.id, systemAlarmEntries.map(([id]) => sql`unhex(${id.replaceAll('-', '')})`) as unknown as [Buffer, ...Buffer[]]))
				.then((rows) => new Set(rows.map(({ id }) => hexToUuid(id.toString('hex')))));

			const missingSystemAlarms = systemAlarmEntries.filter(([id]) => !existingSystemAlarmIds.has(id)).map(([id, alarm]) => this.schedule(alarm.when, alarm.callee as MethodNames<TenantD0Logs>, alarm.payload, id));

			if (missingSystemAlarms.length > 0) await Promise.allSettled(missingSystemAlarms);
		}
	}

	private async _scheduleNextAlarm() {
		const [alarm] = await this.drizzle
			.select({
				next_time: tenantLogsSchema.alarms.next_time,
			})
			.from(tenantLogsSchema.alarms)
			.where(gt(tenantLogsSchema.alarms.next_time, new Date()))
			.orderBy(asc(tenantLogsSchema.alarms.next_time))
			.limit(1)
			.then((rows) =>
				rows.map((row) => ({
					...row,
					next_time: new Date(row.next_time),
				})),
			);

		if (alarm) await this.ctx.storage.setAlarm(alarm.next_time, { allowConcurrency: true });
	}

	/**
	 * Records a schedule row and arms the Durable Object alarm for whichever row is due next.
	 *
	 * Arming is **awaited** rather than handed to `waitUntil`: {@link _setupSystemAlarms} calls this from the constructor's `blockConcurrencyWhile`, and a deferred `setAlarm()` outlives that block — it lands after whatever RPC ran next, so a {@link nuke} re-arms the object it just wiped, which then wakes on its own cron forever as an orphan nothing accounts for.
	 */
	public async schedule<
		// eslint-disable-next-line @typescript-eslint/no-explicit-any
		T extends any[] = any[],
	>(when: Date | number | string[], callee: MethodNames<TenantD0Logs>, payload?: T, id?: UUID) {
		id ??= uuidv7() as UUID;

		if (when instanceof Date) {
			await this.drizzle.insert(tenantLogsSchema.alarms).values({
				id: sql`unhex(${id.replaceAll('-', '')})`,
				callee,
				payload,
				type: 'scheduled',
				next_time: when,
			});

			await this._scheduleNextAlarm();

			return {
				id,
				payload: (payload ?? []) as T,
				next_time: when,
				type: 'scheduled',
			} as const;
		} else if (typeof when === 'number') {
			const next_time = new Date(Date.now() + when * 1000);

			await this.drizzle.insert(tenantLogsSchema.alarms).values({
				id: sql`unhex(${id.replaceAll('-', '')})`,
				callee,
				payload,
				type: 'delayed',
				delay_in_seconds: when,
				next_time,
			});

			await this._scheduleNextAlarm();

			return {
				id,
				payload: (payload ?? []) as T,
				next_time,
				type: 'delayed',
			} as const;
		} else if (Array.isArray(when)) {
			// Declare now date here to prevent re-initialization in the `map` loop
			const now = new Date();
			const nextExecutionTime = when
				.map((cron) => parseCronExpression(cron).getNextDate(now))
				// Use `reduce` over `sort` to get O(n) instead of O(n log n) since we only need the earliest date
				.reduce((a, b) => (a.getTime() < b.getTime() ? a : b));
			// Add jitter to prevent thundering herd problem
			const jitterMs = Math.floor(Math.random() * (60 * 1000) + 1);
			const nextExecutionTimeWithJitter = new Date(nextExecutionTime.getTime() + jitterMs);

			await this.drizzle.insert(tenantLogsSchema.alarms).values({
				id: sql`unhex(${id.replaceAll('-', '')})`,
				callee,
				payload,
				type: 'cron',
				cron: when,
				next_time: nextExecutionTimeWithJitter,
			});

			await this._scheduleNextAlarm();

			return {
				id,
				payload: (payload ?? []) as T,
				next_time: nextExecutionTimeWithJitter,
				type: 'cron',
			} as const;
		} else {
			throw new Error('Invalid schedule type');
		}
	}

	// eslint-disable-next-line @typescript-eslint/no-redundant-type-constituents
	public async getSchedule(id: UUID | string) {
		const [row] = await this.drizzle
			.select()
			.from(tenantLogsSchema.alarms)
			.where(eq(tenantLogsSchema.alarms.id, sql`unhex(${id.replaceAll('-', '')})`))
			.limit(1)
			.then((rows) =>
				rows.map((row) => ({
					...row,
					id: hexToUuid(row.id.toString('hex')),
					next_time: new Date(row.next_time),
				})),
			);

		return row;
	}

	public getSchedules(
		criteria: {
			// eslint-disable-next-line @typescript-eslint/no-redundant-type-constituents
			id?: UUID | string;
			type?: 'scheduled' | 'delayed' | 'cron';
			timeRange?: { start?: Date; end?: Date };
		} = {},
	) {
		return this.drizzle
			.select()
			.from(tenantLogsSchema.alarms)
			.where(
				and(
					...(criteria.id ? [eq(tenantLogsSchema.alarms.id, sql`unhex(${criteria.id.replaceAll('-', '')})`)] : []),
					...(criteria.type ? [eq(tenantLogsSchema.alarms.type, criteria.type)] : []),
					...(criteria.timeRange
						? [
								// After start date or epoch
								gte(tenantLogsSchema.alarms.next_time, criteria.timeRange.start ?? new Date(0)),
								// Until end date or max date
								lte(tenantLogsSchema.alarms.next_time, criteria.timeRange.end ?? new Date(Number(BigInt('0x0fffffffffff')))),
							]
						: []),
				),
			)
			.then((rows) =>
				rows.map((row) => ({
					...row,
					id: hexToUuid(row.id.toString('hex')),
					next_time: new Date(row.next_time),
				})),
			);
	}

	// eslint-disable-next-line @typescript-eslint/no-redundant-type-constituents
	public async cancelSchedule(id: UUID | string) {
		await this.drizzle
			.delete(tenantLogsSchema.alarms)
			.where(eq(tenantLogsSchema.alarms.id, sql`unhex(${id.replaceAll('-', '')})`))
			.limit(1);

		this.ctx.waitUntil(this._scheduleNextAlarm());
	}

	override async alarm() {
		let now = new Date();

		const rows = await this.drizzle
			.select({
				id: tenantLogsSchema.alarms.id,
				callee: tenantLogsSchema.alarms.callee,
				payload: tenantLogsSchema.alarms.payload,
				type: tenantLogsSchema.alarms.type,
				next_time: tenantLogsSchema.alarms.next_time,
				cron: tenantLogsSchema.alarms.cron,
			})
			.from(tenantLogsSchema.alarms)
			.where(lte(tenantLogsSchema.alarms.next_time, now));

		const alarmEdits: Promise<unknown>[] = [];
		for (const row of rows) {
			if (row.callee in this) {
				if (this.env.NODE_ENV !== 'production') console.debug(`Executing alarm ${hexToUuid(row.id.toString('hex'))} with a drift of ${(Date.now() - new Date(row.next_time).getTime()) / 1000} seconds`);

				try {
					// `Reflect.apply`'s second argument rebinds `this` correctly; the rule can't see that through the extraction.
					// eslint-disable-next-line @typescript-eslint/unbound-method
					await Reflect.apply(this[row.callee as keyof TenantD0Logs]!, this, row.payload);
				} catch (error) {
					console.error(`Error executing callee \`${row.callee}\``, error);
				}

				if (row.type === 'cron' && row.cron) {
					// Update next execution time for cron schedules
					now = new Date();
					const nextExecutionTime = row.cron
						.map((cron) => parseCronExpression(cron).getNextDate(now))
						// Use `reduce` over `sort` to get O(n) instead of O(n log n) since we only need the earliest date
						.reduce((a, b) => (a.getTime() < b.getTime() ? a : b));
					// Add jitter to prevent thundering herd problem
					const jitterMs = Math.floor(Math.random() * (60 * 1000) + 1);
					const nextExecutionTimeWithJitter = new Date(nextExecutionTime.getTime() + jitterMs);

					alarmEdits.push(
						this.drizzle
							.update(tenantLogsSchema.alarms)
							.set({
								next_time: nextExecutionTimeWithJitter,
							})
							.where(eq(tenantLogsSchema.alarms.id, sql`unhex(${row.id.toString('hex')})`))
							.limit(1),
					);
				} else {
					// Delete one-time schedules after execution
					alarmEdits.push(
						this.drizzle
							.delete(tenantLogsSchema.alarms)
							.where(eq(tenantLogsSchema.alarms.id, sql`unhex(${row.id.toString('hex')})`))
							.limit(1),
					);
				}
			} else {
				console.error(`Callee ${row.callee} not found for alarm ${hexToUuid(row.id.toString('hex'))}. Deleting alarm.`);
				alarmEdits.push(
					this.drizzle
						.delete(tenantLogsSchema.alarms)
						.where(eq(tenantLogsSchema.alarms.id, sql`unhex(${row.id.toString('hex')})`))
						.limit(1),
				);
			}
		}

		// Make sure all edits are done before scheduling the next alarm
		if (alarmEdits.length > 0) await Promise.allSettled(alarmEdits);
		this.ctx.waitUntil(this._scheduleNextAlarm());
	}

	public _cleanupPendingWebsockets() {
		this.ctx.waitUntil(this.drizzle.delete(tenantLogsSchema.pending_web_sockets).where(lte(tenantLogsSchema.pending_web_sockets.expires, new Date())));
	}

	public _optimizeDb() {
		// eslint-disable-next-line @typescript-eslint/require-await
		this.ctx.waitUntil((async () => this.drizzle.run(sql`PRAGMA optimize`))());
	}
}
