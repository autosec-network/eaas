import { DurableObject } from 'cloudflare:workers';
import { DebugLogWriter, SessionPropertiesSchema, StaticDatabase } from 'db';
import { SQLCache } from 'db/cache';
import * as rootSchema from 'db/schemas/root';
import { drizzle } from 'drizzle-orm/d1';
import { DefaultLogger } from 'drizzle-orm/logger';
import { eq, sql } from 'drizzle-orm/sql';
import type { ObjectValues } from 'types';
import type { ZodPick } from 'types/zod/mini';
import * as zm from 'zod/mini';
import type { EnvVars } from '~/types';

export class UserSession extends DurableObject<EnvVars> {
	private r_db;
	private _alarmDebounceTimer: ReturnType<typeof setTimeout> | null = null;

	constructor(ctx: DurableObjectState, env: EnvVars) {
		super(ctx, env);

		this.r_db = drizzle(env.DB_ROOT.withSession('first-unconstrained') as unknown as D1Database, {
			...(env.NODE_ENV !== 'production' && { logger: new DefaultLogger({ writer: new DebugLogWriter(env.ENVIRONMENT === 'production' ? StaticDatabase.Root.eaas_root_prod : StaticDatabase.Root.eaas_root_dev) }) }),
			cache: new SQLCache({
				dbName: env.ENVIRONMENT === 'production' ? StaticDatabase.Root.eaas_root_prod : StaticDatabase.Root.eaas_root_dev,
				dbType: 'd1',
				strategy: 'all',
				cacheTTL: parseInt(env.SQL_TTL, 10),
				logging: env.NODE_ENV !== 'production',
			}),
		});

		this.ctx.waitUntil(this._setupCleanup());
	}

	private async _setupCleanup() {
		const setAlarm = await this.ctx.storage.getAlarm({ allowConcurrency: true });

		if (setAlarm) {
			// An alarm is already set, but we still need to check in case the expires time was updated since the alarm was set (but not high priority)

			// Debounce: wait 15s of idle before re-checking to avoid rapid-fire DB queries
			if (this._alarmDebounceTimer) clearTimeout(this._alarmDebounceTimer);

			await new Promise<void>((resolve, reject) => {
				this._alarmDebounceTimer = setTimeout(() => {
					this._verifyAlarm().then(resolve).catch(reject);
				}, 15 * 1000);
			});
		} else {
			await this._verifyAlarm();
		}
	}

	private async _verifyAlarm() {
		const [row] = await this.r_db
			.select({ expires: rootSchema.users_auth_sessions.expires })
			.from(rootSchema.users_auth_sessions)
			.where(eq(rootSchema.users_auth_sessions.session_token, sql`unhex(${this.ctx.id.toString()})`))
			.limit(1)
			.then((rows) =>
				rows.map((row) => ({
					...row,
					expires: new Date(row.expires),
				})),
			);

		if (row) {
			// Are we way behind?
			if (row.expires > new Date()) {
				// Schedule the nuke as normal
				await this.ctx.storage.setAlarm(row.expires, { allowConcurrency: true });
			} else {
				// Nuke right now
				await this.nuke('Session expired (behind schedule)');
			}
		} else {
			await this.nuke('Session not found');
		}
	}

	public async getProperties(_keys?: ZodPick<typeof SessionPropertiesSchema>, lazy: boolean = true): Promise<Partial<zm.output<typeof SessionPropertiesSchema>>> {
		return zm
			.pipe(
				zm._default(
					zm.object(
						// Only load the properties that are requested
						Object.keys(SessionPropertiesSchema.def.shape).reduce(
							(acc, key) => {
								acc[key as keyof typeof SessionPropertiesSchema.def.shape] = zm._default(zm.boolean(), false);
								return acc;
							},
							{} as Record<keyof typeof SessionPropertiesSchema.def.shape, zm.ZodMiniDefault<zm.ZodMiniBoolean>>,
						),
					),
					// By default load all properties
					Object.keys(SessionPropertiesSchema.def.shape).reduce(
						(acc, key) => {
							acc[key as keyof typeof SessionPropertiesSchema.def.shape] = true;
							return acc;
						},
						{} as Record<keyof typeof SessionPropertiesSchema.def.shape, true>,
					),
				),
				zm.transform((obj) => {
					return Object.fromEntries(Object.entries(obj).filter(([, v]) => v === true)) as Record<keyof typeof SessionPropertiesSchema.def.shape, true>;
				}),
			)
			.parseAsync(_keys)
			.then((keys) =>
				this.ctx.storage
					.get<ObjectValues<zm.output<typeof SessionPropertiesSchema>>>(
						// Only get keys where value is true
						Object.entries(keys).map(([key]) => key),
						{ allowConcurrency: lazy },
					)
					.then((kv) => zm.pick(SessionPropertiesSchema, keys).parseAsync(Object.fromEntries(kv.entries()))),
			);
	}

