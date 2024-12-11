import { sql, type SQL } from 'drizzle-orm';
import { sqliteTable, unique, uniqueIndex, type AnySQLiteColumn } from 'drizzle-orm/sqlite-core';
import type { D1Blob, EmailAddress, ISODateString, Permissions, UuidExport } from '../../../types/d1/index.mjs';
import type { TenantFlagsObject, UserFlagsObject } from '../../../types/d1/tenants/index.mjs';

// It fails if it's imported
/**
 * @returns a copy of string `x` with all ASCII characters converted to lower case
 * @link https://sqlite.org/lang_corefunc.html#lower
 */
function lower<T extends unknown = string>(x: AnySQLiteColumn) {
	return sql<T>`lower(${x})`;
}

export const properties = sqliteTable('properties', (p) => ({
	t_id: p.blob({ mode: 'buffer' }).primaryKey().notNull().$type<D1Blob>(),
	/**
	 * @deprecated DO NOT USE (BufferHelpers is faster and cheaper)
	 */
	t_id_utf8: p
		.text({ mode: 'text' })
		.generatedAlwaysAs((): SQL => sql<UuidExport['utf8']>`lower(format('%s-%s-%s-%s-%s', substr(hex(${properties.t_id}),1,8), substr(hex(${properties.t_id}),9,4), substr(hex(${properties.t_id}),13,4), substr(hex(${properties.t_id}),17,4), substr(hex(${properties.t_id}),21)))`, { mode: 'virtual' })
		.$type<UuidExport['utf8']>(),
	d1_id: p.blob({ mode: 'buffer' }).unique().notNull().$type<D1Blob>(),
	/**
	 * @deprecated DO NOT USE (BufferHelpers is faster and cheaper)
	 */
	d1_id_utf8: p
		.text({ mode: 'text' })
		.generatedAlwaysAs((): SQL => sql<UuidExport['utf8']>`lower(format('%s-%s-%s-%s-%s', substr(hex(${properties.d1_id}),1,8), substr(hex(${properties.d1_id}),9,4), substr(hex(${properties.d1_id}),13,4), substr(hex(${properties.d1_id}),17,4), substr(hex(${properties.d1_id}),21)))`, { mode: 'virtual' })
		.$type<UuidExport['utf8']>(),
	name: p.text({ mode: 'text' }).unique().notNull(),
	avatar: p.text({ mode: 'text' }).unique(),
	flags: p.text({ mode: 'json' }).notNull().$type<TenantFlagsObject>().default({}),
	/**
	 * tenant was created time
	 */
	b_time: p
		.text({ mode: 'text', length: 24 })
		.notNull()
		.$type<ISODateString>()
		.default(sql`(strftime('%FT%H:%M:%fZ', CURRENT_TIMESTAMP))`),
	/**
	 * tenant metadata was changed time
	 */
	c_time: p
		.text({ mode: 'text', length: 24 })
		.notNull()
		.$type<ISODateString>()
		.default(sql`(strftime('%FT%H:%M:%fZ', CURRENT_TIMESTAMP))`)
		.$onUpdate(() => sql`(strftime('%FT%H:%M:%fZ', CURRENT_TIMESTAMP))`),
}));

