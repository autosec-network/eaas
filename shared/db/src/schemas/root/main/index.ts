import { index, primaryKey, snakeCase, unique } from 'drizzle-orm/sqlite-core';
import { DOJurisdictions } from 'types';

// `WITHOUT ROWID`
export const api_keys_tenants = snakeCase.table(
	'api_keys_tenants',
	(akt) => ({
		ak_id: akt.blob({ mode: 'buffer' }).primaryKey().notNull(),
		/**
		 * UUIDv7 (without hyphens)
		 */
		t_id: akt
			.blob({ mode: 'buffer' })
			.notNull()
			.references(() => tenants.t_id, { onUpdate: 'cascade', onDelete: 'cascade' }),
		expires: akt.integer({ mode: 'timestamp_ms' }).notNull(),
	}),
	(akt) => [
		//
		unique().on(akt.ak_id, akt.t_id),
		// To search
		index('idx_api_keys_tenants_t_id').on(akt.t_id),
	],
);

// `WITHOUT ROWID`
export const tenants = snakeCase.table('tenants', (t) => ({
	/**
	 * UUIDv7 (without hyphens)
	 */
	t_id: t.blob({ mode: 'buffer' }).primaryKey().notNull(),
	jurisdiction: t.text({ enum: Object.values(DOJurisdictions) as [DOJurisdictions, ...DOJurisdictions[]] }),
	do_id: t.blob({ mode: 'buffer' }).unique().notNull(),
}));

// `WITHOUT ROWID`
export const users = snakeCase.table('users', (u) => ({
	/**
	 * UUIDv7 (without hyphens)
	 */
	u_id: u.blob({ mode: 'buffer' }).primaryKey().notNull(),
	jurisdiction: u.text({ enum: Object.values(DOJurisdictions) as [DOJurisdictions, ...DOJurisdictions[]] }),
	do_id: u.blob({ mode: 'buffer' }).unique(),
	key_hash: u.blob({ mode: 'buffer' }).notNull(),
	/**
	 * HMAC of canonicalized (trim, lowercase, stripping subaddressing (RFC 5233)) email
	 */
	email_key: u.blob({ mode: 'buffer' }).unique().notNull(),
	/**
	 * User created, but not onboarded (missing auth, etc)
	 */
	user_init: u.integer({ mode: 'boolean' }).notNull().default(false),
}));

// `WITHOUT ROWID`
export const users_auth_accounts = snakeCase.table(
	'users_auth_accounts',
	(uaa) => ({
		/**
		 * UUIDv7 (without hyphens)
		 */
		u_id: uaa
			.blob({ mode: 'buffer' })
			.notNull()
			.references(() => users.u_id, { onUpdate: 'cascade', onDelete: 'cascade' }),
		key_hash: uaa.blob({ mode: 'buffer' }).notNull(),
		provider: uaa.text({ mode: 'text' }).notNull(),
		/**
		 * HMAC of provider account ID
		 */
		provider_account_id: uaa.blob({ mode: 'buffer' }).notNull(),
	}),
	(uaa) => [
		//
		primaryKey({ columns: [uaa.provider, uaa.provider_account_id] }),
		// To search
		index('idx_users_auth_accounts_u_id').on(uaa.u_id),
		index('idx_users_auth_accounts_provider_account_id').on(uaa.provider, uaa.provider_account_id),
	],
);

// `WITHOUT ROWID`
export const users_auth_sessions = snakeCase.table(
	'users_auth_sessions',
	(uas) => ({
		/**
		 * UUIDv7 (without hyphens)
		 */
		u_id: uas
			.blob({ mode: 'buffer' })
			.notNull()
			.references(() => users.u_id, { onUpdate: 'cascade', onDelete: 'cascade' }),
		/**
		 * DO id of the session
		 */
		session_token: uas.blob({ mode: 'buffer' }).primaryKey().notNull(),
		/**
		 * ISO 8601 string
		 */
		expires: uas.integer({ mode: 'timestamp_ms' }).notNull(),
	}),
	(uas) => [
		// To search
		index('idx_users_auth_sessions_u_id').on(uas.u_id),
	],
);

// `WITHOUT ROWID`
export const users_tenants = snakeCase.table(
	'users_tenants',
	(ut) => ({
		/**
		 * UUIDv7 (without hyphens)
		 */
		u_id: ut
			.blob({ mode: 'buffer' })
			.notNull()
			.references(() => users.u_id, { onUpdate: 'cascade', onDelete: 'cascade' }),
		/**
		 * UUIDv7 (without hyphens)
		 */
		t_id: ut
			.blob({ mode: 'buffer' })
			.notNull()
			.references(() => tenants.t_id, { onUpdate: 'cascade', onDelete: 'cascade' }),
	}),
	(ut) => [
		//
		primaryKey({ columns: [ut.u_id, ut.t_id] }),
		// To search
		index('idx_users_tenants_t_id').on(ut.t_id),
	],
);
