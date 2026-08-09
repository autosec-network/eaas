import { parseCronExpression } from 'cron-schedule';
import { TENANT_SYSTEM_ALARMS, TenantPropertiesSchema } from 'db';
import { DebugLogWriter, StaticDatabase } from 'db/core';
import * as tenantSchema from 'db/schemas/tenant/main';
import { drizzle } from 'drizzle-orm/durable-sqlite';
import { DefaultLogger } from 'drizzle-orm/logger';
import { and, asc, eq, gt, gte, inArray, lte, sql } from 'drizzle-orm/sql';
import { hexToUuid } from 'helpers';
import { ZodUuidInputConverted } from 'helpers/zod/mini';
import type { Buffer } from 'node:buffer';
import type { UUID } from 'node:crypto';
import { DOJurisdictions, type MethodNames, type ObjectValues } from 'types';
import { BitwardenCloudEndpoints } from 'types/bw';
import type { ZodPick } from 'types/zod/mini';
import { v7 as uuidv7 } from 'uuid';
import * as zm from 'zod/mini';
import type { EnvVars } from '~/types';
import { BaseD0 } from '~do/BaseD0';

export class TenantD0 extends BaseD0 {
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
				(await import('db/schemas/tenant/main/migrations')).default,
			),
		);
	}

	private async _setupSystemAlarms() {
		const systemAlarmEntries = Object.entries(TENANT_SYSTEM_ALARMS) as [UUID, (typeof TENANT_SYSTEM_ALARMS)[UUID]][];

		if (systemAlarmEntries.length > 0) {
			const existingSystemAlarmIds = await this.drizzle
				.select({
					id: tenantSchema.alarms.id,
				})
				.from(tenantSchema.alarms)
				.where(inArray(tenantSchema.alarms.id, systemAlarmEntries.map(([id]) => sql`unhex(${id.replaceAll('-', '')})`) as unknown as [Buffer, ...Buffer[]]))
				.then((rows) => new Set(rows.map(({ id }) => hexToUuid(id.toString('hex')))));

			const missingSystemAlarms = systemAlarmEntries.filter(([id]) => !existingSystemAlarmIds.has(id)).map(([id, alarm]) => this.schedule(alarm.when, alarm.callee as MethodNames<TenantD0>, alarm.payload, id));

			if (missingSystemAlarms.length > 0) await Promise.allSettled(missingSystemAlarms);
		}
	}

	private async _scheduleNextAlarm() {
		const [alarm] = await this.drizzle
			.select({
				next_time: tenantSchema.alarms.next_time,
			})
			.from(tenantSchema.alarms)
			.where(gt(tenantSchema.alarms.next_time, new Date()))
			.orderBy(asc(tenantSchema.alarms.next_time))
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
	>(when: Date | number | string[], callee: MethodNames<TenantD0>, payload?: T, id?: UUID) {
		id ??= uuidv7() as UUID;

		if (when instanceof Date) {
			await this.drizzle.insert(tenantSchema.alarms).values({
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

			await this.drizzle.insert(tenantSchema.alarms).values({
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

			await this.drizzle.insert(tenantSchema.alarms).values({
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
			.from(tenantSchema.alarms)
			.where(eq(tenantSchema.alarms.id, sql`unhex(${id.replaceAll('-', '')})`))
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
			.from(tenantSchema.alarms)
			.where(
				and(
					...(criteria.id ? [eq(tenantSchema.alarms.id, sql`unhex(${criteria.id.replaceAll('-', '')})`)] : []),
					...(criteria.type ? [eq(tenantSchema.alarms.type, criteria.type)] : []),
					...(criteria.timeRange
						? [
								// After start date or epoch
								gte(tenantSchema.alarms.next_time, criteria.timeRange.start ?? new Date(0)),
								// Until end date or max date
								lte(tenantSchema.alarms.next_time, criteria.timeRange.end ?? new Date(Number(BigInt('0x0fffffffffff')))),
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
			.delete(tenantSchema.alarms)
			.where(eq(tenantSchema.alarms.id, sql`unhex(${id.replaceAll('-', '')})`))
			.limit(1);

		this.ctx.waitUntil(this._scheduleNextAlarm());
	}

	override async alarm() {
		let now = new Date();

		const rows = await this.drizzle
			.select({
				id: tenantSchema.alarms.id,
				callee: tenantSchema.alarms.callee,
				payload: tenantSchema.alarms.payload,
				type: tenantSchema.alarms.type,
				next_time: tenantSchema.alarms.next_time,
				cron: tenantSchema.alarms.cron,
			})
			.from(tenantSchema.alarms)
			.where(lte(tenantSchema.alarms.next_time, now));

		const alarmEdits: Promise<unknown>[] = [];
		for (const row of rows) {
			if (row.callee in this) {
				if (this.env.NODE_ENV !== 'production') console.debug(`Executing alarm ${hexToUuid(row.id.toString('hex'))} with a drift of ${(Date.now() - new Date(row.next_time).getTime()) / 1000} seconds`);

				try {
					// `Reflect.apply`'s second argument rebinds `this` correctly; the rule can't see that through the extraction.
					// eslint-disable-next-line @typescript-eslint/unbound-method
					await Reflect.apply(this[row.callee as keyof TenantD0]!, this, row.payload);
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
							.update(tenantSchema.alarms)
							.set({
								next_time: nextExecutionTimeWithJitter,
							})
							.where(eq(tenantSchema.alarms.id, sql`unhex(${row.id.toString('hex')})`))
							.limit(1),
					);
				} else {
					// Delete one-time schedules after execution
					alarmEdits.push(
						this.drizzle
							.delete(tenantSchema.alarms)
							.where(eq(tenantSchema.alarms.id, sql`unhex(${row.id.toString('hex')})`))
							.limit(1),
					);
				}
			} else {
				console.error(`Callee ${row.callee} not found for alarm ${hexToUuid(row.id.toString('hex'))}. Deleting alarm.`);
				alarmEdits.push(
					this.drizzle
						.delete(tenantSchema.alarms)
						.where(eq(tenantSchema.alarms.id, sql`unhex(${row.id.toString('hex')})`))
						.limit(1),
				);
			}
		}

		// Make sure all edits are done before scheduling the next alarm
		if (alarmEdits.length > 0) await Promise.allSettled(alarmEdits);
		this.ctx.waitUntil(this._scheduleNextAlarm());
	}

	/**
	 * Sweeps expired rows out of `verification_tokens`. Scheduled by {@link TENANT_SYSTEM_ALARMS} every 15 minutes - the same window a token is valid for, so a redeemed-or-abandoned approval never lingers much past its own lifetime.
	 *
	 * Expiry is enforced at redemption time too (the lookup filters on `expires`), so this is hygiene rather than a security boundary.
	 */
	public _cleanupVerificationTokens() {
		this.ctx.waitUntil(this.drizzle.delete(tenantSchema.verification_tokens).where(lte(tenantSchema.verification_tokens.expires, new Date())));
	}

	public static registerBitwardenSessionOptions = zm.object({
		/**
		 * The session Durable Object's own id, as `DurableObjectId.toString()` renders it.
		 */
		do_id: zm.hex().check(zm.trim(), zm.toLowerCase(), zm.length(64)),
		/**
		 * sha512 of the credentials the session authenticated with - see `bitwardenSessionFingerprint` in `helpers/bitwarden-sessions`.
		 */
		fingerprint: zm.hex().check(zm.trim(), zm.toLowerCase(), zm.length(128)),
		/**
		 * From the session's JWT `exp` claim, which is also when it wakes up to nuke itself.
		 */
		expires: zm.date(),
	});
	/**
	 * Add a freshly authenticated Bitwarden session to this tenant's reusable pool.
	 *
	 * Called by the session itself the moment `auth()` succeeds, never by whoever asked for the session - the session is the only thing that knows its own id and expiry, and making it own its own registration is what keeps a borrower from having to think about the pool at all.
	 *
	 * Idempotent by id: a re-registration just refreshes the row, so a session that somehow registers twice can't leave a stale expiry behind.
	 */
	public async registerBitwardenSession(_options: zm.input<typeof TenantD0.registerBitwardenSessionOptions>) {
		const options = await TenantD0.registerBitwardenSessionOptions.parseAsync(_options);

		await this.drizzle
			.insert(tenantSchema.bitwarden_sessions)
			.values({
				do_id: sql`unhex(${options.do_id})`,
				fingerprint: sql`unhex(${options.fingerprint})`,
				expires: options.expires,
				b_time: new Date(),
			})
			.onConflictDoUpdate({
				target: tenantSchema.bitwarden_sessions.do_id,
				set: {
					fingerprint: sql`unhex(${options.fingerprint})`,
					expires: options.expires,
					b_time: new Date(),
				},
			});
	}

	public static listBitwardenSessionsOptions = zm._default(
		zm.object({
			/**
			 * Only sessions authenticated with these exact credentials. Omitted means every session this tenant has, which is what the admin dashboard wants and what a borrower never does - sessions on different credentials aren't interchangeable.
			 */
			fingerprint: zm.optional(zm.hex().check(zm.trim(), zm.toLowerCase(), zm.length(128))),
			/**
			 * Include rows whose session has already expired. Off by default: an expired session is unusable, and its row lingering is a symptom worth looking at rather than something to hand out.
			 */
			includeExpired: zm._default(zm.boolean(), false),
		}),
		{ includeExpired: false },
	);
	/**
	 * This tenant's pooled Bitwarden sessions. Ids come back as hex strings ready for `idFromString()`.
	 */
	public async listBitwardenSessions(_options?: zm.input<typeof TenantD0.listBitwardenSessionsOptions>) {
		const options = await TenantD0.listBitwardenSessionsOptions.parseAsync(_options);

		return this.drizzle
			.select()
			.from(tenantSchema.bitwarden_sessions)
			.where(and(...(options.fingerprint ? [eq(tenantSchema.bitwarden_sessions.fingerprint, sql`unhex(${options.fingerprint})`)] : []), ...(options.includeExpired ? [] : [gt(tenantSchema.bitwarden_sessions.expires, new Date())])))
			.then((rows) =>
				rows.map((row) => ({
					do_id: row.do_id.toString('hex'),
					fingerprint: row.fingerprint.toString('hex'),
					expires: row.expires,
					b_time: row.b_time,
				})),
			);
	}

	/**
	 * Forget a pooled session. Sent by a session tearing itself down, and by a borrower that found a row naming a session which no longer answers.
	 */
	public async unregisterBitwardenSession(do_id: string) {
		const parsed = await zm.hex().check(zm.trim(), zm.toLowerCase(), zm.length(64)).parseAsync(do_id);

		await this.drizzle
			.delete(tenantSchema.bitwarden_sessions)
			.where(eq(tenantSchema.bitwarden_sessions.do_id, sql`unhex(${parsed})`))
			.limit(1);
	}

	public async getProperties(_keys?: ZodPick<typeof TenantPropertiesSchema>, lazy: boolean = true): Promise<Partial<zm.output<typeof TenantPropertiesSchema>>> {
		return zm
			.pipe(
				zm._default(
					zm.object(
						// Only load the properties that are requested
						Object.keys(TenantPropertiesSchema.def.shape).reduce(
							(acc, key) => {
								acc[key as keyof typeof TenantPropertiesSchema.def.shape] = zm._default(zm.boolean(), false);
								return acc;
							},
							{} as Record<keyof typeof TenantPropertiesSchema.def.shape, zm.ZodMiniDefault<zm.ZodMiniBoolean>>,
						),
					),
					// By default load all properties
					Object.keys(TenantPropertiesSchema.def.shape).reduce(
						(acc, key) => {
							acc[key as keyof typeof TenantPropertiesSchema.def.shape] = true;
							return acc;
						},
						{} as Record<keyof typeof TenantPropertiesSchema.def.shape, true>,
					),
				),
				zm.transform((obj) => {
					return Object.fromEntries(Object.entries(obj).filter(([, v]) => v === true)) as Record<keyof typeof TenantPropertiesSchema.def.shape, true>;
				}),
			)
			.parseAsync(_keys)
			.then((keys) =>
				this.ctx.storage
					.get<ObjectValues<zm.output<typeof TenantPropertiesSchema>>>(
						// Only get keys where value is true
						Object.entries(keys).map(([key]) => key),
						{ allowConcurrency: lazy },
					)
					.then((kv) => zm.pick(TenantPropertiesSchema, keys).parseAsync(Object.fromEntries(kv.entries()))),
			);
	}

	public getPropertiesSync(_keys?: ZodPick<typeof TenantPropertiesSchema>): Partial<zm.output<typeof TenantPropertiesSchema>> {
		const keys = zm
			.pipe(
				zm._default(
					zm.object(
						// Only load the properties that are requested
						Object.keys(TenantPropertiesSchema.def.shape).reduce(
							(acc, key) => {
								acc[key as keyof typeof TenantPropertiesSchema.def.shape] = zm._default(zm.boolean(), false);
								return acc;
							},
							{} as Record<keyof typeof TenantPropertiesSchema.def.shape, zm.ZodMiniDefault<zm.ZodMiniBoolean>>,
						),
					),
					// By default load all properties
					Object.keys(TenantPropertiesSchema.def.shape).reduce(
						(acc, key) => {
							acc[key as keyof typeof TenantPropertiesSchema.def.shape] = true;
							return acc;
						},
						{} as Record<keyof typeof TenantPropertiesSchema.def.shape, true>,
					),
				),
				zm.transform((obj) => {
					return Object.fromEntries(Object.entries(obj).filter(([, v]) => v === true)) as Record<keyof typeof TenantPropertiesSchema.def.shape, true>;
				}),
			)
			.parse(_keys);

		const kv = Object.entries(keys).reduce((map, [key]) => {
			// Sync api can only fetch 1 key at a time
			const value = this.ctx.storage.kv.get<ObjectValues<zm.output<typeof TenantPropertiesSchema>>[number]>(key);
			if (value !== undefined) map.set(key as keyof typeof TenantPropertiesSchema.def.shape, value);
			return map;
		}, new Map<keyof typeof TenantPropertiesSchema.def.shape, ObjectValues<zm.output<typeof TenantPropertiesSchema>>[number]>());
		const properties = zm.pick(TenantPropertiesSchema, keys).parse(Object.fromEntries(kv.entries()));

		return properties;
	}

	public updateProperties(_properties: Partial<zm.input<typeof TenantPropertiesSchema>>, background: boolean = false, lazy: boolean = true): Promise<Partial<zm.output<typeof TenantPropertiesSchema>>> {
		return zm
			.partial(TenantPropertiesSchema)
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

	public updatePropertiesSync(_properties: Partial<zm.input<typeof TenantPropertiesSchema>>, background: boolean = false, lazy: boolean = true): Partial<zm.output<typeof TenantPropertiesSchema>> {
		const properties = zm.partial(TenantPropertiesSchema).parse(_properties);
		if (background) {
			this.ctx.waitUntil(this.ctx.storage.put(properties, { allowConcurrency: lazy }));
		} else {
			Object.entries(properties).forEach(([key, value]) => this.ctx.storage.kv.put(key, value));
		}

		return properties;
	}

	/**
	 * Deletes the secrets this tenant owns in Autosec's **root** Bitwarden organization — its BYO connection secret and its Noise static private key. Neither holds tenant data: `byo_bw` points at the customer's own vault (their access token and project), and `noise_bw` is transport key material. Removing them forgets the connection rather than destroying anything the customer stored.
	 *
	 * Opens a session of its own rather than borrowing from the pool, and ends it when done: the pool is being torn down in the same breath, so a pooled session would only have to be dismantled again a moment later. `t_do_id: null` keeps it out of the pool and `t_id: null` keeps it from logging — this session must leave no trace addressed to a tenant that is about to stop existing.
	 *
	 * Before deleting, confirms each secret actually lives in the project the caller expects. `byo_bw`/`noise_bw` are only id pointers, so this catches one having drifted onto the wrong project (a dev-onboarded tenant's row pointing at a prod secret, say) instead of silently deleting someone else's secret. Throws on anything unexpected — this runs ahead of the wipes in {@link purge} precisely so a failure here leaves the tenant intact and the delete retryable.
	 */
	private async _deleteRootBitwardenSecrets(jurisdiction: DOJurisdictions | null, projectId: string, secretIds: string[], reason: string) {
		const isEu = jurisdiction === DOJurisdictions['The European Union'];
		const namespace = jurisdiction ? this.env.BITWARDEN_SESSION.jurisdiction(jurisdiction) : this.env.BITWARDEN_SESSION;
		const stub = this.env.BITWARDEN_SESSION.get(namespace.newUniqueId());

		try {
			await stub.init({
				t_jurisdiction: jurisdiction,
				t_do_id: null,
				t_id: null,
				u_id: null,
				ak_id: null,
				endpoints: {
					base: isEu ? BitwardenCloudEndpoints.Api.eu : BitwardenCloudEndpoints.Api.us,
					authentication: isEu ? BitwardenCloudEndpoints.Identity.eu : BitwardenCloudEndpoints.Identity.us,
				},
			});
			await stub.auth(isEu ? this.env.EU_BW_SM_ACCESS_TOKEN : this.env.US_BW_SM_ACCESS_TOKEN);

			const secrets = await stub.getSecrets(secretIds);
			secretIds.forEach((secretId) => {
				const secret = secrets.find(({ id }) => id === secretId);
				if (!secret?.projects.some((project) => project.id === projectId)) {
					throw new Error(`Root bitwarden secret ${secretId} does not belong to the expected project ${projectId} — refusing to delete`);
				}
			});

			await stub.deleteSecrets(secretIds);
		} finally {
			// Soft, so it resolves instead of rejecting with the `nuked` an `abort()` would produce — a `finally` that throws replaces whatever the `try` returned or threw, and would mask a real error above
			await stub.nuke(`${reason} (root secret cleanup session)`, false).catch((error: unknown) => console.error('Failed to end root bitwarden secret cleanup session', error));
		}
	}

	public static purgeOptions = zm.object({
		/**
		 * This tenant's own id, in any encoding. Has to be told to it: nothing in this object's storage records which tenant it is, and `ctx.id.name` is `undefined` for an object reached through `idFromString()` — which is how every caller holding a root `do_id` reaches it.
		 */
		t_id: ZodUuidInputConverted(7),
		/**
		 * Which jurisdiction this tenant's objects were minted in. `idFromName()` only resolves on the same (sub)namespace that created the id, so the logs object is unreachable without it.
		 */
		jurisdiction: zm.nullable(zm.enum(DOJurisdictions)),
		/**
		 * The root Bitwarden project this tenant's secrets are expected to live in, or `null` to leave the vault entirely alone. Told to it rather than read from `env` because a tenant onboarded through the dev admin environment keeps its secrets in the dev project while still living in this (prod) Durable Object namespace — only the caller knows which. `null` is for a caller that has already dealt with the secrets itself (see `VaultMigration`'s 'Purge old vault secrets' step).
		 */
		rootBitwardenProjectId: zm.nullable(zm.uuidv4().check(zm.trim())),
		reason: zm._default(zm.string().check(zm.trim(), zm.minLength(1)), 'Tenant purged'),
	});
	/**
	 * Ends this tenant completely: its pooled Bitwarden sessions, its secrets in the root organization, its logs Durable Object, and finally its own storage — **in that order, from inside the tenant itself**.
	 *
	 * Ordering is the whole point of doing it here rather than from the caller. Every one of these resources is reached *through* this object or names it, so anything still in flight when its storage goes lands afterwards and rebuilds what it touched: a session deregistering into a wiped tenant, or its closing audit row reaching a wiped logs object, recreates that object's schema and re-arms its cron alarms, leaving an orphan that keeps itself alive forever and that no root row can be traced back to. Sequenced from in here, each stage is finished — not merely started — before the next one removes what it depended on, and the sessions are told the tenant is going (see `BitwardenSession.nuke`) so they stop addressing it at all.
	 *
	 * What's left for the caller is the root `tenants` row, deliberately: `do_id` lives only there, so dropping it before these wipes would strand storage nobody can address anymore. A failure here therefore throws with the root row still intact and the delete safe to retry. Sessions are the one best-effort stage — one that can't be reached is worth a log line, never a reason to abandon a delete that was asked for; it expires on its own soon enough.
	 *
	 * The self-wipe is soft (no `abort()`), so this resolves normally with a summary instead of rejecting with the `nuked` a hard nuke produces. A rejection from `purge()` is a real failure, and callers can treat it as one.
	 */
	public async purge(_options: zm.input<typeof TenantD0.purgeOptions>) {
		const options = await TenantD0.purgeOptions.parseAsync(_options);

		// Read before any of the wipes below takes it away
		const { byo_bw, noise_bw } = await this.getProperties({ byo_bw: true, noise_bw: true }, true);

		const sessionNamespace = options.jurisdiction ? this.env.BITWARDEN_SESSION.jurisdiction(options.jurisdiction) : this.env.BITWARDEN_SESSION;
		const sessions = await this.listBitwardenSessions({ includeExpired: true }).catch((error: unknown) => {
			console.error('Failed to list pooled bitwarden sessions for tenant purge', error);
			return [];
		});
		const settled = await Promise.allSettled(sessions.map(({ do_id }) => this.env.BITWARDEN_SESSION.get(sessionNamespace.idFromString(do_id)).nuke(options.reason, false, true)));
		settled.forEach((result) => {
			// A session nuked softly resolves normally, so unlike a hard nuke there's no expected rejection to filter out here
			if (result.status === 'rejected') console.error('Failed to nuke pooled bitwarden session', result.reason);
		});

		const secretIds = [byo_bw, noise_bw].filter((secretId): secretId is string => Boolean(secretId));
		if (options.rootBitwardenProjectId && secretIds.length > 0) await this._deleteRootBitwardenSecrets(options.jurisdiction, options.rootBitwardenProjectId, secretIds, options.reason);

		// The audit log lives in an object of its own, named after this tenant. Leaving it behind would strand a store of request metadata nothing can reach anymore.
		const logsNamespace = options.jurisdiction ? this.env.TENANT_D0_LOGS.jurisdiction(options.jurisdiction) : this.env.TENANT_D0_LOGS;
		await this.env.TENANT_D0_LOGS.get(logsNamespace.idFromName(`${options.t_id.utf8}_logs`)).nuke(options.reason, false);

		// Last, and last for a reason: nothing after this line can rely on this object's storage still being there
		await this.nuke(options.reason, false);

		return {
			sessions: settled.filter(({ status }) => status === 'fulfilled').length,
			totalSessions: sessions.length,
			secrets: options.rootBitwardenProjectId ? secretIds.length : 0,
		};
	}
}
