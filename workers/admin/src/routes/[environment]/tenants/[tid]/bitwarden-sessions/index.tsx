import { component$, getLocale, Resource } from '@builder.io/qwik';
import { routeLoader$, type DocumentHead } from '@builder.io/qwik-city';
import { LuAlertTriangle, LuExternalLink } from '@qwikest/icons/lucide';
import { Cloudflare } from 'cloudflare';
import { StaticDatabase } from 'db/core';
import type { DOJurisdictions } from 'types';
import { lookupDoInstances, type TenantDoStub } from '~/routes/[environment]/tenants/tenant-ops';
import { useCfAccountId, useTimezone } from '~/routes/layout';

/**
 * The tenant's pool of reusable Bitwarden Secrets Manager sessions, cross-referenced against what actually exists.
 *
 * Three sources, because a row here is only ever a *claim* that a session exists: the tenant's own `bitwarden_sessions` table says what it believes it has, Cloudflare's Durable Object instances API says which of those objects still hold storage, and the session itself says how much work it's running right now. Where they disagree is the interesting part — see the warnings rendered per row.
 */
export const useTenantBitwardenSessions = routeLoader$(({ sharedMap, platform }) => {
	const t_do = sharedMap.get('t_do') as TenantDoStub;
	const jurisdiction = sharedMap.get('t_jurisdiction') as DOJurisdictions | null;

	return async () => {
		// Expired rows included on purpose: a session removes its own row when it nukes itself, so one that's still here past its expiry is exactly what this page exists to surface
		const rows = await t_do.listBitwardenSessions({ includeExpired: true });

		if (rows.length === 0) return [];

		const cf = new Cloudflare({ apiToken: platform.env.CF_API_TOKEN });
		/** `do_id` → whether that object still holds stored data. An id Cloudflare never listed simply isn't a key here, which reads the same as "wiped" below. */
		const stored: Record<string, boolean> = await lookupDoInstances(
			cf,
			platform.env.CF_ACCOUNT_ID,
			StaticDatabase.Tenant.BitwardenSessions['eaas-api-prod_BitwardenSession'],
			rows.map(({ do_id }) => do_id),
		).catch((error: unknown) => {
			console.error('Failed to look up bitwarden session durable objects', error);
			return {};
		});

		const namespace = platform.env.BITWARDEN_SESSION_PROD;
		const jurisdictionalNamespace = jurisdiction ? namespace.jurisdiction(jurisdiction) : namespace;
		const now = Date.now();

		return Promise.all(
			rows.map(async (row) => {
				const expired = row.expires.getTime() <= now;
				// `hasStoredData` is `undefined` for an id the API never listed, which `lookupDoInstances` reports the same way it reports a listed-but-empty object
				const hasStoredData = stored[row.do_id] ?? false;

				/**
				 * Only asked of a session that should still be alive. Reaching a session that has already nuked itself would spin up an empty Durable Object just to be told it's running nothing — pointless, and it muddies the "does this object still exist" question this page is trying to answer.
				 */
				const activeTasks =
					expired || !hasStoredData
						? null
						: await namespace
								.get(jurisdictionalNamespace.idFromString(row.do_id))
								.activeTasks()
								.catch((error: unknown) => {
									console.error('Failed to read bitwarden session task count', error);
									return null;
								});

				return {
					do_id: row.do_id,
					fingerprint: row.fingerprint,
					expires: row.expires,
					b_time: row.b_time,
					expired,
					hasStoredData,
					active: activeTasks?.active ?? null,
					max: activeTasks?.max ?? null,
				};
			}),
		).then((sessions) => sessions.sort((left, right) => right.expires.getTime() - left.expires.getTime()));
	};
});

export const head: DocumentHead = {
	title: 'Tenant Bitwarden Sessions — EaaS Admin',
};

