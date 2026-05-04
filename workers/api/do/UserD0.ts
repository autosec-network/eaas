import { parseCronExpression } from 'cron-schedule';
import { DebugLogWriter, StaticDatabase, USER_SYSTEM_ALARMS, UserPropertiesSchema } from 'db';
import * as userSchema from 'db/schemas/user/main';
import { drizzle } from 'drizzle-orm/durable-sqlite';
import { DefaultLogger } from 'drizzle-orm/logger';
import { and, asc, eq, gt, gte, inArray, lte, sql } from 'drizzle-orm/sql';
import { hexToUuid } from 'helpers';
import type { Buffer } from 'node:buffer';
import type { UUID } from 'node:crypto';
import type { MethodNames, ObjectValues } from 'types';
import type { ZodPick } from 'types/zod/mini';
import { v7 as uuidv7 } from 'uuid';
import * as zm from 'zod/mini';
import type { EnvVars } from '~/types';
import { BaseD0 } from '~do/BaseD0';

export class UserD0 extends BaseD0 {
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
				(await import('db/schemas/user/main/migrations')).default,
			),
		);
	}

	private async _setupSystemAlarms() {
		const systemAlarmEntries = Object.entries(USER_SYSTEM_ALARMS) as [UUID, (typeof USER_SYSTEM_ALARMS)[UUID]][];

		if (systemAlarmEntries.length > 0) {
			const existingSystemAlarmIds = await this.drizzle
				.select({
					id: userSchema.alarms.id,
				})
				.from(userSchema.alarms)
				.where(inArray(userSchema.alarms.id, systemAlarmEntries.map(([id]) => sql`unhex(${id.replaceAll('-', '')})`) as unknown as [Buffer, ...Buffer[]]))
				.then((rows) => new Set(rows.map(({ id }) => hexToUuid(id.toString('hex')))));

			const missingSystemAlarms = systemAlarmEntries.filter(([id]) => !existingSystemAlarmIds.has(id)).map(([id, alarm]) => this.schedule(alarm.when, alarm.callee as MethodNames<UserD0>, alarm.payload, id));

			if (missingSystemAlarms.length > 0) await Promise.allSettled(missingSystemAlarms);
		}
	}

	private async _scheduleNextAlarm() {
		const [alarm] = await this.drizzle
			.select({
				next_time: userSchema.alarms.next_time,
			})
			.from(userSchema.alarms)
			.where(gt(userSchema.alarms.next_time, new Date()))
			.orderBy(asc(userSchema.alarms.next_time))
			.limit(1)
			.then((rows) =>
				rows.map((row) => ({
					...row,
					next_time: new Date(row.next_time),
				})),
			);

		if (alarm) await this.ctx.storage.setAlarm(alarm.next_time, { allowConcurrency: true });
	}

	public async schedule<
		// eslint-disable-next-line @typescript-eslint/no-explicit-any
		T extends any[] = any[],
	>(when: Date | number | string[], callee: MethodNames<UserD0>, payload?: T, id?: UUID) {
		id ??= uuidv7() as UUID;

		if (when instanceof Date) {
			await this.drizzle.insert(userSchema.alarms).values({
				id: sql`unhex(${id.replaceAll('-', '')})`,
				callee,
				payload,
				type: 'scheduled',
				next_time: when,
			});

			this.ctx.waitUntil(this._scheduleNextAlarm());

			return {
				id,
				payload: (payload ?? []) as T,
				next_time: when,
				type: 'scheduled',
			} as const;
		} else if (typeof when === 'number') {
			const next_time = new Date(Date.now() + when * 1000);

			await this.drizzle.insert(userSchema.alarms).values({
				id: sql`unhex(${id.replaceAll('-', '')})`,
				callee,
				payload,
				type: 'delayed',
				delay_in_seconds: when,
				next_time,
			});

			this.ctx.waitUntil(this._scheduleNextAlarm());

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

			await this.drizzle.insert(userSchema.alarms).values({
				id: sql`unhex(${id.replaceAll('-', '')})`,
				callee,
				payload,
				type: 'cron',
				cron: when,
				next_time: nextExecutionTimeWithJitter,
			});

			this.ctx.waitUntil(this._scheduleNextAlarm());

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
			.from(userSchema.alarms)
			.where(eq(userSchema.alarms.id, sql`unhex(${id.replaceAll('-', '')})`))
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
			.from(userSchema.alarms)
			.where(
				and(
					...(criteria.id ? [eq(userSchema.alarms.id, sql`unhex(${criteria.id.replaceAll('-', '')})`)] : []),
					...(criteria.type ? [eq(userSchema.alarms.type, criteria.type)] : []),
					...(criteria.timeRange
						? [
								// After start date or epoch
								gte(userSchema.alarms.next_time, criteria.timeRange.start ?? new Date(0)),
								// Until end date or max date
								lte(userSchema.alarms.next_time, criteria.timeRange.end ?? new Date(Number(BigInt('0x0fffffffffff')))),
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
			.delete(userSchema.alarms)
			.where(eq(userSchema.alarms.id, sql`unhex(${id.replaceAll('-', '')})`))
			.limit(1);

		this.ctx.waitUntil(this._scheduleNextAlarm());
	}

	override async alarm() {
		let now = new Date();

		const rows = await this.drizzle
			.select({
				id: userSchema.alarms.id,
				callee: userSchema.alarms.callee,
				payload: userSchema.alarms.payload,
				type: userSchema.alarms.type,
				next_time: userSchema.alarms.next_time,
				cron: userSchema.alarms.cron,
			})
			.from(userSchema.alarms)
			.where(lte(userSchema.alarms.next_time, now));

		const alarmEdits: Promise<unknown>[] = [];
		for (const row of rows) {
			if (row.callee in this) {
				if (this.env.NODE_ENV !== 'production') console.debug(`Executing alarm ${hexToUuid(row.id.toString('hex'))} with a drift of ${(Date.now() - new Date(row.next_time).getTime()) / 1000} seconds`);

				try {
					// `Reflect.apply`'s second argument rebinds `this` correctly; the rule can't see that through the extraction.
					// eslint-disable-next-line @typescript-eslint/unbound-method
					await Reflect.apply(this[row.callee as keyof UserD0]!, this, row.payload);
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
							.update(userSchema.alarms)
							.set({
								next_time: nextExecutionTimeWithJitter,
							})
							.where(eq(userSchema.alarms.id, sql`unhex(${row.id.toString('hex')})`))
							.limit(1),
					);
				} else {
					// Delete one-time schedules after execution
					alarmEdits.push(
						this.drizzle
							.delete(userSchema.alarms)
							.where(eq(userSchema.alarms.id, sql`unhex(${row.id.toString('hex')})`))
							.limit(1),
					);
				}
			} else {
				console.error(`Callee ${row.callee} not found for alarm ${hexToUuid(row.id.toString('hex'))}. Deleting alarm.`);
				alarmEdits.push(
					this.drizzle
						.delete(userSchema.alarms)
						.where(eq(userSchema.alarms.id, sql`unhex(${row.id.toString('hex')})`))
						.limit(1),
				);
			}
		}

		// Make sure all edits are done before scheduling the next alarm
		if (alarmEdits.length > 0) await Promise.allSettled(alarmEdits);
		this.ctx.waitUntil(this._scheduleNextAlarm());
	}

	public _cleanupVerificationTokens() {
		this.ctx.waitUntil(this.drizzle.delete(userSchema.auth_verification_token).where(lte(userSchema.auth_verification_token.expires, new Date())));
	}

	public async getProperties(_keys?: ZodPick<typeof UserPropertiesSchema>, lazy: boolean = true): Promise<Partial<zm.output<typeof UserPropertiesSchema>>> {
		return zm
			.pipe(
				zm._default(
					zm.object(
						// Only load the properties that are requested
						Object.keys(UserPropertiesSchema.def.shape).reduce(
							(acc, key) => {
								acc[key as keyof typeof UserPropertiesSchema.def.shape] = zm._default(zm.boolean(), false);
								return acc;
							},
							{} as Record<keyof typeof UserPropertiesSchema.def.shape, zm.ZodMiniDefault<zm.ZodMiniBoolean>>,
						),
					),
					// By default load all properties
					Object.keys(UserPropertiesSchema.def.shape).reduce(
						(acc, key) => {
							acc[key as keyof typeof UserPropertiesSchema.def.shape] = true;
							return acc;
						},
						{} as Record<keyof typeof UserPropertiesSchema.def.shape, true>,
					),
				),
				zm.transform((obj) => {
					return Object.fromEntries(Object.entries(obj).filter(([, v]) => v === true)) as Record<keyof typeof UserPropertiesSchema.def.shape, true>;
				}),
			)
			.parseAsync(_keys)
			.then((keys) =>
				this.ctx.storage
					.get<ObjectValues<zm.output<typeof UserPropertiesSchema>>>(
						// Only get keys where value is true
						Object.entries(keys).map(([key]) => key),
						{ allowConcurrency: lazy },
					)
					.then((kv) => zm.pick(UserPropertiesSchema, keys).parseAsync(Object.fromEntries(kv.entries()))),
			);
	}

	public getPropertiesSync(_keys?: ZodPick<typeof UserPropertiesSchema>): Partial<zm.output<typeof UserPropertiesSchema>> {
		const keys = zm
			.pipe(
				zm._default(
					zm.object(
						// Only load the properties that are requested
						Object.keys(UserPropertiesSchema.def.shape).reduce(
							(acc, key) => {
								acc[key as keyof typeof UserPropertiesSchema.def.shape] = zm._default(zm.boolean(), false);
								return acc;
							},
							{} as Record<keyof typeof UserPropertiesSchema.def.shape, zm.ZodMiniDefault<zm.ZodMiniBoolean>>,
						),
					),
					// By default load all properties
					Object.keys(UserPropertiesSchema.def.shape).reduce(
						(acc, key) => {
							acc[key as keyof typeof UserPropertiesSchema.def.shape] = true;
							return acc;
						},
						{} as Record<keyof typeof UserPropertiesSchema.def.shape, true>,
					),
				),
				zm.transform((obj) => {
					return Object.fromEntries(Object.entries(obj).filter(([, v]) => v === true)) as Record<keyof typeof UserPropertiesSchema.def.shape, true>;
				}),
			)
			.parse(_keys);

		const kv = Object.entries(keys).reduce((map, [key]) => {
			// Sync api can only fetch 1 key at a time
			const value = this.ctx.storage.kv.get<ObjectValues<zm.output<typeof UserPropertiesSchema>>[number]>(key);
			if (value !== undefined) map.set(key as keyof typeof UserPropertiesSchema.def.shape, value);
			return map;
		}, new Map<keyof typeof UserPropertiesSchema.def.shape, ObjectValues<zm.output<typeof UserPropertiesSchema>>[number]>());
		const properties = zm.pick(UserPropertiesSchema, keys).parse(Object.fromEntries(kv.entries()));

		return properties;
	}

	public updateProperties(_properties: Partial<zm.input<typeof UserPropertiesSchema>>, background: boolean = false, lazy: boolean = true): Promise<Partial<zm.output<typeof UserPropertiesSchema>>> {
		return zm
			.partial(UserPropertiesSchema)
			.parseAsync(_properties)
			.then(async (properties) => {
				const savingPromise = this.ctx.storage.put(properties, { allowConcurrency: lazy });
				if (background) {
					this.ctx.waitUntil(savingPromise);
				} else {
					await savingPromise;
				}

				return properties;
			});
	}

	public updatePropertiesSync(_properties: Partial<zm.input<typeof UserPropertiesSchema>>, background: boolean = false, lazy: boolean = true): Partial<zm.output<typeof UserPropertiesSchema>> {
		const properties = zm.partial(UserPropertiesSchema).parse(_properties);
		if (background) {
			this.ctx.waitUntil(this.ctx.storage.put(properties, { allowConcurrency: lazy }));
		} else {
			Object.entries(properties).forEach(([key, value]) => this.ctx.storage.kv.put(key, value));
		}

		return properties;
	}
}
