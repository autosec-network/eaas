import { sql } from 'drizzle-orm/sql';
import { index, primaryKey, snakeCase, uniqueIndex } from 'drizzle-orm/sqlite-core';
import type { Permissions } from 'types';
import { KeyAlgorithms } from 'types/crypto';
import { workersCryptoCatalog } from 'types/crypto/catalog';

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
export const api_keys = snakeCase.table(
	'api_keys',
	(ak) => ({
		ak_id: ak.blob({ mode: 'buffer' }).primaryKey().notNull(),
		name: ak.text({ mode: 'text' }).notNull(),
		/**
		 * Hashed value of api key secret
		 */
		hash: ak.blob({ mode: 'buffer' }).unique().notNull(),
		last_identifier: ak.text({ mode: 'text', length: 4 }).notNull(),
		/**
		 * Allows disabling a key without deleting it
		 */
		enabled: ak.integer({ mode: 'boolean' }).notNull().default(true),
		expires: ak.integer({ mode: 'timestamp_ms' }).notNull(),
		/**
		 * last time key was used
		 */
		a_time: ak.integer({ mode: 'timestamp_ms' }),
		/**
		 * api key was created time
		 */
		b_time: ak.integer({ mode: 'timestamp_ms' }).notNull(),
		/**
		 * api key permissions changed time
		 */
		c_time: ak.integer({ mode: 'timestamp_ms' }).notNull(),
		/**
		 * api key rotated changed time
		 */
		m_time: ak.integer({ mode: 'timestamp_ms' }).notNull(),
		/**
		 * 0. Can see all keyrings it has permission linked
		 * 1. Can see all keyrings
		 * 2. Can create/edit keyrings
		 * 3. Can delete keyrings
		 */
		r_keyrings: ak.integer({ mode: 'number' }).notNull().$type<Permissions>().default(0),
		/**
		 * 0. Can see self api key
		 * 1. Can see all apikeys
		 * 2. Can create or edit or rotate
		 * 3. Can delete apikeys
		 * @note Only rotate shows the actual (new) key
		 */
		r_apikeys: ak.integer({ mode: 'number' }).notNull().$type<Permissions>().default(0),
	}),
	(ak) => [
		//
		uniqueIndex('case_insensitive_apikey_name').on(sql<string>`lower(${ak.name})`),
		// To search
		index('idx_api_keys_b_time').on(ak.b_time),
	],
);

// `WITHOUT ROWID`
export const api_keys_keyrings = snakeCase.table(
	'api_keys_keyrings',
	(kak) => ({
		ak_id: kak
			.blob({ mode: 'buffer' })
			.notNull()
			.references(() => api_keys.ak_id, { onUpdate: 'cascade', onDelete: 'cascade' }),
		kr_id: kak
			.blob({ mode: 'buffer' })
			.notNull()
			.references(() => keyrings.kr_id, { onUpdate: 'cascade', onDelete: 'cascade' }),
		/**
		 * 1. Can see all datakeys
		 * 2. Can rotate
		 * 3. Can prune datakeys
		 * @note None show the actual key
		 */
		r_datakeys: kak.integer({ mode: 'number' }).notNull().$type<Permissions>().default(1),
		/**
		 * Encrypt data
		 */
		r_encrypt: kak.integer({ mode: 'boolean' }).notNull().default(true),
		/**
		 * Decrypt data
		 */
		r_decrypt: kak.integer({ mode: 'boolean' }).notNull().default(false),
		/**
		 * Rewrap data
		 */
		r_rewrap: kak.integer({ mode: 'boolean' }).notNull().default(true),
		/**
		 * Sign data
		 */
		r_sign: kak.integer({ mode: 'boolean' }).notNull().default(true),
		/**
		 * Verify signed data
		 */
		r_verify: kak.integer({ mode: 'boolean' }).notNull().default(true),
		/**
		 * Generate HMAC
		 */
		r_hmac: kak.integer({ mode: 'boolean' }).notNull().default(true),
	}),
	(kak) => [
		//
		primaryKey({ columns: [kak.kr_id, kak.ak_id] }),
		// To search
		index('idx_api_keys_keyrings_ak_id').on(kak.ak_id),
		index('idx_api_keys_keyrings_kr_id').on(kak.kr_id),
	],
);

