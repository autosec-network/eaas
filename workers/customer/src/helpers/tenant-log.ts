import type { Session } from '@auth/qwik';
import * as rootSchema from 'db/schemas/root';
import type { DrizzleD1Database } from 'drizzle-orm/d1';
import { eq, sql } from 'drizzle-orm/sql';
import { TenantLogEventStatus, TenantLogQueueMessageSchema } from 'types/tenants/logging';
import type { TenantLogEventType } from 'types/tenants/logging';
import { v7 as uuidv7 } from 'uuid';
import type * as zm from 'zod/mini';

/**
 * Enqueue one tenant audit log - the Qwik shape (`vault/index.tsx` carries the sibling copy for why every worker builds this itself rather than sharing one across workers: each reaches the incoming request differently).
 *
 * Unlike that copy, this one resolves `jurisdiction` itself from `r_db` rather than trusting the caller to have it on hand - a caller that got it wrong (or omitted it) would silently route the log to the tenant's *default* logs DO instead of its actual jurisdictional one, which is exactly the data-residency mistake jurisdictional DOs exist to prevent.
 */
export async function logTenantEvent(platform: QwikCityPlatform, request: Request, r_db: DrizzleD1Database, t_id_hex: string, session: Session, event_type: TenantLogEventType, context: Record<string, unknown>, status: TenantLogEventStatus = TenantLogEventStatus.success): Promise<void> {
	const [tenant] = await r_db
		.select({ jurisdiction: rootSchema.tenants.jurisdiction })
		.from(rootSchema.tenants)
		.where(eq(rootSchema.tenants.t_id, sql`unhex(${t_id_hex})`))
		.limit(1);

	const now = new Date();
	const headers = (platform.request ?? request).headers;

	const log: zm.input<typeof TenantLogQueueMessageSchema> = {
		t_id: t_id_hex,
		jurisdiction: tenant?.jurisdiction ?? null,
		// The row's UUIDv7 carries the same millisecond as `timestamp`, so ordering reflects when the event happened
		id: uuidv7({ msecs: now.getTime() }).replaceAll('-', ''),
		timestamp: now.toISOString(),
		event_type,
		context,
		ip: headers.get('CF-Connecting-IP'),
		user_agent: headers.get('User-Agent'),
		// `Cf-Ray` is `<hex id>-<colo>`, and only the id half is hex, so that's all the blob column can hold
		ray_id: headers.get('CF-Ray')?.split('-')[0],
		u_id: session.user!.u_id.hex,
		status,
	};
	// Post the raw version, not the parsed one, so the consumer validates it independently
	await TenantLogQueueMessageSchema.parseAsync(log);
	platform.ctx.waitUntil(platform.env.LOGS.sendBatch([{ body: log, contentType: 'json' }]));
}
