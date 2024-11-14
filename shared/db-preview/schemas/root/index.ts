import type { AdapterAccount } from '@auth/core/adapters';
import { sql, type SQL } from 'drizzle-orm';
import { primaryKey, sqliteTable, unique, uniqueIndex, type AnySQLiteColumn } from 'drizzle-orm/sqlite-core';
import type { EmailAddress, ISODateString, UuidExport } from '../../../types/d1/index.mjs';

// It fails if it's imported
/**
 * @returns a copy of string `x` with all ASCII characters converted to lower case
 * @link https://sqlite.org/lang_corefunc.html#lower
 */
function lower<T extends unknown = string>(x: AnySQLiteColumn) {
	return sql<T>`lower(${x})`;
}

export const users = sqliteTable(
	'users',
	(u) => ({
		u_id: u.blob({ mode: 'buffer' }).primaryKey().notNull(),
		/**
		 * @deprecated DO NOT USE (BufferHelpers is faster and cheaper)
		 */
		u_id_utf8: u
			.text({ mode: 'text' })
			.generatedAlwaysAs((): SQL => sql<UuidExport['utf8']>`lower(format('%s-%s-%s-%s-%s', substr(hex(${users.u_id}),1,8), substr(hex(${users.u_id}),9,4), substr(hex(${users.u_id}),13,4), substr(hex(${users.u_id}),17,4), substr(hex(${users.u_id}),21)))`, { mode: 'virtual' })
			.$type<UuidExport['utf8']>(),
		d1_id: u.blob({ mode: 'buffer' }).unique().notNull(),
		/**
		 * @deprecated DO NOT USE (BufferHelpers is faster and cheaper)
		 */
		d1_id_utf8: u
			.text({ mode: 'text' })
			.generatedAlwaysAs((): SQL => sql<UuidExport['utf8']>`lower(format('%s-%s-%s-%s-%s', substr(hex(${users.d1_id}),1,8), substr(hex(${users.d1_id}),9,4), substr(hex(${users.d1_id}),13,4), substr(hex(${users.d1_id}),17,4), substr(hex(${users.d1_id}),21)))`, { mode: 'virtual' })
			.$type<UuidExport['utf8']>(),
		email: u.text({ mode: 'text' }).notNull().$type<EmailAddress>(),
		partial_user: u.integer({ mode: 'boolean' }).notNull().default(false),
	}),
	(u) => ({
		case_insensitive_email: uniqueIndex('case_insensitive_email').on(lower(u.email)),
	}),
);

export const tenants = sqliteTable('tenants', (t) => ({
	t_id: t.blob({ mode: 'buffer' }).primaryKey().notNull(),
	/**
	 * @deprecated DO NOT USE (BufferHelpers is faster and cheaper)
	 */
	t_id_utf8: t
		.text({ mode: 'text' })
		.generatedAlwaysAs((): SQL => sql<UuidExport['utf8']>`lower(format('%s-%s-%s-%s-%s', substr(hex(${tenants.t_id}),1,8), substr(hex(${tenants.t_id}),9,4), substr(hex(${tenants.t_id}),13,4), substr(hex(${tenants.t_id}),17,4), substr(hex(${tenants.t_id}),21)))`, { mode: 'virtual' })
		.$type<UuidExport['utf8']>(),
	d1_id: t.blob({ mode: 'buffer' }).unique().notNull(),
	/**
	 * @deprecated DO NOT USE (BufferHelpers is faster and cheaper)
	 */
	d1_id_utf8: t
		.text({ mode: 'text' })
		.generatedAlwaysAs((): SQL => sql<UuidExport['utf8']>`lower(format('%s-%s-%s-%s-%s', substr(hex(${tenants.d1_id}),1,8), substr(hex(${tenants.d1_id}),9,4), substr(hex(${tenants.d1_id}),13,4), substr(hex(${tenants.d1_id}),17,4), substr(hex(${tenants.d1_id}),21)))`, { mode: 'virtual' })
		.$type<UuidExport['utf8']>(),
}));

