import type { Session } from '@auth/qwik';
import { routeLoader$, type RequestHandler } from '@builder.io/qwik-city';
import { SQLCache } from 'db/cache';
import { DebugLogWriter, drizzleD0 } from 'db/core';
import * as rootSchema from 'db/schemas/root';
import * as tenantSchema from 'db/schemas/tenant/main';
import type { DrizzleD1Database } from 'drizzle-orm/d1';
import { DefaultLogger } from 'drizzle-orm/logger';
import { and, eq, sql } from 'drizzle-orm/sql';
import type { SqliteRemoteDatabase } from 'drizzle-orm/sqlite-proxy';
import { hexToUuid } from 'helpers';
import { Buffer } from 'node:buffer';
import * as zm from 'zod/mini';
import { deriveId, isLocal, resolveDoStub, type DOLocator } from '~/helpers/do-proxy';

export const onRequest: RequestHandler = async ({ params, sharedMap, platform, redirect }) => {
	const zm_t_id_base64url = await zm.base64url().check(zm.trim(), zm.length(22)).safeParseAsync(params['tenantId']);

	if (zm_t_id_base64url.success) {
		const t_id = Buffer.from(zm_t_id_base64url.data, 'base64url');
		const t_id_hex = t_id.toString('hex').toLowerCase();
		const zm_t_id_utf8 = await zm.uuidv7().check(zm.trim(), zm.toLowerCase()).safeParseAsync(hexToUuid(t_id_hex.toLowerCase()));

		if (zm_t_id_utf8.success) {
			const session = sharedMap.get('session') as Session;
			const r_db = sharedMap.get('r_db') as DrizzleD1Database;

			const [tenant] = await r_db
				.select({
					do_id: rootSchema.tenants.do_id,
					jurisdiction: rootSchema.tenants.jurisdiction,
				})
				.from(rootSchema.tenants)
				.innerJoin(rootSchema.users_tenants, eq(rootSchema.tenants.t_id, rootSchema.users_tenants.t_id))
				.where(
					and(
						// Check the tenant from url
						eq(rootSchema.tenants.t_id, sql`unhex(${t_id_hex})`),
						// Make sure user has access to the tenant
						eq(rootSchema.users_tenants.u_id, sql`unhex(${session.user!.u_id.hex})`),
					),
				)
				.limit(1)
				.then((rows) =>
					rows.map((row) => ({
						...row,
						do_id: row.do_id.toString('hex'),
					})),
				);

			if (tenant) {
				sharedMap.set('t_id_hex', t_id_hex);
				sharedMap.set('t_id_base64', t_id.toString('base64'));

				// Locally we can't derive a jurisdictional id (workerd throws), so defer that to the proxy and leave the derivation-carrying locator raw.
				const useProxy = isLocal(platform) && !!platform.env.TENANT_D0_PROXY;
				const locator: DOLocator = tenant.do_id ? { id: tenant.do_id, jurisdiction: tenant.jurisdiction ?? undefined } : { name: hexToUuid(t_id_hex), jurisdiction: tenant.jurisdiction ?? undefined };
				// Stable cache key: the resolved id hex when deployed, else whatever identifies the locator locally.
				const doDbName = useProxy ? (locator.id ?? locator.name!) : deriveId(platform.env.TENANT_D0, locator).toString();
				const doStub = resolveDoStub(platform, platform.env.TENANT_D0, platform.env.TENANT_D0_PROXY, locator);
				sharedMap.set('t_do', doStub);
				const browserCache = sharedMap.get('browserCache') as boolean;
				sharedMap.set(
					't_db',
					drizzleD0(doStub, {
						// ...(platform.env.NODE_ENV !== 'production' && { logger: new DefaultLogger({ writer: new DebugLogWriter(doDbName) }) }),
						logger: new DefaultLogger({ writer: new DebugLogWriter(doDbName) }),
						cache: new SQLCache(
							{
								dbName: doDbName,
								dbType: 'do',
								strategy: browserCache ? 'all' : 'explicit',
								cacheTTL: parseInt(platform.env.SQL_TTL, 10),
								logging: platform.env.NODE_ENV !== 'production',
							},
							// eslint-disable-next-line @typescript-eslint/no-unnecessary-condition
							globalThis.caches ?? platform.caches,
						),
					}),
				);
			} else {
				// Tenant doesn't exist or user doesn't have access
				throw redirect(307, '/');
			}
		} else {
			// Not valid uuid
			throw redirect(307, '/');
		}
	} else {
		// Not base64url
		throw redirect(307, '/');
	}
};

export const usePermissions = routeLoader$(async ({ sharedMap }) => {
	const session = sharedMap.get('session') as Session;
	const t_db = sharedMap.get('t_db') as SqliteRemoteDatabase;

	const [[basePerms], overridePerms] = await t_db.batch([
		t_db
			.select({
				r_tenant: tenantSchema.users.r_tenant,
				r_users: tenantSchema.users.r_users,
				r_roles: tenantSchema.users.r_roles,
				r_billing: tenantSchema.users.r_billing,
				r_apikeys: tenantSchema.users.r_apikeys,
				r_keyring: tenantSchema.users.r_keyring,
				r_datakey: tenantSchema.users.r_datakey,
				r_logs: tenantSchema.users.r_logs,
			})
			.from(tenantSchema.users)
			.where(and(eq(tenantSchema.users.u_id, sql`unhex(${session.user?.u_id.hex})`), eq(tenantSchema.users.approved, true)))
			.limit(1),
		t_db
			.select({
				kr_id: tenantSchema.users_keyrings.kr_id,
				r_keyring: tenantSchema.users_keyrings.r_keyring,
				r_datakey: tenantSchema.users_keyrings.r_datakey,
			})
			.from(tenantSchema.users_keyrings)
			.where(and(eq(tenantSchema.users_keyrings.u_id, sql`unhex(${session.user?.u_id.hex})`))),
	]);

	if (basePerms) {
		const overrides = overridePerms.reduce<Record<string, Record<string, unknown>>>((acc, row) => {
			acc[row.kr_id.toString('base64')] = Object.entries(row).reduce<Record<string, unknown>>((roles, [key, value]) => {
				if (key.startsWith('r_')) roles[key] = value;
				return roles;
			}, {});
			return acc;
		}, {});

		return {
			...basePerms,
			overrides,
		};
	} else {
		return false as const;
	}
});