export const users = sqliteTable(
	'users',
	(u) => ({
		u_id: u.blob({ mode: 'buffer' }).primaryKey().notNull().$type<D1Blob>(),
		/**
		 * @deprecated DO NOT USE (BufferHelpers is faster and cheaper)
		 */
		u_id_utf8: u
			.text({ mode: 'text' })
			.generatedAlwaysAs((): SQL => sql<UuidExport['utf8']>`lower(format('%s-%s-%s-%s-%s', substr(hex(${users.u_id}),1,8), substr(hex(${users.u_id}),9,4), substr(hex(${users.u_id}),13,4), substr(hex(${users.u_id}),17,4), substr(hex(${users.u_id}),21)))`, { mode: 'virtual' })
			.$type<UuidExport['utf8']>(),
		d1_id: u.blob({ mode: 'buffer' }).unique().notNull().$type<D1Blob>(),
		/**
		 * @deprecated DO NOT USE (BufferHelpers is faster and cheaper)
		 */
		d1_id_utf8: u
			.text({ mode: 'text' })
			.generatedAlwaysAs((): SQL => sql<UuidExport['utf8']>`lower(format('%s-%s-%s-%s-%s', substr(hex(${users.d1_id}),1,8), substr(hex(${users.d1_id}),9,4), substr(hex(${users.d1_id}),13,4), substr(hex(${users.d1_id}),17,4), substr(hex(${users.d1_id}),21)))`, { mode: 'virtual' })
			.$type<UuidExport['utf8']>(),
		email: u.text({ mode: 'text' }).notNull().$type<EmailAddress>(),
		flags: u.text({ mode: 'json' }).notNull().$type<UserFlagsObject>().default({}),
		/**
		 * user last signed in time
		 */
		a_time: u.text({ mode: 'text', length: 24 }).$type<ISODateString>(),
		/**
		 * user joined time
		 */
		b_time: u
			.text({ mode: 'text', length: 24 })
			.notNull()
			.$type<ISODateString>()
			.default(sql`(strftime('%FT%H:%M:%fZ', CURRENT_TIMESTAMP))`),
		/**
		 * permissions change time
		 */
		m_time: u
			.text({ mode: 'text', length: 24 })
			.notNull()
			.$type<ISODateString>()
			.default(sql`(strftime('%FT%H:%M:%fZ', CURRENT_TIMESTAMP))`),
		approved: u.integer({ mode: 'boolean' }).notNull().default(false),
		/**
		 * Can see tenant properties / Can edit tenant properties / Can destroy tenant
		 */
		r_tenant: u.integer({ mode: 'number' }).notNull().$type<Permissions>().default(1),
		/**
		 * Can see all users / Can add/remove users
		 */
		r_users: u.integer({ mode: 'number' }).notNull().$type<Permissions>().default(1),
		/**
		 * Can see all users' permissions / Can add/remove all users' permissions
		 */
		r_roles: u.integer({ mode: 'number' }).notNull().$type<Permissions>().default(1),
		/**
		 * Can see whole tenant billing costs / Can edit billing method
		 */
		r_billing: u.integer({ mode: 'number' }).notNull().$type<Permissions>().default(0),
		/**
		 * Can see all keyrings / Can create/rename keyrings and options / Can delete keyrings
		 */
		r_keyring: u.integer({ mode: 'number' }).notNull().$type<Permissions>().default(2),
		/**
		 * Can see all datakeys / (same as read) / can prune datakeys
		 */
		r_datakey: u.integer({ mode: 'number' }).notNull().$type<Permissions>().default(1),
	}),
	(u) => [uniqueIndex('case_insensitive_email').on(lower(u.email))],
);

export const user_sessions = sqliteTable('auth_sessions', (us) => ({
	s_id: us.blob({ mode: 'buffer' }).primaryKey().notNull().$type<D1Blob>(),
	/**
	 * @deprecated DO NOT USE (BufferHelpers is faster and cheaper)
	 */
	s_id_utf8: us
		.text({ mode: 'text' })
		.generatedAlwaysAs((): SQL => sql<UuidExport['utf8']>`lower(format('%s-%s-%s-%s-%s', substr(hex(${user_sessions.s_id}),1,8), substr(hex(${user_sessions.s_id}),9,4), substr(hex(${user_sessions.s_id}),13,4), substr(hex(${user_sessions.s_id}),17,4), substr(hex(${user_sessions.s_id}),21)))`, { mode: 'virtual' })
		.$type<UuidExport['utf8']>(),
	u_id: us
		.blob({ mode: 'buffer' })
		.notNull()
		.$type<D1Blob>()
		.references(() => users.u_id, { onUpdate: 'cascade', onDelete: 'cascade' }),
	/**
	 * @deprecated DO NOT USE (BufferHelpers is faster and cheaper)
	 */
	u_id_utf8: us
		.text({ mode: 'text' })
		.generatedAlwaysAs((): SQL => sql<UuidExport['utf8']>`lower(format('%s-%s-%s-%s-%s', substr(hex(${user_sessions.u_id}),1,8), substr(hex(${user_sessions.u_id}),9,4), substr(hex(${user_sessions.u_id}),13,4), substr(hex(${user_sessions.u_id}),17,4), substr(hex(${user_sessions.u_id}),21)))`, { mode: 'virtual' })
		.$type<UuidExport['utf8']>(),
	expires: us.text({ mode: 'text' }).notNull().$type<ISODateString>(),
	supplemental: us.text({ mode: 'json' }).notNull().default({}).$type<Record<string, any>>(),
}));

