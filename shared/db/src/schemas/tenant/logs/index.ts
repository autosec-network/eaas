import { isNotNull, or, sql } from 'drizzle-orm/sql';
import { check, index, primaryKey, snakeCase } from 'drizzle-orm/sqlite-core';
import type { TenantLogEventStatus, TenantLogEventType } from 'types/tenants/logging';

/**
 * Based on @link https://github.com/cloudflare/actors/blob/main/packages/alarms/src/index.ts
 */
// `WITHOUT ROWID`
export const alarms = snakeCase.table(
	'alarms',
	(a) => ({
		/**
		 * UUIDv7 (without hyphens)
		 */
		id: a.blob({ mode: 'buffer' }).primaryKey().notNull(),
		callee: a.text({ mode: 'text' }).notNull(),
		// eslint-disable-next-line @typescript-eslint/no-explicit-any
		payload: a.text({ mode: 'json' }).notNull().default([]).$type<any[]>(),
		type: a.text({ enum: ['scheduled', 'delayed', 'cron'] }).notNull(),
		next_time: a.integer({ mode: 'timestamp_ms' }).notNull(),
		delay_in_seconds: a.integer({ mode: 'number' }),
		cron: a.text({ mode: 'json' }).$type<string[]>(),
	}),
	(a) => [
		// To search
		index('idx_alarms_type').on(a.type),
		index('idx_alarms_next_time').on(a.next_time),
	],
);

// `WITHOUT ROWID`
export const logs = snakeCase.table(
	'logs',
	(l) => ({
		/**
		 * UUIDv7 (without hyphens)
		 */
		id: l.blob({ mode: 'buffer' }).primaryKey().notNull(),
		// Same millisecond-precision timestamp as UUIDv7, stored separately for easier querying and readability
		timestamp: l.integer({ mode: 'timestamp_ms' }).notNull(),
		event_type: l.integer({ mode: 'number' }).notNull().$type<TenantLogEventType>(),
		context: l.text({ mode: 'json' }).notNull(),
		ip: l.text({ mode: 'text' }).notNull(),
		user_agent: l.text({ mode: 'text' }),
		/**
		 * UUIDv7 (without hyphens)
		 */
		u_id: l.blob({ mode: 'buffer' }),
		/**
		 * UUIDv7 (without hyphens)
		 */
		ak_id: l.blob({ mode: 'buffer' }),
		system: l.integer({ mode: 'boolean' }),
		/**
		 * UUIDv7 (without hyphens)
		 */
		kr_id: l.blob({ mode: 'buffer' }),
		/**
		 * UUIDv7 (without hyphens)
		 */
		dk_id: l.blob({ mode: 'buffer' }),
		status: l.integer({ mode: 'number' }).notNull().$type<TenantLogEventStatus>(),
	}),
	(l) => [
		check('actor_required', or(isNotNull(l.u_id), isNotNull(l.ak_id), isNotNull(l.system))!),
		index('event_type_idx').on(l.event_type),
		index('when').on(l.timestamp),
		// Composite also covers the leftmost column as a single index
		index('u_id_event_type_idx').on(l.u_id, l.event_type),
		// Composite also covers the leftmost column as a single index
		index('ak_id_event_type_idx').on(l.ak_id, l.event_type),
	],
);

// `WITHOUT ROWID`
export const pending_web_sockets = snakeCase.table(
	'pending_web_sockets',
	(pws) => ({
		id: pws.blob({ mode: 'buffer' }).primaryKey().notNull(),
		secret: pws.blob({ mode: 'buffer' }).unique().notNull(),
		salt: pws.blob({ mode: 'buffer' }).unique().notNull(),
		expires: pws.integer({ mode: 'timestamp_ms' }).notNull(),
	}),
	(pws) => [
		//
		check('valid_expire', sql`${pws.expires} > (CAST(unixepoch('subsec') * 1000 AS INTEGER))`),
	],
);

// `WITHOUT ROWID`
export const web_sockets_subscriptions = snakeCase.table(
	'web_sockets_subscriptions',
	(wsss) => ({
		id: wsss.blob({ mode: 'buffer' }).notNull(),
		eventType: wsss.integer({ mode: 'number' }).notNull().$type<TenantLogEventType>(),
	}),
	(wsss) => [
		//
		primaryKey({ columns: [wsss.id, wsss.eventType] }),
	],
);
