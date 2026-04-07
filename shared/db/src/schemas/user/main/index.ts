import { primaryKey, sqliteTable } from 'drizzle-orm/sqlite-core';

export const auth_accounts = sqliteTable(
	'auth_accounts',
	(aa) => ({
		type: aa
			.text({
				// From `AdapterAccount['type']`
				enum: ['oidc', 'oauth', 'email', 'webauthn'],
			})
			.notNull(),
		provider: aa.text({ mode: 'text' }).notNull(),
		provider_account_id: aa.text({ mode: 'text' }).notNull(),
		refresh_token: aa.blob({ mode: 'buffer' }),
		access_token: aa.blob({ mode: 'buffer' }),
		expires_at: aa.integer({ mode: 'timestamp_ms' }),
		token_type: aa.text({
			// From `AdapterAccount['token_type']`
			enum: ['bearer', 'dpop'],
		}),
		scope: aa.text({ mode: 'text' }),
		id_token: aa.blob({ mode: 'buffer' }),
		session_state: aa.text({ mode: 'text' }),
	}),
	(aa) => [primaryKey({ columns: [aa.provider, aa.provider_account_id] })],
);

export const auth_webauthn = sqliteTable('auth_webauthn', (aw) => ({
	credential_id: aw.blob({ mode: 'buffer' }).primaryKey().notNull(),
	name: aw.text({ mode: 'text' }).unique(),
	/**
	 * @link https://www.corbado.com/glossary/aaguid
	 */
	aa_guid: aw.blob({ mode: 'buffer' }),
	credential_public_key: aw.blob({ mode: 'buffer' }).notNull(),
	counter: aw.integer({ mode: 'number' }).notNull(),
	credential_device_type: aw.text().notNull(),
	credential_backed_up: aw.integer({ mode: 'boolean' }).notNull(),
	transports: aw.text({ mode: 'json' }).$type<string[]>(),
	/**
	 * last used to sign in
	 */
	a_time: aw.integer({ mode: 'timestamp_ms' }).notNull(),
	/**
	 * passkey was created time
	 */
	b_time: aw.integer({ mode: 'timestamp_ms' }).notNull(),
}));

export const auth_verification_token = sqliteTable('auth_verification_token', (avt) => ({
	hashed_token: avt.blob({ mode: 'buffer' }).primaryKey(),
	expires: avt.integer({ mode: 'timestamp_ms' }).notNull(),
}));

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