export const users_webauthn = sqliteTable(
	'auth_webauthn',
	(uw) => ({
		credential_id: uw.blob({ mode: 'buffer' }).primaryKey().notNull().$type<D1Blob>(),
		u_id: uw
			.blob({ mode: 'buffer' })
			.notNull()
			.$type<D1Blob>()
			.references(() => users.u_id, { onUpdate: 'cascade', onDelete: 'cascade' }),
		/**
		 * @deprecated DO NOT USE (BufferHelpers is faster and cheaper)
		 */
		u_id_utf8: uw
			.text({ mode: 'text' })
			.generatedAlwaysAs((): SQL => sql<UuidExport['utf8']>`lower(format('%s-%s-%s-%s-%s', substr(hex(${user_sessions.u_id}),1,8), substr(hex(${user_sessions.u_id}),9,4), substr(hex(${user_sessions.u_id}),13,4), substr(hex(${user_sessions.u_id}),17,4), substr(hex(${user_sessions.u_id}),21)))`, { mode: 'virtual' })
			.$type<UuidExport['utf8']>(),
		name: uw.text({ mode: 'text' }),
		credential_public_key: uw.blob({ mode: 'buffer' }).notNull().$type<D1Blob>(),
		counter: uw.integer({ mode: 'number' }).notNull(),
		credential_device_type: uw.text().notNull(),
		credential_backed_up: uw.integer({ mode: 'boolean' }).notNull(),
		transports: uw.text({ mode: 'json' }).$type<string[]>(),
		/**
		 * last used to sign in
		 */
		a_time: uw.text({ mode: 'text', length: 24 }).$type<ISODateString>(),
		/**
		 * passkey was created time
		 */
		b_time: uw
			.text({ mode: 'text', length: 24 })
			.notNull()
			.$type<ISODateString>()
			.default(sql`(strftime('%FT%H:%M:%fZ', CURRENT_TIMESTAMP))`),
	}),
	(uw) => [unique().on(uw.u_id, uw.name)],
);

export const keyrings = sqliteTable('keyrings', (k) => ({
	kr_id: k.blob({ mode: 'buffer' }).primaryKey().notNull().$type<D1Blob>(),
	/**
	 * @deprecated DO NOT USE (BufferHelpers is faster and cheaper)
	 */
	kr_id_utf8: k
		.text({ mode: 'text' })
		.generatedAlwaysAs((): SQL => sql<UuidExport['utf8']>`lower(format('%s-%s-%s-%s-%s', substr(hex(${keyrings.kr_id}),1,8), substr(hex(${keyrings.kr_id}),9,4), substr(hex(${keyrings.kr_id}),13,4), substr(hex(${keyrings.kr_id}),17,4), substr(hex(${keyrings.kr_id}),21)))`, { mode: 'virtual' })
		.$type<UuidExport['utf8']>(),
	name: k.text({ mode: 'text' }).unique().notNull(),
	exportable: k.integer({ mode: 'boolean' }).notNull().default(false),
	key_type: k.text({ mode: 'text' }).notNull(),
	/**
	 * Not used for every key type
	 */
	key_size: k.integer({ mode: 'number' }),
	hash_size: k.integer({ mode: 'number' }),
	/**
	 * Actual cron is stored in scheduler DO, not here. This is just flag to enable/disable DO
	 * @default true and DO is created with cron of 1 year
	 * @link https://csrc.nist.gov/pubs/sp/800/57/pt1/r5/final
	 */
	time_rotation: k.integer({ mode: 'boolean' }).notNull().default(true),
	/**
	 * Number of encryptions before triggering key rotation
	 * @default 2^32
	 * @link https://csrc.nist.gov/pubs/sp/800/38/d/final
	 */
	count_rotation: k.blob({ mode: 'bigint' }).default(BigInt(2) ** BigInt(32)),
	/**
	 * keyring was created time
	 */
	b_time: k
		.text({ mode: 'text', length: 24 })
		.notNull()
		.$type<ISODateString>()
		.default(sql`(strftime('%FT%H:%M:%fZ', CURRENT_TIMESTAMP))`),
	/**
	 * keyring settings were changed time
	 */
	c_time: k
		.text({ mode: 'text', length: 24 })
		.notNull()
		.$type<ISODateString>()
		.default(sql`(strftime('%FT%H:%M:%fZ', CURRENT_TIMESTAMP))`),
	/**
	 * keyring was rotated
	 */
	m_time: k
		.text({ mode: 'text', length: 24 })
		.notNull()
		.$type<ISODateString>()
		.default(sql`(strftime('%FT%H:%M:%fZ', CURRENT_TIMESTAMP))`),
}));

