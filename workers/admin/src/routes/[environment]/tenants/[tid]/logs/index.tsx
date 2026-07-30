import { $, component$, getLocale, Resource, useSignal } from '@builder.io/qwik';
import { Link, routeLoader$, useLocation, useNavigate, type DocumentHead } from '@builder.io/qwik-city';
import { LuArrowDown, LuArrowUp, LuX } from '@qwikest/icons/lucide';
import * as tenantLogsSchema from 'db/schemas/tenant/logs';
import { and, count, desc, eq, type SQL } from 'drizzle-orm/sql';
import { asc, sql } from 'drizzle-orm/sql';
import type { SqliteRemoteDatabase } from 'drizzle-orm/sqlite-proxy';
import { TenantLogEventStatus } from 'types/tenants/logging';
import { Pagination } from '~/components/pagination/pagination';
import { TENANT_LOG_EVENT_OPTIONS, TENANT_LOG_STATUS_OPTIONS, tenantLogEventLabel, tenantLogStatusLabel } from '~/routes/[environment]/tenants/db-helpers';
import { paramIdToHex } from '~/routes/[environment]/tenants/tenant-ops';
import { hexToUuid } from '~/routes/[environment]/users/db-helpers';
import { useTimezone } from '~/routes/layout';

const PAGE_SIZE = 100;

/** Only accepts a value the enum actually defines, so a hand-edited query string can't smuggle a bogus filter into the query */
const parseEnumParam = <TValue extends number>(value: string | null, allowed: [string, TValue][]): TValue | null => {
	if (value === null || value === '') return null;

	const parsed = parseInt(value, 10);
	return allowed.find(([, allowedValue]) => Number(allowedValue) === parsed)?.[1] ?? null;
};

/**
 * Every filter is read straight out of the query string, so a filtered view of the log (e.g. the "view logs for this key" link on the API keys tab) is a plain bookmarkable URL.
 */
export const useTenantLogs = routeLoader$(({ sharedMap, url }) => {
	const t_logs_db = sharedMap.get('t_logs_db') as SqliteRemoteDatabase;

	const page = Math.max(1, parseInt(url.searchParams.get('page') ?? '1', 10) || 1);
	const sortDir = url.searchParams.get('dir') === 'asc' ? 'asc' : 'desc';
	const akParam = url.searchParams.get('ak');
	const uParam = url.searchParams.get('u');
	const akHex = paramIdToHex(akParam);
	const uHex = paramIdToHex(uParam);
	const eventType = parseEnumParam(url.searchParams.get('event'), TENANT_LOG_EVENT_OPTIONS);
	const status = parseEnumParam(url.searchParams.get('status'), TENANT_LOG_STATUS_OPTIONS);
	const systemOnly = url.searchParams.get('system') === '1';

	return async () => {
		const conditions: SQL[] = [...(akHex ? [eq(tenantLogsSchema.logs.ak_id, sql`unhex(${akHex})`)] : []), ...(uHex ? [eq(tenantLogsSchema.logs.u_id, sql`unhex(${uHex})`)] : []), ...(eventType === null ? [] : [eq(tenantLogsSchema.logs.event_type, eventType)]), ...(status === null ? [] : [eq(tenantLogsSchema.logs.status, status)]), ...(systemOnly ? [eq(tenantLogsSchema.logs.system, true)] : [])];
		const where = conditions.length > 0 ? and(...conditions) : undefined;

		const [totals] = await t_logs_db.select({ total: count() }).from(tenantLogsSchema.logs).where(where);

		const totalItems = totals?.total ?? 0;
		const totalPages = Math.max(1, Math.ceil(totalItems / PAGE_SIZE));
		const safePage = Math.min(page, totalPages);

		const logs = await t_logs_db
			.select()
			.from(tenantLogsSchema.logs)
			.where(where)
			// The id is a UUIDv7 carrying the same millisecond as `timestamp`, so it breaks ties within a millisecond deterministically
			.orderBy(sortDir === 'asc' ? asc(tenantLogsSchema.logs.id) : desc(tenantLogsSchema.logs.id))
			.limit(PAGE_SIZE)
			.offset((safePage - 1) * PAGE_SIZE)
			.then((rows) =>
				rows.map((row) => ({
					id: hexToUuid(row.id.toString('hex')),
					timestamp: row.timestamp,
					event_type: row.event_type,
					// Serialized here so the (schema-wise untyped) JSON column crosses to the client as a plain string
					context: JSON.stringify(row.context, null, '\t'),
					ip: row.ip,
					user_agent: row.user_agent,
					ray_id: row.ray_id?.toString('hex') ?? null,
					u_id_hex: row.u_id?.toString('hex') ?? null,
					u_id_base64url: row.u_id?.toString('base64url') ?? null,
					ak_id_hex: row.ak_id?.toString('hex') ?? null,
					ak_id_base64url: row.ak_id?.toString('base64url') ?? null,
					kr_id_hex: row.kr_id?.toString('hex') ?? null,
					dk_id_hex: row.dk_id?.toString('hex') ?? null,
					system: row.system,
					status: row.status,
				})),
			);

		return {
			logs,
			page: safePage,
			totalPages,
			totalItems,
			sortDir,
			filters: {
				ak: akHex ? { hex: akHex, raw: akParam! } : null,
				u: uHex ? { hex: uHex, raw: uParam! } : null,
				event: eventType,
				status,
				systemOnly,
			},
		};
	};
});

