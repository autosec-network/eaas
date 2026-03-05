import { DebugLogWriter } from 'db/core';
import * as userSchema from 'db/schemas/user';
import { drizzle, type DrizzleSqliteDODatabase } from 'drizzle-orm/durable-sqlite';
import { DefaultLogger } from 'drizzle-orm/logger';
import { asc, gt, sql } from 'drizzle-orm/sql';
import type { UUID } from 'node:crypto';
import type { MethodNames } from 'types';
import { v7 as uuidv7 } from 'uuid';
import type { EnvVars } from '~/types.mjs';
import { BaseD0 } from '~do/BaseD0.mjs';

export class UserD0 extends BaseD0 {
	protected override drizzle: DrizzleSqliteDODatabase<typeof userSchema>;

	constructor(ctx: DurableObjectState, env: EnvVars) {
		super(ctx, env);

		this.drizzle = drizzle(this._storage, {
			...(env.NODE_ENV !== 'production' && { logger: new DefaultLogger({ writer: new DebugLogWriter(ctx.id.toString()) }) }),
			casing: 'snake_case',
			schema: userSchema,
		});
	}

	protected override _migrate() {
		return Promise.all([import('drizzle-orm/durable-sqlite/migrator'), import('db/schemas/user/migrations')]).then(async ([{ migrate }, { default: migrations }]) =>
			migrate(
				await import('drizzle-orm/durable-sqlite').then(async ({ drizzle }) =>
					drizzle(this.ctx.storage, {
						...(this.env.NODE_ENV !== 'production' && { logger: await import('drizzle-orm/logger').then(async ({ DefaultLogger }) => new DefaultLogger({ writer: await import('db').then(({ DebugLogWriter, StaticDatabase }) => new DebugLogWriter(this.env.ENVIRONMENT === 'production' ? StaticDatabase.Root.eaas_root_prod : StaticDatabase.Root.eaas_root_dev)) })) }),
						casing: 'snake_case',
					}),
				),
				migrations,
			),
		);
	}

	private async _scheduleNextAlarm() {
		const [alarm] = await this.drizzle
			.select({
				next_time: userSchema.alarms.next_time,
			})
			.from(userSchema.alarms)
			.where(gt(userSchema.alarms.next_time, new Date().toISOString()))
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
	>(when: Date | number | string[], callee: MethodNames<UserD0>, payload?: T) {
		const id = uuidv7() as UUID;

		if (when instanceof Date) {
			await this.drizzle.insert(userSchema.alarms).values({
				id: sql`unhex(${id.replaceAll('-', '')})`,
				callee,
				payload,
				type: 'scheduled',
				next_time: when.toISOString(),
			});

			this.ctx.waitUntil(this._scheduleNextAlarm());

			return {
				id,
				callee,
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
				next_time: next_time.toISOString(),
			});

			this.ctx.waitUntil(this._scheduleNextAlarm());

			return {
				id,
				callee,
				payload: (payload ?? []) as T,
				next_time,
				type: 'delayed',
			} as const;
		} else if (Array.isArray(when)) {
		} else {
			throw new Error('Invalid schedule type');
		}

		const temp = Object.getOwnPropertyNames(Object.getPrototypeOf(this)).filter((prop) => typeof this[prop as keyof this] === 'function' && prop !== 'constructor') as MethodNames<UserD0>[];

		return temp;
	}
}
