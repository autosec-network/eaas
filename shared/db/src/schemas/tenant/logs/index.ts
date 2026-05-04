import { isNotNull, or } from 'drizzle-orm/sql';
import { check, index, primaryKey, sqliteTable } from 'drizzle-orm/sqlite-core';
import type { TenantLogEventStatus, TenantLogEventType } from 'types/tenants/logging';

export const logs = sqliteTable(
	'logs',
	(l) => ({
		/**
		 * UUIDv7 (without hyphens)
		 */
		id: l.blob({ mode: 'buffer' }).primaryKey(),
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

export const pending_web_sockets = sqliteTable('pending_web_sockets', (pws) => ({
	id: pws.blob({ mode: 'buffer' }).primaryKey(),
	secret: pws.blob({ mode: 'buffer' }).unique().notNull(),
	salt: pws.blob({ mode: 'buffer' }).unique().notNull(),
	expires: pws.integer({ mode: 'timestamp_ms' }).notNull(),
}));

export const web_sockets_subscriptions = sqliteTable(
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

/**
 * Based on @link https://github.com/cloudflare/actors/blob/main/packages/alarms/src/index.ts
 */
export const alarms = sqliteTable('alarms', (a) => ({
	/**
	 * UUIDv7 (without hyphens)
	 */
	id: a.blob({ mode: 'buffer' }).primaryKey(),
	callee: a.text({ mode: 'text' }).notNull(),
	// eslint-disable-next-line @typescript-eslint/no-explicit-any
	payload: a.text({ mode: 'json' }).notNull().default([]).$type<any[]>(),
	type: a.text({ enum: ['scheduled', 'delayed', 'cron'] }).notNull(),
	next_time: a.integer({ mode: 'timestamp_ms' }).notNull(),
	delay_in_seconds: a.integer({ mode: 'number' }),
	cron: a.text({ mode: 'json' }).$type<string[]>(),
}));