export const head: DocumentHead = {
	title: 'Tenant Logs — EaaS Admin',
};

const selectClass = 'border-default-medium bg-deep-light text-body block rounded-lg border p-2 text-sm focus:border-blue-500 focus:ring-blue-500 dark:border-gray-600 dark:bg-gray-700 dark:text-white';

export default component$(() => {
	const loc = useLocation();
	const nav = useNavigate();
	const locale = getLocale();
	const timezone = useTimezone();
	const logsData = useTenantLogs();

	const expandedId = useSignal<string | null>(null);

	/** Filters only ever change through the URL, so back/forward and bookmarking keep working */
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

	return (
		<Resource
			value={logsData}
			onPending={() => (
				<div class="px-4 py-8 text-center">
					<span class="text-body-subtle dark:text-gray-500">Loading logs…</span>
				</div>
			)}
			onRejected={(error) => (
				<div class="rounded-lg border border-red-300 bg-red-50 p-4 text-sm text-red-800 dark:border-red-800 dark:bg-red-900/20 dark:text-red-400">
					Failed to load logs: {error.name}: {error.message}
				</div>
			)}
			onResolved={(data) => {
				const activeFilters = [...(data.filters.ak ? [{ key: 'ak', label: `api key: ${hexToUuid(data.filters.ak.hex)}` }] : []), ...(data.filters.u ? [{ key: 'u', label: `user: ${hexToUuid(data.filters.u.hex)}` }] : []), ...(data.filters.event === null ? [] : [{ key: 'event', label: `event: ${tenantLogEventLabel(data.filters.event)}` }]), ...(data.filters.status === null ? [] : [{ key: 'status', label: `status: ${tenantLogStatusLabel(data.filters.status)}` }]), ...(data.filters.systemOnly ? [{ key: 'system', label: 'system only' }] : [])];

				return (
					<div class="space-y-4">
						{/* Filters */}
						<div class="border-default-medium bg-surface-light dark:bg-surface-dark flex flex-col gap-3 border p-4">
							<div class="flex flex-wrap items-end gap-3">
								<label class="flex flex-col gap-1 text-sm">
									<span class="text-body-subtle dark:text-gray-400">Event</span>
									<select class={selectClass} value={data.filters.event === null ? '' : String(data.filters.event)} onChange$={(_, element) => navigateWithParams({ event: element.value || null, page: '1' })}>
										<option value="">All</option>
										{TENANT_LOG_EVENT_OPTIONS.map(([label, value]) => (
											<option key={value} value={String(value)} selected={data.filters.event === value}>
												{label}
											</option>
										))}
									</select>
								</label>

								<label class="flex flex-col gap-1 text-sm">
									<span class="text-body-subtle dark:text-gray-400">Status</span>
									<select class={selectClass} value={data.filters.status === null ? '' : String(data.filters.status)} onChange$={(_, element) => navigateWithParams({ status: element.value || null, page: '1' })}>
										<option value="">All</option>
										{TENANT_LOG_STATUS_OPTIONS.map(([label, value]) => (
											<option key={value} value={String(value)} selected={data.filters.status === value}>
												{label}
											</option>
										))}
									</select>
								</label>

								<label class="flex flex-col gap-1 text-sm">
									<span class="text-body-subtle dark:text-gray-400">API key ID</span>
									<input type="text" placeholder="any id form" class={`${selectClass} font-mono`} value={data.filters.ak?.raw ?? ''} onChange$={(_, element) => navigateWithParams({ ak: element.value.trim() || null, page: '1' })} />
								</label>

								<label class="flex flex-col gap-1 text-sm">
									<span class="text-body-subtle dark:text-gray-400">User ID</span>
									<input type="text" placeholder="any id form" class={`${selectClass} font-mono`} value={data.filters.u?.raw ?? ''} onChange$={(_, element) => navigateWithParams({ u: element.value.trim() || null, page: '1' })} />
								</label>

								<label class="flex items-center gap-2 text-sm">
									<input type="checkbox" class="border-default-medium h-4 w-4 rounded bg-gray-100 text-blue-600 focus:ring-2 focus:ring-blue-500 dark:border-gray-600 dark:bg-gray-700" checked={data.filters.systemOnly} onChange$={(_, element) => navigateWithParams({ system: element.checked ? '1' : null, page: '1' })} />
									System only
								</label>

								<button type="button" class="border-default-medium text-body inline-flex items-center gap-1.5 rounded-lg border px-3 py-2 text-sm hover:bg-gray-100 dark:border-gray-600 dark:text-gray-300 dark:hover:bg-gray-700" onClick$={() => navigateWithParams({ dir: data.sortDir === 'asc' ? null : 'asc', page: '1' })}>
									{data.sortDir === 'asc' ? <LuArrowUp class="h-4 w-4" /> : <LuArrowDown class="h-4 w-4" />}
									{data.sortDir === 'asc' ? 'Oldest first' : 'Newest first'}
								</button>
							</div>

							{activeFilters.length > 0 && (
								<div class="flex flex-wrap items-center gap-2">
									{activeFilters.map((filter) => (
										<button key={filter.key} type="button" class="inline-flex items-center gap-1.5 rounded-full bg-blue-100 px-2.5 py-0.5 text-xs font-medium text-blue-800 hover:bg-blue-200 dark:bg-blue-900/30 dark:text-blue-400" onClick$={() => navigateWithParams({ [filter.key]: null, page: '1' })}>
											{filter.label}
											<LuX class="h-3 w-3" />
										</button>
									))}
									<button type="button" class="text-body-subtle text-xs hover:underline dark:text-gray-400" onClick$={() => navigateWithParams({ ak: null, u: null, event: null, status: null, system: null, page: '1' })}>
										Clear all
									</button>
								</div>
							)}
						</div>

						{/* Logs */}
						<div class="overflow-x-auto">
							<table class="text-body w-full text-left text-sm dark:text-gray-400">
								<thead class="bg-surface-light text-body-subtle text-xs uppercase dark:bg-gray-700 dark:text-gray-400">
									<tr>
										<th scope="col" class="px-4 py-3">
											When
										</th>
										<th scope="col" class="px-4 py-3">
											Event
										</th>
										<th scope="col" class="px-4 py-3">
											Status
										</th>
										<th scope="col" class="px-4 py-3">
											Actor
										</th>
										<th scope="col" class="px-4 py-3">
											Origin
										</th>
										<th scope="col" class="px-4 py-3">
											Context
										</th>
									</tr>
								</thead>
								<tbody>
									{data.logs.map((log) => (
										<tr key={log.id} class="border-default-medium hover:bg-surface-light border-b dark:border-gray-700 dark:hover:bg-gray-600">
											<td class="px-4 py-3 text-xs">
												<time dateTime={log.timestamp.toISOString()} title={[log.timestamp.toLocaleString(locale, { hour12: false, timeZone: 'UTC' }), 'UTC'].join(' ')}>
													{[log.timestamp.toLocaleString(locale, { timeZone: timezone.value.long }), timezone.value.short].join(' ')}
												</time>
												<div class="text-body-subtle mt-0.5 dark:text-gray-500">
													<code class="break-all">{log.id}</code>
												</div>
											</td>
											<td class="px-4 py-3">
												<button type="button" class="text-primary-accent text-sm hover:underline" onClick$={() => navigateWithParams({ event: String(log.event_type), page: '1' })}>
													{tenantLogEventLabel(log.event_type)}
												</button>
											</td>
											<td class="px-4 py-3">
												<span class={['inline-flex items-center rounded-full px-2 py-0.5 text-xs font-medium', log.status === TenantLogEventStatus.success ? 'bg-green-100 text-green-800 dark:bg-green-900/30 dark:text-green-400' : log.status === TenantLogEventStatus.denied ? 'bg-amber-100 text-amber-800 dark:bg-amber-900/30 dark:text-amber-400' : 'bg-red-100 text-red-800 dark:bg-red-900/30 dark:text-red-400'].join(' ')}>{tenantLogStatusLabel(log.status)}</span>
											</td>
											<td class="px-4 py-3 text-xs">
												{log.u_id_base64url && (
													<div>
														<Link prefetch="js" href={`/${loc.params['environment']}/users/${log.u_id_base64url}/`} class="text-primary-accent hover:underline">
															<code class="break-all">user {hexToUuid(log.u_id_hex!)}</code>
														</Link>
													</div>
												)}
												{log.ak_id_base64url && (
													<div>
														<button type="button" class="text-primary-accent hover:underline" onClick$={() => navigateWithParams({ ak: log.ak_id_base64url, page: '1' })}>
															<code class="break-all">key {hexToUuid(log.ak_id_hex!)}</code>
														</button>
													</div>
												)}
												{log.system && <span class="inline-flex items-center rounded-full bg-purple-100 px-2 py-0.5 text-xs font-medium text-purple-800 dark:bg-purple-900/30 dark:text-purple-400">system</span>}
											</td>
											<td class="px-4 py-3 text-xs">
												{log.ip && <div class="break-all">{log.ip}</div>}
												{log.ray_id && (
													<div class="text-body-subtle dark:text-gray-500">
														<code class="break-all">ray {log.ray_id}</code>
													</div>
												)}
												{log.user_agent && (
													<div class="text-body-subtle max-w-64 truncate dark:text-gray-500" title={log.user_agent}>
														{log.user_agent}
													</div>
												)}
											</td>
											<td class="px-4 py-3 text-xs">
												{log.kr_id_hex && (
													<div class="text-body-subtle dark:text-gray-500">
														<code class="break-all">keyring {hexToUuid(log.kr_id_hex)}</code>
													</div>
												)}
												{log.dk_id_hex && (
													<div class="text-body-subtle dark:text-gray-500">
														<code class="break-all">datakey {hexToUuid(log.dk_id_hex)}</code>
													</div>
												)}
												<button type="button" class="text-primary-accent hover:underline" onClick$={() => (expandedId.value = expandedId.value === log.id ? null : log.id)}>
													{expandedId.value === log.id ? 'Hide' : 'Show'} context
												</button>
												{expandedId.value === log.id && <pre class="bg-deep-light mt-1 max-w-md overflow-x-auto p-2 text-xs dark:bg-gray-800">{log.context}</pre>}
											</td>
										</tr>
									))}
									{data.logs.length === 0 && (
										<tr>
											<td colSpan={6} class="px-4 py-8 text-center">
												<span class="text-body-subtle dark:text-gray-500">{activeFilters.length > 0 ? 'No logs match the current filters.' : 'This tenant has no logs.'}</span>
											</td>
										</tr>
									)}
								</tbody>
							</table>
						</div>

						<Pagination page={data.page} totalPages={data.totalPages} totalItems={data.totalItems} pageSize={PAGE_SIZE} />
					</div>
				);
			}}
		/>
	);
});
