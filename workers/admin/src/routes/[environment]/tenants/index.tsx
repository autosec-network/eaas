import { $, component$, Resource, useComputed$, useSignal, useStore } from '@builder.io/qwik';
import { routeAction$, routeLoader$, useLocation, useNavigate, z, zod$, type DocumentHead } from '@builder.io/qwik-city';
import { LuAlertTriangle, LuArrowDown, LuArrowUp, LuArrowUpDown, LuTrash2 } from '@qwikest/icons/lucide';
import { Cloudflare } from 'cloudflare';
import { StaticDatabase } from 'db/core';
import * as rootSchema from 'db/schemas/root';
import type { DrizzleD1Database } from 'drizzle-orm/d1';
import { eq, sql } from 'drizzle-orm/sql';
import { Pagination } from '~/components/pagination/pagination';
import { TenantRow } from '~/components/tenant-row/tenant-row';
import { TenantsToolbar } from '~/components/tenants-toolbar/tenants-toolbar';
import { actionErrorMessage } from '~/routes/[environment]/tenants/db-helpers';
import { listDoInstances, purgeTenant, resolveDoIdFromString, serializeActionError, tryResolveTenantLogsDoIdHex, uuidAnyFormatSchema } from '~/routes/[environment]/tenants/tenant-ops';
import { hexToUuid } from '~/routes/[environment]/users/db-helpers';

const PAGE_SIZE = 100;

type SortColumn = 't_id' | 'do_id';
type SortDir = 'asc' | 'desc';

const SORT_COLUMNS: SortColumn[] = ['t_id', 'do_id'];

/**
 * Tenants exist in two places at once — a row in the root `tenants` lookup table and a live Durable Object (plus a second one for its logs) — so both sides are loaded together and the page's whole job is surfacing where they disagree.
 */
export const useTenantsPage = routeLoader$(({ sharedMap, url, platform }) => {
	const r_db = sharedMap.get('r_db') as DrizzleD1Database;

	const page = Math.max(1, parseInt(url.searchParams.get('page') ?? '1', 10) || 1);
	const sortParam = url.searchParams.get('sort');
	const sortCol: SortColumn = SORT_COLUMNS.find((column) => column === sortParam) ?? 't_id';
	const sortDir: SortDir = url.searchParams.get('dir') === 'asc' ? 'asc' : 'desc';
	const query = (url.searchParams.get('q') ?? '').trim().toLowerCase();
	const driftOnly = url.searchParams.get('drift') === '1';

	return async () => {
		const cf = new Cloudflare({ apiToken: platform.env.CF_API_TOKEN });

		const [tenantRows, doInstances, logsDoInstances] = await Promise.all([
			r_db
				.select({
					t_id: rootSchema.tenants.t_id,
					jurisdiction: rootSchema.tenants.jurisdiction,
					do_id: rootSchema.tenants.do_id,
				})
				.from(rootSchema.tenants),
			listDoInstances(cf, platform.env.CF_ACCOUNT_ID, StaticDatabase.Tenant.Main['eaas-api-prod_TenantD0']),
			listDoInstances(cf, platform.env.CF_ACCOUNT_ID, StaticDatabase.Tenant.Logs['eaas-api-prod_TenantD0Logs']),
		]);

		const tenants = tenantRows.map((row) => {
			const t_id_hex = row.t_id.toString('hex');
			const do_id_hex = row.do_id.toString('hex');
			const logs_do_id_hex = tryResolveTenantLogsDoIdHex(platform.env.TENANT_D0_LOGS_PROD, row.jurisdiction, t_id_hex);
			const doExists = doInstances[do_id_hex] ?? false;
			const logsDoExists = logs_do_id_hex ? (logsDoInstances[logs_do_id_hex] ?? false) : false;

			return {
				t_id_hex,
				t_id_uuid: hexToUuid(t_id_hex),
				t_id_base64url: row.t_id.toString('base64url'),
				jurisdiction: row.jurisdiction,
				do_id_hex,
				logs_do_id_hex,
				doExists,
				logsDoExists,
				hasDrift: !doExists || (logs_do_id_hex !== null && !logsDoExists),
			};
		});

		// A Durable Object holding data that no root row points at can't be traced back to a tenant id (`idFromName` is one-way), so the only unambiguous repair is wiping it
		const knownDoIds = new Set(tenants.map((tenant) => tenant.do_id_hex));
		const knownLogsDoIds = new Set(tenants.flatMap((tenant) => (tenant.logs_do_id_hex ? [tenant.logs_do_id_hex] : [])));
		// Without every logs id derived, an unmatched logs object could just as easily be a live tenant's — never offer to nuke on a guess
		const logsIdsResolved = tenants.every((tenant) => tenant.logs_do_id_hex !== null);
		const orphanedDoIds = Object.entries(doInstances)
			.filter(([id, hasStoredData]) => hasStoredData && !knownDoIds.has(id))
			.map(([id]) => id);
		const orphanedLogsDoIds = logsIdsResolved
			? Object.entries(logsDoInstances)
					.filter(([id, hasStoredData]) => hasStoredData && !knownLogsDoIds.has(id))
					.map(([id]) => id)
			: [];

		const driftCount = tenants.filter((tenant) => tenant.hasDrift).length;

		const filtered = tenants.filter((tenant) => {
			if (driftOnly && !tenant.hasDrift) return false;
			if (!query) return true;

			return [tenant.t_id_hex, tenant.t_id_uuid, tenant.t_id_base64url.toLowerCase(), tenant.do_id_hex, tenant.logs_do_id_hex ?? ''].some((candidate) => candidate.includes(query));
		});

		const compare = (left: (typeof filtered)[number], right: (typeof filtered)[number]) => {
			switch (sortCol) {
				case 'do_id':
					return left.do_id_hex.localeCompare(right.do_id_hex);
				default:
					// UUIDv7s sort chronologically, so this doubles as creation order
					return left.t_id_hex.localeCompare(right.t_id_hex);
			}
		};
		const sorted = filtered.sort((left, right) => (sortDir === 'asc' ? compare(left, right) : compare(right, left)));

		const totalPages = Math.max(1, Math.ceil(sorted.length / PAGE_SIZE));
		const safePage = Math.min(page, totalPages);
		const offset = (safePage - 1) * PAGE_SIZE;

		return {
			tenants: sorted.slice(offset, offset + PAGE_SIZE),
			page: safePage,
			totalPages,
			totalItems: sorted.length,
			totalTenants: tenants.length,
			sortCol,
			sortDir,
			query,
			driftOnly,
			driftCount,
			orphanedDoIds,
			orphanedLogsDoIds,
			logsIdsResolved,
		};
	};
});