export const datakeys = sqliteTable('datakeys', (d) => ({
	dk_id: d.blob({ mode: 'buffer' }).primaryKey().notNull().$type<D1Blob>(),
	/**
	 * @deprecated DO NOT USE (BufferHelpers is faster and cheaper)
	 */
	dk_id_utf8: d
		.text({ mode: 'text' })
		.generatedAlwaysAs((): SQL => sql<UuidExport['utf8']>`lower(format('%s-%s-%s-%s-%s', substr(hex(${datakeys.dk_id}),1,8), substr(hex(${datakeys.dk_id}),9,4), substr(hex(${datakeys.dk_id}),13,4), substr(hex(${datakeys.dk_id}),17,4), substr(hex(${datakeys.dk_id}),21)))`, { mode: 'virtual' })
		.$type<UuidExport['utf8']>(),
	kr_id: d
		.blob({ mode: 'buffer' })
		.notNull()
		.$type<D1Blob>()
		.references(() => keyrings.kr_id, { onUpdate: 'cascade', onDelete: 'cascade' }),
	/**
	 * @deprecated DO NOT USE (BufferHelpers is faster and cheaper)
	 */
	kr_id_utf8: d
		.text({ mode: 'text' })
		.generatedAlwaysAs((): SQL => sql<UuidExport['utf8']>`lower(format('%s-%s-%s-%s-%s', substr(hex(${datakeys.kr_id}),1,8), substr(hex(${datakeys.kr_id}),9,4), substr(hex(${datakeys.kr_id}),13,4), substr(hex(${datakeys.kr_id}),17,4), substr(hex(${datakeys.kr_id}),21)))`, { mode: 'virtual' })
		.$type<UuidExport['utf8']>(),
	/**
	 * Bitwarden secrets manager secret id
	 */
	bw_id: d.blob({ mode: 'buffer' }).unique().notNull().$type<D1Blob>(),
	/**
	 * @deprecated DO NOT USE (BufferHelpers is faster and cheaper)
	 */
	bw_id_utf8: d
		.text({ mode: 'text' })
		.generatedAlwaysAs((): SQL => sql<UuidExport['utf8']>`lower(format('%s-%s-%s-%s-%s', substr(hex(${datakeys.bw_id}),1,8), substr(hex(${datakeys.bw_id}),9,4), substr(hex(${datakeys.bw_id}),13,4), substr(hex(${datakeys.bw_id}),17,4), substr(hex(${datakeys.bw_id}),21)))`, { mode: 'virtual' })
		.$type<UuidExport['utf8']>(),
	/**
	 * last time key was used
	 */
	a_time: d.text({ mode: 'text', length: 24 }).$type<ISODateString>(),
	/**
	 * data key was created time
	 */
	b_time: d
		.text({ mode: 'text', length: 24 })
		.notNull()
		.$type<ISODateString>()
		.default(sql`(strftime('%FT%H:%M:%fZ', CURRENT_TIMESTAMP))`),
	encryption_count: d.blob({ mode: 'bigint' }).notNull().default(BigInt(0)),
}));

