import * as zm from 'zod/mini';
import { DOJurisdictions } from '../index.js';
import { hexUuid7Regex } from '../zod-mini/index.js';

export enum TenantLogEventType {
	created = 0,
	'changed vault' = 1,
	'changed byo vault token' = 2,
	'rescanned vault' = 3,
	'requested vault migration' = 4,
	'approved vault migration' = 5,
	'completed vault migration' = 6,
}

export enum TenantLogEventStatus {
	success = 0,
	denied = 1,
	error = 2,
}

/**
 * A UUIDv7 with its hyphens stripped - the shape every blob id column in the logs schema is fed through `unhex()`.
 */
const hexUuidv7Schema = zm.string().check(zm.trim(), zm.toLowerCase(), zm.regex(hexUuid7Regex));

/**
 * One tenant audit log in flight on the `eaas-logs-*` queue.
 *
 * Producers (`admin`, `customer`, `api`) never touch a tenant's logs Durable Object themselves - they enqueue this, and `api`'s queue consumer is the only writer. Everything the consumer needs to *find* the right DO (`t_id` + `jurisdiction`) therefore travels alongside the row itself, since the logs DO's id is never stored anywhere: it's always derived from the tenant id.
 *
 * The message is plain JSON (sent with `contentType: 'json'`), so ids stay hex strings and `timestamp` stays an ISO string - the consumer is what turns them back into `unhex()` calls and a `Date`.
 */
export const TenantLogQueueMessageSchema = zm
	.object({
		/**
		 * Tenant the log belongs to. Its logs DO is named `<hyphenated t_id>_logs`.
		 */
		t_id: hexUuidv7Schema,
		/**
		 * Jurisdiction the tenant's Durable Objects were created under, if any - the logs DO id can only be derived on the matching (sub)namespace.
		 */
		jurisdiction: zm.nullish(zm.enum(DOJurisdictions)),
		/**
		 * Minted by the producer, not the consumer, so the row's id - and the ordering it implies - reflects when the event actually happened rather than when it was written.
		 */
		id: hexUuidv7Schema,
		/**
		 * Same millisecond as the UUIDv7 in {@link TenantLogQueueMessageSchema.id}, kept separately because the column is queried directly.
		 */
		timestamp: zm.iso.datetime({ local: false, offset: false, precision: 3 }),
		event_type: zm.enum(TenantLogEventType),
		context: zm.record(zm.string(), zm.unknown()),
		ip: zm.nullish(zm.string().check(zm.trim(), zm.minLength(1))),
		user_agent: zm.nullish(zm.string().check(zm.trim(), zm.minLength(1))),
		/**
		 * The hex id half of `Cf-Ray` - the `-<colo>` suffix isn't hex, so it can't go in the blob column.
		 */
		ray_id: zm.nullish(zm.hex().check(zm.trim(), zm.toLowerCase())),
		u_id: zm.nullish(hexUuidv7Schema),
		ak_id: zm.nullish(hexUuidv7Schema),
		system: zm.nullish(zm.boolean()),
		kr_id: zm.nullish(hexUuidv7Schema),
		dk_id: zm.nullish(hexUuidv7Schema),
		status: zm.enum(TenantLogEventStatus),
	})
	// Mirrors the table's `actor_required` CHECK, so a log that could never be inserted is rejected at the producer instead of failing (and retrying) inside the consumer
	.check(zm.refine((message) => message.u_id != null || message.ak_id != null || message.system != null, 'A log needs an actor: at least one of `u_id`, `ak_id`, or `system`'));
export type TenantLogQueueMessage = zm.output<typeof TenantLogQueueMessageSchema>;