	public getPropertiesSync(_keys?: ZodPick<typeof SessionPropertiesSchema>): Partial<zm.output<typeof SessionPropertiesSchema>> {
		const keys = zm
			.pipe(
				zm._default(
					zm.object(
						// Only load the properties that are requested
						Object.keys(SessionPropertiesSchema.def.shape).reduce(
							(acc, key) => {
								acc[key as keyof typeof SessionPropertiesSchema.def.shape] = zm._default(zm.boolean(), false);
								return acc;
							},
							{} as Record<keyof typeof SessionPropertiesSchema.def.shape, zm.ZodMiniDefault<zm.ZodMiniBoolean>>,
						),
					),
					// By default load all properties
					Object.keys(SessionPropertiesSchema.def.shape).reduce(
						(acc, key) => {
							acc[key as keyof typeof SessionPropertiesSchema.def.shape] = true;
							return acc;
						},
						{} as Record<keyof typeof SessionPropertiesSchema.def.shape, true>,
					),
				),
				zm.transform((obj) => {
					return Object.fromEntries(Object.entries(obj).filter(([, v]) => v === true)) as Record<keyof typeof SessionPropertiesSchema.def.shape, true>;
				}),
			)
			.parse(_keys);

		const kv = Object.entries(keys).reduce((map, [key]) => {
			// Sync api can only fetch 1 key at a time
			const value = this.ctx.storage.kv.get<ObjectValues<zm.output<typeof SessionPropertiesSchema>>[number]>(key);
			if (value !== undefined) map.set(key as keyof typeof SessionPropertiesSchema.def.shape, value);
			return map;
		}, new Map<keyof typeof SessionPropertiesSchema.def.shape, ObjectValues<zm.output<typeof SessionPropertiesSchema>>[number]>());
		const properties = zm.pick(SessionPropertiesSchema, keys).parse(Object.fromEntries(kv.entries()));

		return properties;
	}

	public updateProperties(_properties: Partial<zm.input<typeof SessionPropertiesSchema>>, background: boolean = true, lazy: boolean = true): Promise<Partial<zm.output<typeof SessionPropertiesSchema>>> {
		return zm
			.partial(SessionPropertiesSchema)
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

	public updatePropertiesSync(_properties: Partial<zm.input<typeof SessionPropertiesSchema>>, background: boolean = true, lazy: boolean = true): Partial<zm.output<typeof SessionPropertiesSchema>> {
		const properties = zm.partial(SessionPropertiesSchema).parse(_properties);
		if (background) {
			this.ctx.waitUntil(this.ctx.storage.put(properties, { allowConcurrency: lazy }));
		} else {
			Object.entries(properties).forEach(([key, value]) => this.ctx.storage.kv.put(key, value));
		}

		return properties;
	}

	/**
	 * Wipes all persisted state.
	 * @param reason Optional reason for the nuke.
	 * @param [hard=false] Optionally force exit the DO
	 */
	public async nuke(reason?: string, hard: boolean = false) {
		if (reason) console.warn(reason);
		await this.ctx.storage.deleteAll({ allowConcurrency: false });
		// Delete from root
		await this.r_db
			.delete(rootSchema.users_auth_sessions)
			.where(eq(rootSchema.users_auth_sessions.session_token, sql`unhex(${this.ctx.id.toString()})`))
			.limit(1);
		// To ensure that the DO is fully evicted, this.ctx.abort() is called
		// `ctx.abort` throws an uncatchable error, so we yield to the event loop to avoid capturing it and let handlers finish cleaning up
		if (hard) {
			setTimeout(() => {
				try {
					this.ctx.abort('nuked');
					// eslint-disable-next-line @typescript-eslint/no-unused-vars
				} catch (error) {
					// Do nothing
				}
			}, 0);
		}
	}

	override alarm(alarmInfo?: AlarmInvocationInfo) {
		return this.nuke(`Session expired${alarmInfo?.isRetry ? ' (drifting schedule)' : ''}`);
	}
}
