import { DurableObject } from 'cloudflare:workers';
import { DebugLogWriter, StaticDatabase } from 'db';
import * as rootSchema from 'db/schemas/root';
import { drizzle } from 'drizzle-orm/d1';
import { DefaultLogger } from 'drizzle-orm/logger';
import { eq, sql } from 'drizzle-orm/sql';
import { SQLCache } from 'helpers/db';
import type { ObjectValues } from 'types';
import type { ZodPartial, ZodPick } from 'types/zod/mini';
import * as zm from 'zod/mini';
import type { EnvVars } from '~/types';

export type SessionPropertiesPartial = zm.input<ZodPartial<typeof SessionProperties>>;

export const SessionProperties = zm.object({
	b_time: zm._default(zm.coerce.date(), () => new Date()),
	lite_binding: zm.optional(zm.base64().check(zm.trim(), zm.minLength(1))),
	normal_binding: zm.optional(zm.base64().check(zm.trim(), zm.minLength(1))),
	sensitive_binding: zm.optional(zm.base64().check(zm.trim(), zm.minLength(1))),
	generated_registration_options: zm.optional(zm.record(zm.string().check(zm.trim(), zm.minLength(1)), zm.any())),
});

export class UserSession extends DurableObject<EnvVars> {
	private r_db;

	constructor(ctx: DurableObjectState, env: EnvVars) {
		super(ctx, env);

		this.r_db = drizzle(env.DB_ROOT.withSession('first-unconstrained') as unknown as D1Database, {
			...(env.NODE_ENV !== 'production' && { logger: new DefaultLogger({ writer: new DebugLogWriter(env.ENVIRONMENT === 'production' ? StaticDatabase.Root.eaas_root_prod : StaticDatabase.Root.eaas_root_dev) }) }),
			schema: rootSchema,
			casing: 'snake_case',
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
		const [{ b_time }, setAlarm] = await Promise.all([this.getProperties({ b_time: true }), this.ctx.storage.getAlarm({ allowConcurrency: true })]);

		if (!b_time || !setAlarm) {
			const { calculated_b_time, expires } = await this.r_db
				.select({ expires: rootSchema.users_auth_sessions.expires })
				.from(rootSchema.users_auth_sessions)
				.where(eq(rootSchema.users_auth_sessions.session_token, sql`unhex(${this.ctx.id.toString()})`))
				.limit(1)
				.then((rows) =>
					rows.map((row) => ({
						expires: new Date(row.expires),
					})),
				)
				.then(async ([row]) => {
					if (row) {
						return {
							calculated_b_time: new Date(
								row.expires.getTime() -
									// days * hours * minutes * seconds * milliseconds
									14 * 24 * 60 * 60 * 1000,
							), // 14 days prior
							expires: row.expires,
						};
					} else {
						await this.nuke('Session not found');
						throw new Error('Session not found');
					}
				});

			if (!b_time) {
				await this.updateProperties({ b_time: calculated_b_time });
			}

			if (!setAlarm) {
				// Are we way behind?
				if (expires > new Date()) {
					// Schedule the nuke as normal
					await this.ctx.storage.setAlarm(expires, { allowConcurrency: true });
				} else {
					// Nuke right now
					await this.nuke('Session expired (behind schedule)');
				}
			}
		}
	}

	public async getProperties<K = ZodPick<typeof SessionProperties>>(keys?: K, lazy = true): Promise<K extends undefined ? zm.output<typeof SessionProperties> : zm.output<ZodPartial<typeof SessionProperties>>> {
		return zm
			.pipe(
				zm._default(
					zm.object(
						// Only load the properties that are requested
						Object.keys(SessionProperties.shape).reduce(
							(acc, key) => {
								acc[key as keyof typeof SessionProperties.shape] = zm._default(zm.boolean(), false);
								return acc;
							},
							{} as Record<keyof typeof SessionProperties.shape, zm.ZodMiniDefault<zm.ZodMiniBoolean>>,
						),
					),
					// By default load all properties
					Object.keys(SessionProperties.shape).reduce(
						(acc, key) => {
							acc[key as keyof typeof SessionProperties.shape] = true;
							return acc;
						},
						{} as Record<keyof typeof SessionProperties.shape, true>,
					),
				),
				zm.transform((obj) => {
					return Object.fromEntries(Object.entries(obj).filter(([, v]) => v === true)) as Record<keyof typeof SessionProperties.shape, true>;
				}),
			)
			.parseAsync(keys)
			.then((keys) =>
				this.ctx.storage
					.get<ObjectValues<zm.output<typeof SessionProperties>>>(
						// Only get keys where value is true
						Object.entries(keys).map(([key]) => key),
						{ allowConcurrency: lazy },
					)
					.then((kv) => zm.pick(SessionProperties, keys).parseAsync(Object.fromEntries(kv.entries()))),
			);
	}

	public updateProperties(properties: SessionPropertiesPartial, lazy = true): Promise<SessionPropertiesPartial> {
		return zm
			.partial(SessionProperties)
			.parseAsync(properties)
			.then((properties) => this.ctx.storage.put(properties, { allowConcurrency: lazy }).then(() => properties));
	}

	public async nuke(reason?: string) {
		if (reason) console.warn(reason);
		await this.ctx.storage.deleteAll();
		// Delete from root
		await this.r_db
			.delete(rootSchema.users_auth_sessions)
			.where(eq(rootSchema.users_auth_sessions.session_token, sql`unhex(${this.ctx.id.toString()})`))
			.limit(1);
		// To ensure that the DO is fully evicted, this.ctx.abort() is called
		// `ctx.abort` throws an uncatchable error, so we yield to the event loop to avoid capturing it and let handlers finish cleaning up
		setTimeout(() => {
			try {
				this.ctx.abort('nuked');
				// eslint-disable-next-line @typescript-eslint/no-unused-vars
			} catch (error) {
				// Do nothing
			}
		}, 0);
	}

	override alarm(alarmInfo?: AlarmInvocationInfo) {
		return this.nuke(`Session expired${alarmInfo?.isRetry ? ' (drifting schedule)' : ''}`);
	}
}