// `WITHOUT ROWID`
export const datakeys = snakeCase.table(
	'datakeys',
	(d) => ({
		dk_id: d.blob({ mode: 'buffer' }).primaryKey().notNull(),
		kr_id: d
			.blob({ mode: 'buffer' })
			.notNull()
			.references(() => keyrings.kr_id, { onUpdate: 'cascade', onDelete: 'cascade' }),
		/**
		 * Bitwarden secrets manager secret id for the key(s)
		 */
		bw_id: d.blob({ mode: 'buffer' }).unique(),
		/**
		 * last time key was used
		 */
		a_time: d.integer({ mode: 'timestamp_ms' }),
		/**
		 * Native drizzle bigint is broken so we do blob <-> hex <-> bigint
		 * @link https://github.com/drizzle-team/drizzle-orm/issues/2902
		 * @link https://github.com/drizzle-team/drizzle-orm/issues/3609
		 */
		generation_count: d
			.blob({ mode: 'buffer' })
			.notNull()
			.default(sql.raw(`(unhex(${BigInt(0).toString(16).length % 2 === 0 ? BigInt(0).toString(16) : `'0${BigInt(0).toString(16)}'`}))`)),
	}),
	(d) => [
		//
		index('idx_datakeys_kr_id').on(d.kr_id),
	],
);

// `WITHOUT ROWID`
export const keyrings = snakeCase.table(
	'keyrings',
	(k) => ({
		kr_id: k.blob({ mode: 'buffer' }).primaryKey().notNull(),
		name: k.text({ mode: 'text' }).notNull(),
		/**
		 * For security settings, only a write-once setting
		 */
		plaintext_export: k.integer({ mode: 'boolean' }).notNull().default(false),
		key_type: k
			.text({ enum: Object.values(KeyAlgorithms) as [KeyAlgorithms, ...KeyAlgorithms[]] })
			.$type<KeyAlgorithms>()
			.notNull(),
		/**
		 * Not used for every key type
		 */
		key_size: k.integer({ mode: 'number' }),
		/**
		 * Used to derive generation op key from actual key
		 * Some keys use it in the key generation too
		 */
		hash: k.text({ mode: 'text', enum: workersCryptoCatalog.hashes }).notNull(),
		/**
		 * Actual cron is stored in scheduler DO, not here. This is just flag to enable/disable DO
		 * @default true and DO is created with cron of 1 year
		 * @link https://csrc.nist.gov/pubs/sp/800/57/pt1/r5/final
		 */
		time_rotation: k.integer({ mode: 'boolean' }).notNull().default(true),
		/**
		 * Number of generation operations before triggering key rotation
		 * @default 2^32
		 * @link https://csrc.nist.gov/pubs/sp/800/38/d/final
		 *
		 * Native drizzle bigint is broken so we do blob <-> hex <-> bigint
		 * @link https://github.com/drizzle-team/drizzle-orm/issues/2902
		 * @link https://github.com/drizzle-team/drizzle-orm/issues/3609
		 */
		count_rotation: k.blob({ mode: 'buffer' }).default(sql.raw(`(unhex(${(BigInt(2) ** BigInt(32)).toString(16).length % 2 === 0 ? (BigInt(2) ** BigInt(32)).toString(16) : `'0${(BigInt(2) ** BigInt(32)).toString(16)}'`}))`)),
		/**
		 * Number of in use (1+ generation ops count) to allow for generation operations. The number is counted from the latest key.
		 * For example, `0` means that only the latest key can be used for generation operations.
		 * For example, `2` means that the latest 3 keys can be used for generation operations.
		 * Keys beyond `max(generation_versions, retreival_versions)` limit are auto-pruned
		 * @default 0
		 */
		generation_versions: k.integer({ mode: 'number' }).notNull().default(0),
		/**
		 * Number of in use (1+ generation ops count) to allow for retreival operations. The number is counted from the latest key.
		 * For example, `0` means that only the latest key can be used for retreival operations.
		 * For example, `2` means that the latest 3 keys can be used for retreival operations.
		 * Keys beyond `max(generation_versions, retreival_versions)` limit are auto-pruned
		 * @default 2
		 */
		retreival_versions: k.integer({ mode: 'number' }).notNull().default(2),
		/**
		 * keyring was created time
		 */
		b_time: k.integer({ mode: 'timestamp_ms' }).notNull(),
		/**
		 * keyring settings were changed time
		 */
		c_time: k.integer({ mode: 'timestamp_ms' }).notNull(),
		/**
		 * keyring was rotated
		 */
		m_time: k.integer({ mode: 'timestamp_ms' }).notNull(),
	}),
	(k) => [
		//
		uniqueIndex('case_insensitive_keyring_name').on(sql<string>`lower(${k.name})`),
		// To search
		index('idx_keyrings_name').on(k.name),
	],
);

