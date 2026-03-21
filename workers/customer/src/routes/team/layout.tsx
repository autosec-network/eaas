import type { Session } from '@auth/qwik';
import { routeLoader$, server$ } from '@builder.io/qwik-city';
import * as rootSchema from 'db/schemas/root';
import type { DrizzleD1Database } from 'drizzle-orm/d1';
import { desc, eq, sql } from 'drizzle-orm/sql';
import type { DOJurisdictions } from 'types';

// eslint-disable-next-line @typescript-eslint/require-await
export const useTenants = routeLoader$(async ({ sharedMap }) => async () => {
	const session = sharedMap.get('session') as Session;

	const r_db = sharedMap.get('r_db') as DrizzleD1Database<typeof rootSchema>;

	return (
		r_db
			.select({
				t_id: rootSchema.tenants.t_id,
				jurisdiction: rootSchema.tenants.jurisdiction,
				do_id: rootSchema.tenants.do_id,
			})
			.from(rootSchema.tenants)
			.innerJoin(rootSchema.users_tenants, eq(rootSchema.tenants.t_id, rootSchema.users_tenants.t_id))
			.where(eq(rootSchema.users_tenants.u_id, sql`unhex(${session.user?.u_id.hex})`))
			// Sort so newest is i[0]
			.orderBy(desc(rootSchema.tenants.t_id))
			.then((rows) =>
				rows.map((row) => ({
					...row,
					t_id: {
						base64: row.t_id.toString('base64'),
						base64url: row.t_id.toString('base64url'),
					},
					do_id: row.do_id.toString('hex'),
				})),
			)
	);
});

export const getTenantPickerProperties = server$(function (jurisdiction: DOJurisdictions | null, do_id: string) {
	const doNamespace = jurisdiction ? this.platform.env.TENANT_D0.jurisdiction(jurisdiction) : this.platform.env.TENANT_D0;
	const doStub = doNamespace.get(doNamespace.idFromString(do_id));

	return doStub.getProperties(
		{
			name: true,
			avatar: true,
			m_time: true,
		},
		true,
	);
});
