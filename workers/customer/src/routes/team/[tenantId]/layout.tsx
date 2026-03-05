import type { Session } from '@auth/qwik';
import type { RequestHandler } from '@builder.io/qwik-city';
import { DebugLogWriter, drizzleD0 } from 'db/core';
import * as rootSchema from 'db/schemas/root';
import * as tenantSchema from 'db/schemas/tenant';
import type { DrizzleD1Database } from 'drizzle-orm/d1';
import { DefaultLogger } from 'drizzle-orm/logger';
import { and, eq, sql } from 'drizzle-orm/sql';
import { hexToUuid } from 'helpers';
import { SQLCache } from 'helpers/db';
import { Buffer } from 'node:buffer';
import * as zm from 'zod/mini';

export const onRequest: RequestHandler = async ({ params, sharedMap, platform, redirect }) => {
	const zm_t_id_base64url = await zm.base64url().check(zm.trim(), zm.length(22)).safeParseAsync(params['tenantId']);

	if (zm_t_id_base64url.success) {
		const t_id = Buffer.from(zm_t_id_base64url.data, 'base64url');
		const t_id_hex = t_id.toString('hex').toLowerCase();
		const zm_t_id_utf8 = await zm.uuidv7().check(zm.trim(), zm.toLowerCase()).safeParseAsync(hexToUuid(t_id_hex.toLowerCase()));

		if (zm_t_id_utf8.success) {
			const session = sharedMap.get('session') as Session;
			const r_db = sharedMap.get('r_db') as DrizzleD1Database<typeof rootSchema>;

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

				const doNamespace = tenant.jurisdiction ? platform.env.TENANT_D0.jurisdiction(tenant.jurisdiction) : platform.env.TENANT_D0;
				const doId = tenant.do_id ? doNamespace.idFromString(tenant.do_id) : doNamespace.idFromName(hexToUuid(t_id_hex));
				const doStub = doNamespace.get(doId);
				sharedMap.set('t_do', doStub);
				const browserCache = sharedMap.get('browserCache') as boolean;
				sharedMap.set(
					't_db',
					drizzleD0(doStub, {
						...(platform.env.NODE_ENV !== 'production' && { logger: new DefaultLogger({ writer: new DebugLogWriter(doId.toString()) }) }),
						schema: tenantSchema,
						casing: 'snake_case',
						...(browserCache && {
							cache: new SQLCache(
								{
									dbName: doId.toString(),
									dbType: 'do',
									strategy: 'all',
									cacheTTL: parseInt(platform.env.SQL_TTL, 10),
									logging: platform.env.NODE_ENV !== 'production',
								},
								// eslint-disable-next-line @typescript-eslint/no-unnecessary-condition
								globalThis.caches ?? platform.caches,
							),
						}),
					}),
				);
			} else {
				// Tenant doesn't exist or user doesn't have access
				throw redirect(307, '/team');
			}
		} else {
			// Not valid uuid
			throw redirect(307, '/team');
		}
	} else {
		// Not base64url
		throw redirect(307, '/team');
	}
};
