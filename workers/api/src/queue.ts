import { DebugLogWriter, drizzleD0 } from 'db/core';
import * as rootSchema from 'db/schemas/root';
import * as tenantLogsSchema from 'db/schemas/tenant/logs';
import { drizzle } from 'drizzle-orm/d1';
import { DefaultLogger } from 'drizzle-orm/logger';
import { eq, sql } from 'drizzle-orm/sql';
import { hexToUuid } from 'helpers';
import type { DOJurisdictions } from 'types';
import { TenantLogQueueMessageSchema, type TenantLogQueueMessage } from 'types/tenants/logging';
import * as zm from 'zod/mini';
import type { EnvVars } from '~/types';

/**
 * Every log in one batch that belongs to the same tenant, alongside the messages they arrived on so the whole group can be acked or retried together.
 */
interface TenantLogGroup {
	t_id: TenantLogQueueMessage['t_id'];
	jurisdiction: DOJurisdictions | null;
	logs: TenantLogQueueMessage[];
	messages: Message<zm.input<typeof TenantLogQueueMessageSchema>>[];
}

/**
 * Whether `t_id_hex` is a tenant this batch is allowed to write logs for, checked cheapest-first: does its own logs DO already have a row (true for any tenant a few messages into its life), then does its root row exist (the only signal left for a tenant so new its logs DO is still empty). A tenant that fails both is either mid-onboarding-rollback, already purged, or - just as likely - the root lookup below hit a stale `first-unconstrained` D1 read of a tenant that exists but hasn't replicated yet. Writing on a false "doesn't exist" would resurrect a logs DO as an orphan nothing will ever clean up again (see `workers/api/AGENTS.md`), so a "no" here isn't trusted as final - see the caller, which retries rather than acking.
 *
 * A thrown check (D1/DO outage, not a "the tenant doesn't exist" answer) is left to propagate - the caller's `catch` retries the whole group on it the same way.
 */
async function tenantIsLegitimate(env: EnvVars, logsDb: ReturnType<typeof drizzleD0>, t_id_hex: string): Promise<boolean> {
	const [priorLog] = await logsDb.select({ id: tenantLogsSchema.logs.id }).from(tenantLogsSchema.logs).limit(1);
	if (priorLog) return true;

	const r_db = drizzle(env.DB_ROOT.withSession('first-unconstrained') as unknown as D1Database);
	const [tenantRow] = await r_db
		.select({ t_id: rootSchema.tenants.t_id })
		.from(rootSchema.tenants)
		.where(eq(rootSchema.tenants.t_id, sql`unhex(${t_id_hex})`))
		.limit(1);
	return Boolean(tenantRow);
}

export async function main(batch: MessageBatch<zm.input<typeof TenantLogQueueMessageSchema>>, env: EnvVars, ctx: ExecutionContext) {
	const logs = await Promise.all(
		batch.messages.map(async (message) => {
			const parsed = await TenantLogQueueMessageSchema.safeParseAsync(message.body);

			if (parsed.success) return parsed.data;

			// A malformed message can never become valid, so acking beats burning all `max_retries` on it and blocking nothing but itself
			console.error('Dropping unparseable tenant log message', message.id, zm.prettifyError(parsed.error));
			message.ack();
			return undefined;
		}),
	);

	const groups = new Map<string, TenantLogGroup>();

	logs.forEach((log, index) => {
		// `undefined` marks a message that failed to parse - already acked by the caller, so there's nothing left to group
		if (!log) return;

		const jurisdiction = log.jurisdiction ?? null;
		const key = `${log.t_id}|${jurisdiction ?? ''}`;
		const group = groups.get(key) ?? { t_id: log.t_id, jurisdiction, logs: [], messages: [] };

		group.logs.push(log);
		group.messages.push(batch.messages[index]!);
		groups.set(key, group);
	});

	await Promise.all(
		Array.from(groups.values()).map(async (group) => {
			try {
				// The logs DO id is never stored anywhere — it's always derived from the tenant id, with a `_logs` suffix (see the customer onboarding action that mints it)
				const namespace = group.jurisdiction ? env.TENANT_D0_LOGS.jurisdiction(group.jurisdiction) : env.TENANT_D0_LOGS;
				const doName = `${hexToUuid(group.t_id)}_logs`;
				// No cache — this path only ever writes. `throwOnError` is what lets a failed write reach the `.catch` below instead of being swallowed into an empty result set, so the difference between acking and retrying is knowable.
				const db = drizzleD0(namespace.get(namespace.idFromName(doName)), {
					...(env.NODE_ENV !== 'production' && { logger: new DefaultLogger({ writer: new DebugLogWriter(doName) }) }),
					throwOnError: true,
				});

				if (!(await tenantIsLegitimate(env, db, group.t_id))) {
					// Not acked: this "no" could be a stale root read racing a tenant that's still being created, not a real verdict. Retrying lets a later attempt see the tenant once it's replicated; a tenant that's genuinely gone just keeps failing this check until `max_retries` is exhausted and Cloudflare drops the message on its own (no `dead_letter_queue` configured) - no code here needs to give up on its behalf.
					console.warn(`Retrying ${group.logs.length} log(s) for tenant ${group.t_id} - no prior logs and no root row (yet, at least)`);
					group.messages.forEach((message) => message.retry());
					return;
				}

				const inserts = group.logs.map((log) =>
					db.insert(tenantLogsSchema.logs).values({
						id: sql`unhex(${log.id})`,
						timestamp: new Date(log.timestamp),
						event_type: log.event_type,
						context: log.context,
						ip: log.ip,
						user_agent: log.user_agent,
						...(log.ray_id && { ray_id: sql`unhex(${log.ray_id})` }),
						...(log.u_id && { u_id: sql`unhex(${log.u_id})` }),
						...(log.ak_id && { ak_id: sql`unhex(${log.ak_id})` }),
						...(log.system != null && { system: log.system }),
						...(log.kr_id && { kr_id: sql`unhex(${log.kr_id})` }),
						...(log.dk_id && { dk_id: sql`unhex(${log.dk_id})` }),
						status: log.status,
					}),
				);

				await db.batch(inserts as [(typeof inserts)[number], ...(typeof inserts)[number][]]);

				group.messages.forEach((message) => message.ack());
			} catch (error) {
				console.error(`Failed to write ${group.logs.length} log(s) for tenant ${group.t_id}`, error);
				group.messages.forEach((message) => message.retry());
			}
		}),
	);
}
