import { component$, Resource } from '@builder.io/qwik';
import { routeLoader$, type DocumentHead } from '@builder.io/qwik-city';
import { StaticDatabase } from 'db/core';
import * as rootSchema from 'db/schemas/root';
import type { DrizzleD1Database } from 'drizzle-orm/d1';
import { eq, sql } from 'drizzle-orm/sql';
import type { DOJurisdictions } from 'types';
import { PropertiesTable } from '~/components/properties-table/properties-table';
import { useTenantIds } from '~/routes/[environment]/tenants/[tid]/layout';
import type { TenantDoStub } from '~/routes/[environment]/tenants/tenant-ops';
import { useCfAccountId } from '~/routes/layout';

/**
 * Reads the tenant from both places it lives — the root lookup row and its Durable Object — rather than trusting either on its own.
 */
export const useTenantProperties = routeLoader$(({ sharedMap }) => {
	const r_db = sharedMap.get('r_db') as DrizzleD1Database;
	const t_do = sharedMap.get('t_do') as TenantDoStub;
	const t_id_hex = sharedMap.get('t_id_hex') as string;
	const t_do_id_hex = sharedMap.get('t_do_id_hex') as string;
	const t_logs_do_id_hex = sharedMap.get('t_logs_do_id_hex') as string;
	const jurisdiction = sharedMap.get('t_jurisdiction') as DOJurisdictions | null;

	return async () => {
		const [rootRow, properties] = await Promise.all([
			r_db
				.select({
					t_id: rootSchema.tenants.t_id,
					jurisdiction: rootSchema.tenants.jurisdiction,
					do_id: rootSchema.tenants.do_id,
				})
				.from(rootSchema.tenants)
				.where(eq(rootSchema.tenants.t_id, sql`unhex(${t_id_hex})`))
				.limit(1)
				.then((rows) =>
					rows.map((row) => ({
						...row,
						t_id: row.t_id.toString('hex'),
						do_id: row.do_id.toString('hex'),
					})),
				)
				.then(([row]) => row ?? null),
			t_do.getProperties(undefined, true).catch(() => ({})),
		]);

		return {
			root: rootRow,
			// Binary properties (e.g. the noise static public key) aren't serializable, so they're reported by size instead
			properties: Object.fromEntries(Object.entries(properties).map(([key, value]) => [key, value instanceof ArrayBuffer ? `${value.byteLength} bytes` : value])),
			jurisdiction,
			t_do_id_hex,
			t_logs_do_id_hex,
			// A root row whose `do_id` isn't the one we're reading means the lookup table and the durable object have drifted apart
			doIdMatchesRoot: rootRow ? rootRow.do_id === t_do_id_hex : null,
		};
	};
});

export const head: DocumentHead = {
	title: 'Tenant Properties — EaaS Admin',
};

export default component$(() => {
	const ids = useTenantIds();
	const tenantProperties = useTenantProperties();
	const cfAccountId = useCfAccountId();

	return (
		<div class="space-y-8">
			{/* Identifiers */}
			<div>
				<h2 class="text-heading mb-3 text-lg font-semibold dark:text-white">Identifiers</h2>
				<div class="border-default-medium bg-surface-light dark:bg-surface-dark overflow-x-auto border">
					<table class="text-body w-full text-left text-sm dark:text-gray-400">
						<tbody>
							{(
								[
									['Tenant ID (utf8)', ids.value.utf8],
									['Tenant ID (hex)', ids.value.hex],
									['Tenant ID (base64)', ids.value.base64],
									['Tenant ID (base64url)', ids.value.base64url],
								] as [string, string][]
							).map(([label, value]) => (
								<tr key={label} class="border-default-medium border-b dark:border-gray-700">
									<td class="px-4 py-3 text-xs uppercase">{label}</td>
									<td class="px-4 py-3">
										<code class="text-xs break-all">{value}</code>
									</td>
								</tr>
							))}
							<Resource
								value={tenantProperties}
								onPending={() => (
									<tr>
										<td colSpan={2} class="px-4 py-3">
											<span class="text-body-subtle text-sm dark:text-gray-500">Loading durable object references…</span>
										</td>
									</tr>
								)}
								onResolved={(data) => (
									<>
										<tr class="border-default-medium border-b dark:border-gray-700">
											<td class="px-4 py-3 text-xs uppercase">Jurisdiction</td>
											<td class="px-4 py-3 text-sm">{data.jurisdiction ?? <span class="text-body-subtle italic">none</span>}</td>
										</tr>
										<tr class="border-default-medium border-b dark:border-gray-700">
											<td class="px-4 py-3 text-xs uppercase">Durable object</td>
											<td class="px-4 py-3">
												<a target="_blank" rel="noopener noreferrer" href={`https://dash.cloudflare.com/${cfAccountId.value}/workers/durable-objects/view/${StaticDatabase.Tenant.Main['eaas-api-prod_TenantD0']}/studio?objectId=${data.t_do_id_hex}`} class="text-primary-accent hover:underline">
													<code class="text-xs break-all">{data.t_do_id_hex}</code>
												</a>
												{data.doIdMatchesRoot === false && <p class="mt-1 text-xs text-red-600 dark:text-red-400">Root lookup row points at {data.root?.do_id} instead.</p>}
												{data.root === null && <p class="mt-1 text-xs text-amber-600 dark:text-amber-400">Derived from the tenant id — there is no root lookup row.</p>}
											</td>
										</tr>
										<tr class="border-default-medium border-b dark:border-gray-700">
											<td class="px-4 py-3 text-xs uppercase">Logs durable object</td>
											<td class="px-4 py-3">
												<a target="_blank" rel="noopener noreferrer" href={`https://dash.cloudflare.com/${cfAccountId.value}/workers/durable-objects/view/${StaticDatabase.Tenant.Logs['eaas-api-prod_TenantD0Logs']}/studio?objectId=${data.t_logs_do_id_hex}`} class="text-primary-accent hover:underline">
													<code class="text-xs break-all">{data.t_logs_do_id_hex}</code>
												</a>
												<p class="text-body-subtle mt-1 text-xs dark:text-gray-500">Always derived from the tenant id — root never stores it.</p>
											</td>
										</tr>
									</>
								)}
							/>
						</tbody>
					</table>
				</div>
			</div>

			{/* Durable Object properties */}
			<Resource
				value={tenantProperties}
				onPending={() => (
					<div class="px-4 py-8 text-center">
						<span class="text-body-subtle dark:text-gray-500">Loading tenant properties…</span>
					</div>
				)}
				onRejected={(error) => (
					<div class="rounded-lg border border-red-300 bg-red-50 p-4 text-sm text-red-800 dark:border-red-800 dark:bg-red-900/20 dark:text-red-400">
						Failed to load tenant properties: {error.name}: {error.message}
					</div>
				)}
				onResolved={(data) => <PropertiesTable title="Tenant Properties" properties={data.properties} emptyLabel="No properties stored — this durable object is empty." />}
			/>
		</div>
	);
});