export const useDeleteTenants = routeAction$(
	async (data, { sharedMap, platform, fail }) => {
		const r_db = sharedMap.get('r_db') as DrizzleD1Database;

		let deleted = 0;
		for (const t_id_hex of data.tenantIds) {
			const [tenant] = await r_db
				.select({
					jurisdiction: rootSchema.tenants.jurisdiction,
					do_id: rootSchema.tenants.do_id,
				})
				.from(rootSchema.tenants)
				.where(eq(rootSchema.tenants.t_id, sql`unhex(${t_id_hex})`))
				.limit(1)
				.then((rows) =>
					rows.map((row) => ({
						...row,
						do_id: row.do_id.toString('hex'),
					})),
				);

			if (!tenant) return fail(404, serializeActionError(new Error(`Tenant ${hexToUuid(t_id_hex)} not found.`)));

			const purged = await purgeTenant({
				r_db,
				t_id_hex,
				jurisdiction: tenant.jurisdiction,
				do_id_hex: tenant.do_id,
				tenantNamespace: platform.env.TENANT_D0_PROD,
				logsNamespace: platform.env.TENANT_D0_LOGS_PROD,
			})
				.then(() => true)
				.catch((err: unknown) => fail(500, serializeActionError(err)));

			if (purged !== true) return purged;

			deleted++;
		}

		return { deleted };
	},
	zod$({ tenantIds: z.array(uuidAnyFormatSchema) }),
);

export const useNukeOrphanedDo = routeAction$(
	async (data, { platform, fail }) => {
		const reason = 'Orphaned tenant durable object deleted by admin';

		return (
			data.namespace === 'logs'
				? (() => {
						const namespace = platform.env.TENANT_D0_LOGS_PROD;
						return namespace.get(resolveDoIdFromString(namespace, data.doId)).nuke(reason);
					})()
				: (() => {
						const namespace = platform.env.TENANT_D0_PROD;
						return namespace.get(resolveDoIdFromString(namespace, data.doId)).nuke(reason);
					})()
		)
			.then(() => ({ nuked: true }))
			.catch((err: unknown) => fail(500, serializeActionError(err)));
	},
	zod$({
		namespace: z.enum(['main', 'logs']),
		doId: z
			.string()
			.trim()
			.toLowerCase()
			.length(64)
			.regex(/^[0-9a-f]+$/, 'Must be a durable object id in hex'),
	}),
);

export const head: DocumentHead = {
	title: 'Tenants — EaaS Admin',
};

