import type { Session } from '@auth/qwik';
import { component$ } from '@builder.io/qwik';
import { Link, routeLoader$ } from '@builder.io/qwik-city';
import { LuPlus } from '@qwikest/icons/lucide';
import * as rootSchema from 'db/schemas/root';
import type { DrizzleD1Database } from 'drizzle-orm/d1';
import { desc, eq, sql } from 'drizzle-orm/sql';
import TenantRow from '~/components/team/tenant-row/tenant-row';

// eslint-disable-next-line @typescript-eslint/ban-ts-comment
// @ts-ignore this gets generated automatically later in the build process
import * as m from '~/paraglide/messages';

// Deliberately its own (blocking, server-side) query rather than the shared `useTenants` (which is lazy/client-only so other pages don't block SSR on a tenant lookup): this page's whole job is the 0/1/many decision, and redirecting via a client `nav()` after a resource resolves only patches the DOM once an SPA data fetch completes - a race that can silently no-op (URL changes, content doesn't) if that fetch is slow or fails. A real 302 sidesteps that, and since we already have to fetch every row to know the count, we reuse that same result for the list rendering below instead of fetching it twice.
// eslint-disable-next-line qwik/loader-location
const useTenantList = routeLoader$(async ({ sharedMap, redirect }) => {
	const session = sharedMap.get('session') as Session;
	const r_db = sharedMap.get('r_db') as DrizzleD1Database;

	const rows = await r_db
		.select({
			t_id: rootSchema.tenants.t_id,
			jurisdiction: rootSchema.tenants.jurisdiction,
			do_id: rootSchema.tenants.do_id,
		})
		.from(rootSchema.tenants)
		.innerJoin(rootSchema.users_tenants, eq(rootSchema.tenants.t_id, rootSchema.users_tenants.t_id))
		.where(eq(rootSchema.users_tenants.u_id, sql`unhex(${session.user?.u_id.hex})`))
		// Sort so newest is i[0]
		.orderBy(desc(rootSchema.tenants.t_id));

	if (rows.length < 1) {
		throw redirect(302, '/onboarding');
	} else if (rows.length === 1) {
		throw redirect(302, `/${rows[0]!.t_id.toString('base64url')}`);
	}

	return rows.map((row) => ({
		...row,
		t_id: {
			base64: row.t_id.toString('base64'),
			base64url: row.t_id.toString('base64url'),
		},
		do_id: row.do_id.toString('hex'),
	}));
});

export default component$(() => {
	const tenants = useTenantList();

	return (
		<div class="mx-auto max-w-lg px-6 py-10">
			<div class="mb-8 flex items-center justify-between">
				<div>
					<h1 class="text-2xl font-bold tracking-tight text-gray-900 dark:text-white">{m.team_page_title()}</h1>
					<p class="mt-1 text-sm text-gray-500 dark:text-gray-400">{m.team_page_subtitle()}</p>
				</div>
				<Link prefetch="js" href="/onboarding/" class="bg-primary-accent hover:bg-primary-accent/85 hover:shadow-primary-accent/25 inline-flex items-center gap-2 rounded-xl px-5 py-2.5 text-sm font-medium text-white transition-all duration-150 hover:shadow-md active:scale-[0.98]">
					<LuPlus class="h-4 w-4" />
					{m.team_page_new_team()}
				</Link>
			</div>

			<ul class="space-y-3">
				{tenants.value.map((tenant) => (
					<li key={tenant.t_id.base64}>
						<Link prefetch="js" href={`/${tenant.t_id.base64url}/`} class="border-surface-light/60 shadow-primary-accent/5 dark:border-surface-dark/60 dark:bg-surface-dark/70 group hover:shadow-primary-accent/10 inline-block w-full rounded-2xl border bg-white/70 shadow-sm backdrop-blur-md transition-all duration-150 hover:shadow-md">
							<TenantRow jurisdiction={tenant.jurisdiction} do_id={tenant.do_id} />
						</Link>
					</li>
				))}
			</ul>
		</div>
	);
});
