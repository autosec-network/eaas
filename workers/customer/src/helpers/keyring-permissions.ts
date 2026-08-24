import * as tenantSchema from 'db/schemas/tenant/main';
import { and, eq, sql } from 'drizzle-orm/sql';
import type { SqliteRemoteDatabase } from 'drizzle-orm/sqlite-proxy';
import { Permissions } from 'types';

export interface KeyringPermissions {
	r_keyring: Permissions;
	r_datakey: Permissions;
}

export const NO_KEYRING_PERMISSIONS: KeyringPermissions = { r_keyring: Permissions.None, r_datakey: Permissions.None };

/**
 * {@link Permissions} is a **numeric** enum, so it carries a reverse mapping and `Object.values()` returns the four names alongside the four levels - hence the filter rather than a hand-written list.
 */
const PERMISSION_LEVELS: readonly number[] = Object.values(Permissions).filter((value) => typeof value === 'number');

/**
 * Narrow an untyped permission level - as `usePermissions` hands overrides back, `Record<string, unknown>` - onto the enum.
 *
 * Anything that isn't one of the four levels reads as {@link Permissions.None}, so a column that somehow holds a `4` grants nothing rather than out-ranking `Admin`.
 */
export function toPermission(value: unknown): Permissions {
	const level = Number(value ?? Permissions.None);
	return PERMISSION_LEVELS.includes(level) ? level : Permissions.None;
}

const highest = (a: Permissions, b: Permissions): Permissions => (a > b ? a : b);

/**
 * A `users_keyrings` row **raises** what `users` already grants for that one keyring - it never lowers it.
 *
 * `users.r_keyring` level 1 is documented as "Can see all keyrings", a tenant-wide grant; letting a per-keyring row take that away would mean the same person could see a keyring through the list but not through its own page. So the override table is read the way `api_keys_keyrings` is: a way to hand someone a single keyring they'd otherwise have no claim to.
 */
export function mergeKeyringPermissions(base: KeyringPermissions, override: Record<string, unknown> | undefined): KeyringPermissions {
	return {
		r_keyring: highest(base.r_keyring, toPermission(override?.['r_keyring'])),
		r_datakey: highest(base.r_datakey, toPermission(override?.['r_datakey'])),
	};
}

/**
 * What this user may do to one specific keyring, read fresh out of the tenant DB.
 *
 * Actions call this rather than trusting the page's `usePermissions` loader: a mutation shouldn't be authorised by a value the request that's mutating didn't fetch.
 */
export async function readKeyringPermissions(t_db: SqliteRemoteDatabase, u_id_hex: string, kr_id_hex: string): Promise<KeyringPermissions> {
	const [[base], [override]] = await t_db.batch([
		t_db
			.select({ r_keyring: tenantSchema.users.r_keyring, r_datakey: tenantSchema.users.r_datakey })
			.from(tenantSchema.users)
			.where(and(eq(tenantSchema.users.u_id, sql`unhex(${u_id_hex})`), eq(tenantSchema.users.approved, true)))
			.limit(1),
		t_db
			.select({ r_keyring: tenantSchema.users_keyrings.r_keyring, r_datakey: tenantSchema.users_keyrings.r_datakey })
			.from(tenantSchema.users_keyrings)
			.where(and(eq(tenantSchema.users_keyrings.u_id, sql`unhex(${u_id_hex})`), eq(tenantSchema.users_keyrings.kr_id, sql`unhex(${kr_id_hex})`)))
			.limit(1),
	]);

	return base ? mergeKeyringPermissions(base, override) : NO_KEYRING_PERMISSIONS;
}

/**
 * The tenant-wide half only - what gates "create a keyring", which by definition has no keyring to override against yet.
 */
export function readTenantPermissions(t_db: SqliteRemoteDatabase, u_id_hex: string): Promise<KeyringPermissions> {
	return t_db
		.select({ r_keyring: tenantSchema.users.r_keyring, r_datakey: tenantSchema.users.r_datakey })
		.from(tenantSchema.users)
		.where(and(eq(tenantSchema.users.u_id, sql`unhex(${u_id_hex})`), eq(tenantSchema.users.approved, true)))
		.limit(1)
		.then(([base]) => base ?? NO_KEYRING_PERMISSIONS);
}
