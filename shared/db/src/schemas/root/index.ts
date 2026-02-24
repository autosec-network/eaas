import { primaryKey, sqliteTable, unique } from 'drizzle-orm/sqlite-core';

export const users = sqliteTable('users', (u) => ({
	/**
	 * UUIDv7 (without hyphens)
	 */
	u_id: u.blob({ mode: 'buffer' }).primaryKey(),
	jurisdiction: u.text({ enum: ['eu', 'fedramp', 'fedramp-high'] }),
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

export const users_auth_accounts = sqliteTable(
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
		/**
		 * HMAC of provider (google, entra, etc)
		 */
		provider: uaa.text({ mode: 'text' }).notNull(),
		/**
		 * HMAC of provider account ID
		 */
		provider_account_id: uaa.text({ mode: 'text' }).notNull(),
	}),
	(uaa) => [primaryKey({ columns: [uaa.provider, uaa.provider_account_id] })],
);

export const users_auth_sessions = sqliteTable('users_auth_sessions', (uas) => ({
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
	session_token: uas.blob({ mode: 'buffer' }).primaryKey(),
	/**
	 * ISO 8601 string
	 */
	expires: uas.text({ mode: 'text' }).notNull(),
}));

export const tenants = sqliteTable('tenants', (t) => ({
	/**
	 * UUIDv7 (without hyphens)
	 */
	t_id: t.blob({ mode: 'buffer' }).primaryKey(),
	do_id: t.blob({ mode: 'buffer' }).unique().notNull(),
}));

export const users_tenants = sqliteTable(
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
	(ut) => [primaryKey({ columns: [ut.u_id, ut.t_id] })],
);

export const api_keys_tenants = sqliteTable(
	'api_keys_tenants',
	(akt) => ({
		ak_id: akt.blob({ mode: 'buffer' }).primaryKey(),
		/**
		 * UUIDv7 (without hyphens)
		 */
		t_id: akt
			.blob({ mode: 'buffer' })
			.notNull()
			.references(() => tenants.t_id, { onUpdate: 'cascade', onDelete: 'cascade' }),
		/**
		 * ISO 8601 string
		 */
		expires: akt.text({ mode: 'text' }).notNull(),
	}),
	(akt) => [unique().on(akt.ak_id, akt.t_id)],
);