// `WITHOUT ROWID`
export const users = snakeCase.table('users', (u) => ({
	u_id: u.blob({ mode: 'buffer' }).primaryKey().notNull(),
	do_id: u.blob({ mode: 'buffer' }).unique().notNull(),
	/**
	 * user last signed in time
	 * ISO 8601 string
	 */
	a_time: u.integer({ mode: 'timestamp_ms' }),
	/**
	 * user joined time
	 * ISO 8601 string
	 */
	b_time: u.integer({ mode: 'timestamp_ms' }).notNull(),
	/**
	 * permissions change time
	 * ISO 8601 string
	 */
	m_time: u.integer({ mode: 'timestamp_ms' }).notNull(),
	approved: u.integer({ mode: 'boolean' }).notNull().default(false),
	/**
	 * Can see tenant properties / Can edit tenant properties / Can destroy tenant
	 * 0. Bare minimum to not crash
	 * 1. Can see tenant properties
	 * 2. Can edit tenant properties
	 * 3. Can destroy tenant
	 */
	r_tenant: u.integer({ mode: 'number' }).notNull().$type<Permissions>().default(1),
	/**
	 * 0. Can see only self
	 * 1. Can see all users
	 * 2. Can add users
	 * 3. Can remove users
	 */
	r_users: u.integer({ mode: 'number' }).notNull().$type<Permissions>().default(1),
	/**
	 * 0. Can see own permissions
	 * 1. Can see all users' permissions
	 * 2. Can add/remove permissions
	 */
	r_roles: u.integer({ mode: 'number' }).notNull().$type<Permissions>().default(0),
	/**
	 * 0. Can't see billing/usage
	 * 1. Can see usage
	 * 2. Can see billing details
	 * 3. Can manage billing (change plan, update payment method, etc)
	 */
	r_billing: u.integer({ mode: 'number' }).notNull().$type<Permissions>().default(1),
	/**
	 * 0. Can't see api keys
	 * 1. Can see all apikeys
	 * 2. Can create or edit or rotate
	 * 3. Can delete apikeys
	 * @note Only rotate shows the actual (new) key
	 */
	r_apikeys: u.integer({ mode: 'number' }).notNull().$type<Permissions>().default(1),
	/**
	 * 0. Can't see keyrings
	 * 1. Can see all keyrings
	 * 2. Can create/edit keyrings
	 * 3. Can delete keyrings
	 */
	r_keyring: u.integer({ mode: 'number' }).notNull().$type<Permissions>().default(2),
	/**
	 * 0. Can't see datakeys
	 * 1. Can see all datakeys
	 * 2. Can import/export datakeys
	 * 3. Can delete datakeys
	 */
	r_datakey: u.integer({ mode: 'number' }).notNull().$type<Permissions>().default(1),
	/**
	 * 0. Can't see logs
	 * 1. Can see all logs
	 * 2. Can see PII in logs
	 * 3. Can manage logs (delete logs, etc)
	 */
	r_logs: u.integer({ mode: 'number' }).notNull().$type<Permissions>().default(1),
}));

// `WITHOUT ROWID`
export const users_keyrings = snakeCase.table(
	'users_keyrings',
	(uk) => ({
		u_id: uk
			.blob({ mode: 'buffer' })
			.notNull()
			.references(() => users.u_id, { onUpdate: 'cascade', onDelete: 'cascade' }),
		kr_id: uk
			.blob({ mode: 'buffer' })
			.notNull()
			.references(() => keyrings.kr_id, { onUpdate: 'cascade', onDelete: 'cascade' }),
		/**
		 * 0. Can't see keyrings
		 * 1. Can see keyring
		 * 2. Can edit keyring
		 * 3. Can delete keyring
		 */
		r_keyring: uk.integer({ mode: 'number' }).notNull().$type<Permissions>().default(2),
		/**
		 * 0. Can't see datakeys
		 * 1. Can see all datakeys
		 * 2. Can import/export datakeys
		 * 3. Can delete datakeys
		 */
		r_datakey: uk.integer({ mode: 'number' }).notNull().$type<Permissions>().default(1),
	}),
	(uk) => [
		primaryKey({ columns: [uk.u_id, uk.kr_id] }),
		// To search
		index('idx_users_keyrings_u_id').on(uk.u_id),
		index('idx_users_keyrings_kr_id').on(uk.kr_id),
	],
);
