import { sql } from 'drizzle-orm/sql';
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
		expires_at: aa.text({ mode: 'text' }),
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
	a_time: aw
		.text({ mode: 'text', length: 24 })
		.notNull()
		.default(sql`(strftime('%FT%H:%M:%fZ', CURRENT_TIMESTAMP))`),
	/**
	 * passkey was created time
	 */
	b_time: aw
		.text({ mode: 'text', length: 24 })
		.notNull()
		.default(sql`(strftime('%FT%H:%M:%fZ', CURRENT_TIMESTAMP))`),
}));

export const auth_verification_token = sqliteTable(
	'auth_verification_token',
	(avt) => ({
		identifier: avt.text({ mode: 'text' }).notNull(),
		hashed_token: avt.blob({ mode: 'buffer' }).notNull(),
		timestamp: avt.text({ mode: 'text', length: 24 }).notNull(),
	}),
	(avt) => [primaryKey({ columns: [avt.identifier, avt.hashed_token] })],
);