export const api_keys = sqliteTable('api_keys', (ak) => ({
	ak_id: ak.blob({ mode: 'buffer' }).primaryKey().notNull().$type<D1Blob>(),
	/**
	 * @deprecated DO NOT USE (BufferHelpers is faster and cheaper)
	 */
	ak_id_utf8: ak
		.text({ mode: 'text' })
		.generatedAlwaysAs((): SQL => sql<UuidExport['utf8']>`lower(format('%s-%s-%s-%s-%s', substr(hex(${api_keys.ak_id}),1,8), substr(hex(${api_keys.ak_id}),9,4), substr(hex(${api_keys.ak_id}),13,4), substr(hex(${api_keys.ak_id}),17,4), substr(hex(${api_keys.ak_id}),21)))`, { mode: 'virtual' })
		.$type<UuidExport['utf8']>(),
	name: ak.text({ mode: 'text' }).unique().notNull(),
	/**
	 * Hashed value of api key
	 */
	hash: ak.blob({ mode: 'buffer' }).unique().notNull().$type<D1Blob>(),
	expires: ak.text({ mode: 'text' }).notNull().$type<ISODateString>(),
	/**
	 * last time key was used
	 */
	a_time: ak.text({ mode: 'text', length: 24 }).$type<ISODateString>(),
	/**
	 * api key was created time
	 */
	b_time: ak
		.text({ mode: 'text', length: 24 })
		.notNull()
		.$type<ISODateString>()
		.default(sql`(strftime('%FT%H:%M:%fZ', CURRENT_TIMESTAMP))`),
	/**
	 * api key permissions changed time
	 */
	c_time: ak
		.text({ mode: 'text', length: 24 })
		.notNull()
		.$type<ISODateString>()
		.default(sql`(strftime('%FT%H:%M:%fZ', CURRENT_TIMESTAMP))`),
	/**
	 * api key rotated changed time
	 */
	m_time: ak
		.text({ mode: 'text', length: 24 })
		.notNull()
		.$type<ISODateString>()
		.default(sql`(strftime('%FT%H:%M:%fZ', CURRENT_TIMESTAMP))`),
}));

export const keyrings_api_keys = sqliteTable(
	'keyrings_api_keys',
	(kak) => ({
		kr_id: kak
			.blob({ mode: 'buffer' })
			.notNull()
			.$type<D1Blob>()
			.references(() => keyrings.kr_id, { onUpdate: 'cascade', onDelete: 'cascade' }),
		/**
		 * @deprecated DO NOT USE (BufferHelpers is faster and cheaper)
		 */
		kr_id_utf8: kak
			.text({ mode: 'text' })
			.generatedAlwaysAs((): SQL => sql<UuidExport['utf8']>`lower(format('%s-%s-%s-%s-%s', substr(hex(${keyrings_api_keys.kr_id}),1,8), substr(hex(${keyrings_api_keys.kr_id}),9,4), substr(hex(${keyrings_api_keys.kr_id}),13,4), substr(hex(${keyrings_api_keys.kr_id}),17,4), substr(hex(${keyrings_api_keys.kr_id}),21)))`, { mode: 'virtual' })
			.$type<UuidExport['utf8']>(),
		ak_id: kak
			.blob({ mode: 'buffer' })
			.notNull()
			.$type<D1Blob>()
			.references(() => api_keys.ak_id, { onUpdate: 'cascade', onDelete: 'cascade' }),
		/**
		 * @deprecated DO NOT USE (BufferHelpers is faster and cheaper)
		 */
		ak_id_utf8: kak
			.text({ mode: 'text' })
			.generatedAlwaysAs((): SQL => sql<UuidExport['utf8']>`lower(format('%s-%s-%s-%s-%s', substr(hex(${keyrings_api_keys.ak_id}),1,8), substr(hex(${keyrings_api_keys.ak_id}),9,4), substr(hex(${keyrings_api_keys.ak_id}),13,4), substr(hex(${keyrings_api_keys.ak_id}),17,4), substr(hex(${keyrings_api_keys.ak_id}),21)))`, { mode: 'virtual' })
			.$type<UuidExport['utf8']>(),
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
		/**
		 * Generate random bytes
		 */
		r_random: kak.integer({ mode: 'boolean' }).notNull().default(true),
		/**
		 * Hash data
		 */
		r_hash: kak.integer({ mode: 'boolean' }).notNull().default(true),
	}),
	(kak) => [unique().on(kak.kr_id, kak.ak_id)],
);