export default component$(() => {
	const loc = useLocation();
	const nav = useNavigate();
	const pageData = useTenantsPage();
	const deleteTenantsAction = useDeleteTenants();
	const nukeOrphanedDoAction = useNukeOrphanedDo();

	const selectedIds = useStore<Record<string, boolean>>({});
	const actionError = useSignal('');

	const selectedCount = useComputed$(() => Object.values(selectedIds).filter(Boolean).length);

	/** Every filter lives in the query string so any view of this table can be bookmarked or shared as-is */
	const navigateWithParams = $((changes: Record<string, string | null>) => {
		const params = new URLSearchParams(loc.url.search);

		for (const [key, value] of Object.entries(changes)) {
			if (value === null) {
				// eslint-disable-next-line drizzle/enforce-delete-with-where -- `URLSearchParams`, not a drizzle query
				params.delete(key);
			} else {
				params.set(key, value);
			}
		}

		return nav(params.size > 0 ? `?${params.toString()}` : loc.url.pathname);
	});

	const handleDeleteTenants = $(async (tenantIds: string[]) => {
		if (tenantIds.length === 0) return;
		if (!window.confirm(`Are you sure you want to delete ${tenantIds.length} tenant(s)? This wipes their durable objects (including logs) and every root reference to them.`)) return;

		const result = await deleteTenantsAction.submit({ tenantIds });
		if (result.value.failed) {
			actionError.value = actionErrorMessage(result.value, 'Failed to delete tenant(s).');
			return;
		}

		for (const t_id_hex of tenantIds) {
			delete selectedIds[t_id_hex];
		}
	});

	const handleNukeOrphanedDo = $(async (namespace: 'main' | 'logs', doId: string) => {
		if (!window.confirm(`Are you sure you want to wipe orphaned ${namespace === 'logs' ? 'logs ' : ''}durable object ${doId}? No root row points at it, so its contents can't be recovered.`)) return;

		const result = await nukeOrphanedDoAction.submit({ namespace, doId });
		if (result.value.failed) actionError.value = actionErrorMessage(result.value, 'Failed to wipe durable object.');
	});

	const toggleSelectAll = $((tenantIds: string[]) => {
		const allSelected = tenantIds.every((id) => selectedIds[id]);
		for (const id of tenantIds) {
			selectedIds[id] = !allSelected;
		}
	});

	/** Build a sort URL — toggles direction if same column, otherwise defaults to desc */
	const sortUrl = (col: SortColumn, sortCol: SortColumn, sortDir: SortDir) => {
		const params = new URLSearchParams(loc.url.search);
		params.set('sort', col);
		const currentDir = sortCol === col ? sortDir : null;
		params.set('dir', currentDir === 'desc' ? 'asc' : 'desc');
		params.set('page', '1');
		return `?${params.toString()}`;
	};

	const SortIcon = (col: SortColumn, sortCol: SortColumn, sortDir: SortDir) => {
		if (sortCol !== col) return <LuArrowUpDown class="ml-1 inline h-3 w-3 opacity-40" />;
		return sortDir === 'asc' ? <LuArrowUp class="ml-1 inline h-3 w-3" /> : <LuArrowDown class="ml-1 inline h-3 w-3" />;
	};

	return (
		<section class="mx-auto max-w-7xl px-4 py-6">
			{/* Header */}
			<div class="mb-6 flex flex-col gap-4 sm:flex-row sm:items-center sm:justify-between">
				<h1 class="text-heading text-2xl font-bold dark:text-white">Tenants</h1>
			</div>

			{/* Error Banner */}
			{actionError.value && (
				<div class="mb-4 flex items-center justify-between rounded-lg border border-red-300 bg-red-50 p-4 text-sm text-red-800 dark:border-red-800 dark:bg-red-900/20 dark:text-red-400">
					<span>{actionError.value}</span>
					<button type="button" class="ml-4 text-red-800 hover:underline dark:text-red-400" onClick$={() => (actionError.value = '')}>
						Dismiss
					</button>
				</div>
			)}

			<Resource
				value={pageData}
				onPending={() => (
					<div class="px-4 py-8 text-center">
						<span class="text-body-subtle dark:text-gray-500">Loading tenants…</span>
					</div>
				)}
				onRejected={(error) => (
					<div class="rounded-lg border border-red-300 bg-red-50 p-4 text-sm text-red-800 dark:border-red-800 dark:bg-red-900/20 dark:text-red-400">
						Failed to load tenants: {error.name}: {error.message}
					</div>
				)}
				onResolved={(data) => (
					<>
						<TenantsToolbar
							query={data.query}
							driftOnly={data.driftOnly}
							driftCount={data.driftCount}
							selectedCount={selectedCount.value}
							onSearch$={$((query: string) => navigateWithParams({ q: query.trim() || null, page: '1' }))}
							onToggleDrift$={$(() => navigateWithParams({ drift: data.driftOnly ? null : '1', page: '1' }))}
							onDeleteSelected$={$(async () => {
								const ids = Object.entries(selectedIds)
									.filter(([, selected]) => selected)
									.map(([id]) => id);
								await handleDeleteTenants(ids);
							})}
						/>

						<div class="overflow-x-auto">
							<table class="text-body w-full text-left text-sm dark:text-gray-400">
								<thead class="bg-surface-light text-body-subtle text-xs uppercase dark:bg-gray-700 dark:text-gray-400">
									<tr>
										<th scope="col" class="px-4 py-3">
											<input type="checkbox" class="border-default-medium h-4 w-4 rounded bg-gray-100 text-blue-600 focus:ring-2 focus:ring-blue-500 dark:border-gray-600 dark:bg-gray-700 dark:ring-offset-gray-800" checked={data.tenants.length > 0 && data.tenants.every((tenant) => selectedIds[tenant.t_id_hex])} onChange$={() => toggleSelectAll(data.tenants.map((tenant) => tenant.t_id_hex))} />
										</th>
										<th scope="col" class="px-4 py-3">
											<a href={sortUrl('t_id', data.sortCol, data.sortDir)} class="inline-flex items-center hover:underline">
												Tenant ID
												{SortIcon('t_id', data.sortCol, data.sortDir)}
											</a>
										</th>
										<th scope="col" class="px-4 py-3">
											<a href={sortUrl('do_id', data.sortCol, data.sortDir)} class="inline-flex items-center hover:underline">
												Database ID
												{SortIcon('do_id', data.sortCol, data.sortDir)}
											</a>
										</th>
										<th scope="col" class="px-4 py-3">
											Name
										</th>
										<th scope="col" class="px-4 py-3 text-center">
											DO
										</th>
										<th scope="col" class="px-4 py-3 text-center">
											Logs DO
										</th>
										<th scope="col" class="px-4 py-3">
											Actions
										</th>
									</tr>
								</thead>
								<tbody>
									{data.tenants.map((tenant) => (
										<TenantRow
											key={tenant.t_id_hex}
											tidUuid={tenant.t_id_uuid}
											tidBase64Url={tenant.t_id_base64url}
											doIdHex={tenant.do_id_hex}
											logsDoIdHex={tenant.logs_do_id_hex}
											jurisdiction={tenant.jurisdiction}
											doExists={tenant.doExists}
											logsDoExists={tenant.logsDoExists}
											selected={!!selectedIds[tenant.t_id_hex]}
											onToggleSelect$={() => {
												selectedIds[tenant.t_id_hex] = !selectedIds[tenant.t_id_hex];
											}}
											onDelete$={() => handleDeleteTenants([tenant.t_id_hex])}
										/>
									))}
									{data.tenants.length === 0 && (
										<tr>
											<td colSpan={7} class="px-4 py-8 text-center">
												<span class="text-body-subtle dark:text-gray-500">{data.totalTenants === 0 ? 'No tenants found.' : 'No tenants match the current filters.'}</span>
											</td>
										</tr>
									)}
								</tbody>
							</table>
						</div>

						{/* Pagination */}
						<Pagination page={data.page} totalPages={data.totalPages} totalItems={data.totalItems} pageSize={PAGE_SIZE} />

						{/* Durable Objects with no root row to explain them */}
						{data.orphanedDoIds.length + data.orphanedLogsDoIds.length > 0 && (
							<div class="border-default-medium bg-surface-light dark:bg-surface-dark mt-8 border p-4">
								<h2 class="text-heading mb-1 flex items-center gap-2 text-lg font-semibold dark:text-white">
									<LuAlertTriangle class="h-4 w-4 text-amber-500" />
									Orphaned durable objects
								</h2>
								<p class="text-body-subtle mb-3 text-sm dark:text-gray-400">These durable objects hold data but no root lookup row points at them. A tenant id can't be recovered from a durable object id, so wiping is the only repair.</p>
								<ul class="flex flex-col gap-2">
									{[...data.orphanedDoIds.map((doId) => ({ namespace: 'main' as const, doId })), ...data.orphanedLogsDoIds.map((doId) => ({ namespace: 'logs' as const, doId }))].map(({ namespace, doId }) => (
										<li key={`${namespace}:${doId}`} class="flex flex-wrap items-center justify-between gap-2">
											<code class="text-body-subtle text-xs break-all dark:text-gray-400">
												{namespace === 'logs' ? 'logs: ' : ''}
												{doId}
											</code>
											<button type="button" class="inline-flex items-center gap-1.5 rounded-lg bg-red-600 px-3 py-1.5 text-xs font-medium text-white hover:bg-red-700" onClick$={() => handleNukeOrphanedDo(namespace, doId)}>
												<LuTrash2 class="h-3.5 w-3.5" />
												Wipe
											</button>
										</li>
									))}
								</ul>
							</div>
						)}

						{!data.logsIdsResolved && <p class="text-body-subtle mt-4 text-xs dark:text-gray-500">Some logs durable object ids couldn't be derived in this runtime (local `workerd` rejects jurisdictional `idFromName`), so orphaned logs objects aren't listed.</p>}
					</>
				)}
			/>
		</section>
	);
});