export default component$(() => {
	const locale = getLocale();
	const timezone = useTimezone();
	const cfAccountId = useCfAccountId();
	const sessions = useTenantBitwardenSessions();

	const studioHref = (do_id: string) => `https://dash.cloudflare.com/${cfAccountId.value}/workers/durable-objects/view/${StaticDatabase.Tenant.BitwardenSessions['eaas-api-prod_BitwardenSession']}/studio?objectId=${do_id}`;

	const Timestamp = ({ value }: { value: Date }) => (
		<time dateTime={value.toISOString()} title={[value.toLocaleString(locale, { hour12: false, timeZone: 'UTC' }), 'UTC'].join(' ')}>
			{[value.toLocaleString(locale, { timeZone: timezone.value.long }), timezone.value.short].join(' ')}
		</time>
	);

	return (
		<Resource
			value={sessions}
			onPending={() => (
				<div class="px-4 py-8 text-center">
					<span class="text-body-subtle dark:text-gray-500">Loading bitwarden sessions…</span>
				</div>
			)}
			onRejected={(error) => (
				<div class="rounded-lg border border-red-300 bg-red-50 p-4 text-sm text-red-800 dark:border-red-800 dark:bg-red-900/20 dark:text-red-400">
					Failed to load bitwarden sessions: {error.name}: {error.message}
				</div>
			)}
			onResolved={(rows) => (
				<div class="space-y-4">
					<p class="text-body-subtle text-sm dark:text-gray-500">Reusable Bitwarden Secrets Manager sessions this tenant currently has open. Each is its own durable object, registered here when it authenticates and removed when it nukes itself at token expiry — so a row that outlives its expiry, or an expired object still holding storage, means one of those two steps didn&apos;t happen.</p>

					{rows.length === 0 ? (
						<p class="text-body-subtle text-sm dark:text-gray-500">This tenant has no pooled bitwarden sessions.</p>
					) : (
						<ul class="flex flex-col gap-3">
							{rows.map((row) => (
								<li key={row.do_id} class={['border p-4', row.expired ? 'border-amber-400 bg-amber-50 dark:border-amber-700 dark:bg-amber-900/20' : 'border-default-medium bg-surface-light dark:bg-surface-dark'].join(' ')}>
									<div class="flex flex-col gap-3 lg:flex-row lg:items-start lg:justify-between">
										<div class="min-w-0">
											<a target="_blank" rel="noopener noreferrer" href={studioHref(row.do_id)} class="text-primary-accent inline-flex items-center gap-1.5 font-mono text-sm break-all hover:underline">
												{row.do_id}
												<LuExternalLink class="h-3.5 w-3.5 shrink-0" />
											</a>
											<p class="text-body-subtle mt-1 font-mono text-xs break-all dark:text-gray-500">credentials {row.fingerprint.slice(0, 16)}…</p>
										</div>

										<div class="text-body flex shrink-0 flex-col gap-1 text-xs lg:items-end lg:text-right dark:text-gray-400">
											<p>
												<span class="text-body-subtle dark:text-gray-500">Opened: </span>
												<Timestamp value={row.b_time} />
											</p>
											<p>
												<span class="text-body-subtle dark:text-gray-500">Expires: </span>
												<Timestamp value={row.expires} />
												{row.expired && <span class="ml-1 font-medium text-amber-700 dark:text-amber-400">(expired)</span>}
											</p>
											<p>
												<span class="text-body-subtle dark:text-gray-500">Active actions: </span>
												{row.active === null ? <span class="text-body-subtle italic dark:text-gray-500">not asked</span> : <span class={row.max !== null && row.active >= row.max ? 'font-medium text-amber-700 dark:text-amber-400' : undefined}>{row.max === null ? row.active : `${row.active} / ${row.max}`}</span>}
											</p>
										</div>
									</div>

									{row.expired && (
										<p class="mt-3 inline-flex items-start gap-1.5 text-xs text-amber-700 dark:text-amber-400">
											<LuAlertTriangle class="mt-0.5 h-3.5 w-3.5 shrink-0" />
											Expired but still registered in the tenant database — its token is dead, so nothing can borrow it; the row should have gone when the session nuked itself.
										</p>
									)}
									{row.expired && row.hasStoredData && (
										<p class="mt-2 inline-flex items-start gap-1.5 text-xs text-red-600 dark:text-red-400">
											<LuAlertTriangle class="mt-0.5 h-3.5 w-3.5 shrink-0" />
											Expired but the durable object still holds stored data — its expiry alarm never wiped it, so it is still being billed for storage.
										</p>
									)}
									{!row.expired && !row.hasStoredData && <p class="text-body-subtle mt-3 text-xs dark:text-gray-500">No stored data for this object — it has already been wiped, so this row is stale and the next borrower will drop it.</p>}
								</li>
							))}
						</ul>
					)}
				</div>
			)}
		/>
	);
});