export const users_tenants = sqliteTable(
	'users_tenants',
	(ut) => ({
		u_id: ut
			.blob({ mode: 'buffer' })
			.notNull()
			.references(() => users.u_id, { onUpdate: 'cascade', onDelete: 'cascade' }),
		/**
		 * @deprecated DO NOT USE (BufferHelpers is faster and cheaper)
		 */
		u_id_utf8: ut
			.text({ mode: 'text' })
			.generatedAlwaysAs((): SQL => sql<UuidExport['utf8']>`lower(format('%s-%s-%s-%s-%s', substr(hex(${users_tenants.u_id}),1,8), substr(hex(${users_tenants.u_id}),9,4), substr(hex(${users_tenants.u_id}),13,4), substr(hex(${users_tenants.u_id}),17,4), substr(hex(${users_tenants.u_id}),21)))`, { mode: 'virtual' })
			.$type<UuidExport['utf8']>(),
		t_id: ut
			.blob({ mode: 'buffer' })
			.notNull()
			.references(() => tenants.t_id, { onUpdate: 'cascade', onDelete: 'cascade' }),
		/**
		 * @deprecated DO NOT USE (BufferHelpers is faster and cheaper)
		 */
		t_id_utf8: ut
			.text({ mode: 'text' })
			.generatedAlwaysAs((): SQL => sql<UuidExport['utf8']>`lower(format('%s-%s-%s-%s-%s', substr(hex(${users_tenants.t_id}),1,8), substr(hex(${users_tenants.t_id}),9,4), substr(hex(${users_tenants.t_id}),13,4), substr(hex(${users_tenants.t_id}),17,4), substr(hex(${users_tenants.t_id}),21)))`, { mode: 'virtual' })
			.$type<UuidExport['utf8']>(),
	}),
	(ut) => ({
		unq: unique().on(ut.u_id, ut.t_id),
	}),
);

export const users_accounts = sqliteTable(
	'users_accounts',
	(ua) => ({
		u_id: ua
			.blob({ mode: 'buffer' })
			.notNull()
			.references(() => users.u_id, { onUpdate: 'cascade', onDelete: 'cascade' }),
		/**
		 * @deprecated DO NOT USE (BufferHelpers is faster and cheaper)
		 */
		u_id_utf8: ua
			.text({ mode: 'text' })
			.generatedAlwaysAs((): SQL => sql<UuidExport['utf8']>`lower(format('%s-%s-%s-%s-%s', substr(hex(${users_accounts.u_id}),1,8), substr(hex(${users_accounts.u_id}),9,4), substr(hex(${users_accounts.u_id}),13,4), substr(hex(${users_accounts.u_id}),17,4), substr(hex(${users_accounts.u_id}),21)))`, { mode: 'virtual' })
			.$type<UuidExport['utf8']>(),
		provider: ua.text({ mode: 'text' }).notNull().$type<AdapterAccount['provider']>(),
		provider_account_id: ua.text({ mode: 'text' }).notNull().$type<AdapterAccount['providerAccountId']>(),
	}),
	(uaa) => ({
		pk: primaryKey({ columns: [uaa.provider, uaa.provider_account_id] }),
	}),
);

export const users_sessions = sqliteTable('users_sessions', (us) => ({
	u_id: us
		.blob({ mode: 'buffer' })
		.notNull()
		.references(() => users.u_id, { onUpdate: 'cascade', onDelete: 'cascade' }),
	/**
	 * @deprecated DO NOT USE (BufferHelpers is faster and cheaper)
	 */
	u_id_utf8: us
		.text({ mode: 'text' })
		.generatedAlwaysAs((): SQL => sql<UuidExport['utf8']>`lower(format('%s-%s-%s-%s-%s', substr(hex(${users_sessions.u_id}),1,8), substr(hex(${users_sessions.u_id}),9,4), substr(hex(${users_sessions.u_id}),13,4), substr(hex(${users_sessions.u_id}),17,4), substr(hex(${users_sessions.u_id}),21)))`, { mode: 'virtual' })
		.$type<UuidExport['utf8']>(),
	s_id: us.blob({ mode: 'buffer' }).primaryKey().notNull(),
	/**
	 * @deprecated DO NOT USE (BufferHelpers is faster and cheaper)
	 */
	s_id_utf8: us
		.text({ mode: 'text' })
		.generatedAlwaysAs((): SQL => sql<UuidExport['utf8']>`lower(format('%s-%s-%s-%s-%s', substr(hex(${users_sessions.s_id}),1,8), substr(hex(${users_sessions.s_id}),9,4), substr(hex(${users_sessions.s_id}),13,4), substr(hex(${users_sessions.s_id}),17,4), substr(hex(${users_sessions.s_id}),21)))`, { mode: 'virtual' })
		.$type<UuidExport['utf8']>(),
	expires: us.text({ mode: 'text' }).notNull().$type<ISODateString>(),
}));
