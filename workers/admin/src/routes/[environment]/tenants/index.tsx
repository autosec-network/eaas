import { component$ } from '@builder.io/qwik';
import { routeLoader$ } from '@builder.io/qwik-city';
import { Cloudflare } from 'cloudflare';
import { StaticDatabase } from 'db/core';
import * as rootSchema from 'db/schemas/root';
import type { DrizzleD1Database } from 'drizzle-orm/d1';

// eslint-disable-next-line qwik/loader-location
const useTempNukeTenants = routeLoader$(async ({ sharedMap, platform }) => {
	const r_db = sharedMap.get('r_db') as DrizzleD1Database<typeof rootSchema>;
	const dbTenants: string[] = [];
	platform.ctx.waitUntil(
		// eslint-disable-next-line drizzle/enforce-delete-with-where
		r_db
			.delete(rootSchema.tenants)
			.returning({
				do_id: rootSchema.tenants.do_id,
			})
			.then((rows) =>
				rows.forEach((row) => {
					dbTenants.push(row.do_id.toString('hex'));
				}),
			),
	);

	const cf = new Cloudflare({ apiToken: platform.env.CF_API_TOKEN });
	const doTenants: string[] = [];
	for await (const object of cf.durableObjects.namespaces.objects.list(StaticDatabase.Tenant.Main['eaas-api-prod_TenantD0'], {
		account_id: platform.env.CF_ACCOUNT_ID,
		limit: 10000,
	})) {
		if (object.hasStoredData) {
			platform.ctx.waitUntil(
				(async () => {
					const doStub = platform.env.TENANT_D0_PROD.get(platform.env.TENANT_D0_PROD.idFromString(object.id!));
					return doStub.nuke('Admin nuke');
				})(),
			);
			platform.ctx.waitUntil(
				(async () => {
					const doStub = platform.env.TENANT_D0_PROD.get(platform.env.TENANT_D0_PROD.jurisdiction('eu').idFromString(object.id!));
					return doStub.nuke('Admin nuke');
				})(),
			);
			doTenants.push(object.id!);
		}
	}

	return {
		db: dbTenants,
		do: doTenants,
	};
});

export default component$(() => {
	const tempNukeTenants = useTempNukeTenants();

	return <pre class="text-black dark:text-white">{JSON.stringify(tempNukeTenants.value, null, '\t')}</pre>;
});
