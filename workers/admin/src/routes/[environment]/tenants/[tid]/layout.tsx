import { $, component$, Resource, Slot, useSignal } from '@builder.io/qwik';
import { routeAction$, routeLoader$, useLocation, useNavigate, type RequestHandler } from '@builder.io/qwik-city';
import { LuAlertTriangle, LuCheck, LuTrash2, LuX } from '@qwikest/icons/lucide';
import { Cloudflare } from 'cloudflare';
import { SQLCache } from 'db/cache';
import { DebugLogWriter, drizzleD0, StaticDatabase } from 'db/core';
import * as rootSchema from 'db/schemas/root';
import type { DrizzleD1Database } from 'drizzle-orm/d1';
import { DefaultLogger } from 'drizzle-orm/logger';
import { eq, sql } from 'drizzle-orm/sql';
import type { DOJurisdictions } from 'types';
import { TenantTabs } from '~/components/tenant-tabs/tenant-tabs';
import { actionErrorMessage } from '~/routes/[environment]/tenants/db-helpers';
import { bitwardenProjectIdsFromEnv, lookupDoInstances, purgeTenant, resolveTenantDoId, resolveTenantLogsDoId, serializeActionError, tenantHasDatakeys, tenantIdParamSchema, type TenantDoStub } from '~/routes/[environment]/tenants/tenant-ops';
import { hexToUuid } from '~/routes/[environment]/users/db-helpers';
import { useCfAccountId } from '~/routes/layout';

/**
 * Resolves everything the tabs below need: the root lookup row, the tenant's Durable Object, and the separate Durable Object holding its logs. A tenant with no root row still resolves (its DO id is derivable from `t_id`) so drift stays inspectable instead of 404ing.
 */
export const onRequest: RequestHandler = async ({ params, sharedMap, platform, next, redirect }) => {
	const { success } = await tenantIdParamSchema.safeParseAsync(params['tid']);

	if (success) {
		const t_id_hex = await import('node:buffer').then(({ Buffer }) => Buffer.from(params['tid']!, 'base64url').toString('hex'));
		const r_db = sharedMap.get('r_db') as DrizzleD1Database;

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

		const jurisdiction = tenant?.jurisdiction ?? null;
		sharedMap.set('t_id_hex', t_id_hex);
		sharedMap.set('t_jurisdiction', jurisdiction);
		sharedMap.set('t_root_exists', Boolean(tenant));

		const doNamespace = platform.env.TENANT_D0_PROD;
		const doId = resolveTenantDoId(doNamespace, jurisdiction, t_id_hex, tenant?.do_id);
		const doStub = doNamespace.get(doId);
		sharedMap.set('t_do', doStub);
		sharedMap.set('t_do_id_hex', doId.toString());

		const logsNamespace = platform.env.TENANT_D0_LOGS_PROD;
		const logsDoId = resolveTenantLogsDoId(logsNamespace, jurisdiction, t_id_hex);
		const logsDoStub = logsNamespace.get(logsDoId);
		sharedMap.set('t_logs_do', logsDoStub);
		sharedMap.set('t_logs_do_id_hex', logsDoId.toString());

		const browserCache = sharedMap.get('browserCache') as boolean;
		const cacheConfig = (dbName: string) => ({
			...(platform.env.NODE_ENV !== 'production' && { logger: new DefaultLogger({ writer: new DebugLogWriter(dbName) }) }),
			cache: new SQLCache(
				{
					dbName,
					dbType: 'do' as const,
					strategy: browserCache ? ('all' as const) : ('explicit' as const),
					cacheTTL: parseInt(platform.env.SQL_TTL, 10),
					// eslint-disable-next-line @typescript-eslint/no-unnecessary-condition
					logging: platform.env.NODE_ENV !== 'production',
				},
				// eslint-disable-next-line @typescript-eslint/no-unnecessary-condition
				globalThis.caches ?? platform.caches,
			),
		});

		sharedMap.set('t_db', drizzleD0(doStub, cacheConfig(doId.toString())));
		sharedMap.set('t_logs_db', drizzleD0(logsDoStub, cacheConfig(logsDoId.toString())));

		await next();
	} else {
		throw redirect(302, `/${params['environment']}/tenants/`);
	}
};

export const useTenantIds = routeLoader$(({ params }) =>
	import('node:buffer')
		.then(({ Buffer }) => Buffer.from(params['tid']!, 'base64url'))
		.then((buf) => ({
			utf8: hexToUuid(buf.toString('hex')),
			hex: buf.toString('hex'),
			base64: buf.toString('base64'),
			base64url: buf.toString('base64url'),
		})),
);

/** Tenant avatars are attacker-supplied URLs, so they render through the image proxy snippet instead of letting the browser hit the upstream host (which also keeps `img-src 'self'` enough in the CSP) */
const proxiedImage = (origin: string, imageUrl: string) => {
	const proxyUrl = new URL('/image/proxy', origin);
	proxyUrl.searchParams.set('url', imageUrl);
	return proxyUrl.href;
};

/** Root lookup row vs. live Durable Objects — the header states both, so drift is visible from every tab */
export const useTenantOverview = routeLoader$(({ sharedMap, platform, url }) => {
	const t_do = sharedMap.get('t_do') as TenantDoStub;
	const t_do_id_hex = sharedMap.get('t_do_id_hex') as string;
	const t_logs_do_id_hex = sharedMap.get('t_logs_do_id_hex') as string;
	const jurisdiction = sharedMap.get('t_jurisdiction') as DOJurisdictions | null;
	const rootExists = sharedMap.get('t_root_exists') as boolean;

	return async () => {
		const cf = new Cloudflare({ apiToken: platform.env.CF_API_TOKEN });

		const [properties, doInstances, logsDoInstances] = await Promise.all([t_do.getProperties({ name: true, avatar: true, byo_bw: true }, true).catch(() => ({}) as Record<string, never>), lookupDoInstances(cf, platform.env.CF_ACCOUNT_ID, StaticDatabase.Tenant.Main['eaas-api-prod_TenantD0'], [t_do_id_hex]), lookupDoInstances(cf, platform.env.CF_ACCOUNT_ID, StaticDatabase.Tenant.Logs['eaas-api-prod_TenantD0Logs'], [t_logs_do_id_hex])]);

		const avatar = 'avatar' in properties && typeof properties.avatar === 'string' ? properties.avatar : null;

		return {
			name: 'name' in properties && typeof properties.name === 'string' ? properties.name : null,
			avatar: avatar ? proxiedImage(url.origin, avatar) : null,
			jurisdiction,
			rootExists,
			t_do_id_hex,
			t_logs_do_id_hex,
			doExists: doInstances[t_do_id_hex] ?? false,
			logsDoExists: logsDoInstances[t_logs_do_id_hex] ?? false,
			isByo: 'byo_bw' in properties && typeof properties.byo_bw === 'string' && properties.byo_bw.length > 0,
		};
	};
});

/** Whether the tenant's own database has any datakeys — the extra "are you sure" delete warning hinges on this */
export const useTenantHasDatakeys = routeLoader$(({ sharedMap }) => {
	const t_do = sharedMap.get('t_do') as TenantDoStub;
	return tenantHasDatakeys(t_do).catch(() => false);
});

export const useDeleteTenant = routeAction$(async (_data, { sharedMap, platform, fail }) => {
	const r_db = sharedMap.get('r_db') as DrizzleD1Database;
	const t_id_hex = sharedMap.get('t_id_hex') as string;
	const jurisdiction = sharedMap.get('t_jurisdiction') as DOJurisdictions | null;
	const t_do_id_hex = sharedMap.get('t_do_id_hex') as string;
	const isProd = sharedMap.get('isProd') as boolean;

	return purgeTenant({
		r_db,
		t_id_hex,
		jurisdiction,
		do_id_hex: t_do_id_hex,
		tenantNamespace: platform.env.TENANT_D0_PROD,
		logsNamespace: platform.env.TENANT_D0_LOGS_PROD,
		bitwardenNamespace: platform.env.BITWARDEN_SESSION_PROD,
		bitwardenAccessTokens: { us: platform.env.US_BW_SM_ACCESS_TOKEN, eu: platform.env.EU_BW_SM_ACCESS_TOKEN },
		bitwardenProjectIds: bitwardenProjectIdsFromEnv(platform.env),
		isProd,
	})
		.then(() => ({ deleted: true }))
		.catch((err: unknown) => fail(500, serializeActionError(err)));
});

export default component$(() => {
	const loc = useLocation();
	const nav = useNavigate();
	const ids = useTenantIds();
	const overview = useTenantOverview();
	const hasDatakeys = useTenantHasDatakeys();
	const deleteTenantAction = useDeleteTenant();
	const cfAccountId = useCfAccountId();

	const actionError = useSignal('');

	const handleDelete = $(async () => {
		if (!window.confirm('Are you sure you want to delete this tenant? This wipes its durable object, its logs durable object, and every root reference to it.')) return;
		if (hasDatakeys.value && !window.confirm('This tenant has datakeys. Deleting it destroys those datakeys permanently — they cannot be recovered. Continue?')) return;

		const result = await deleteTenantAction.submit({});
		if (result.value.failed) {
			actionError.value = actionErrorMessage(result.value, 'Failed to delete tenant.');
			return;
		}

		await nav(`/${loc.params['environment']}/tenants/`);
	});

	return (
		<section class="px-4 py-6">
			{/* Header */}
			<div class="mb-4 flex flex-col gap-4 sm:flex-row sm:items-start sm:justify-between">
				<div>
					<Resource
						value={overview}
						onPending={() => <h1 class="text-heading text-2xl font-bold dark:text-white">Tenant</h1>}
						onResolved={(data) => (
							<div class="flex items-center gap-3">
								{data.avatar ? <img src={data.avatar} alt="Tenant avatar" width={40} height={40} class="rounded-full" /> : null}
								<h1 class="text-heading text-2xl font-bold dark:text-white">{data.name ?? 'Tenant'}</h1>
								{data.jurisdiction ? <span class="inline-flex items-center rounded-full bg-blue-100 px-2 py-0.5 text-xs font-medium text-blue-800 dark:bg-blue-900/30 dark:text-blue-400">{data.jurisdiction}</span> : null}
								{data.isByo ? <span class="inline-flex items-center rounded-full bg-purple-100 px-2 py-0.5 text-xs font-medium text-purple-800 dark:bg-purple-900/30 dark:text-purple-400">BYO vault</span> : <span class="bg-surface-light inline-flex items-center rounded-full px-2 py-0.5 text-xs font-medium text-gray-800 dark:bg-gray-700 dark:text-gray-300">Autosec managed</span>}
							</div>
						)}
					/>
					<p class="text-body-subtle mt-1 font-mono text-xs break-all dark:text-gray-400">{ids.value.utf8}</p>
					<p class="text-body-subtle font-mono text-xs break-all dark:text-gray-500">{ids.value.base64url}</p>
				</div>

				<div class="flex flex-col items-start gap-2 sm:items-end">
					<button type="button" class="inline-flex items-center gap-1.5 rounded-lg bg-red-600 px-4 py-2 text-sm font-medium text-white hover:bg-red-700 disabled:opacity-50" disabled={deleteTenantAction.isRunning} onClick$={handleDelete}>
						<LuTrash2 class="h-4 w-4" />
						Delete tenant
					</button>
					<Resource
						value={overview}
						onPending={() => <span class="text-body-subtle text-xs dark:text-gray-500">Checking durable objects…</span>}
						onResolved={(data) => (
							<div class="text-body flex flex-col items-start gap-1 text-xs sm:items-end dark:text-gray-300">
								<span class="inline-flex items-center gap-1.5">
									{data.rootExists ? <LuCheck class="h-3.5 w-3.5 text-green-500" /> : <LuX class="h-3.5 w-3.5 text-red-500" />}
									Root lookup row
								</span>
								<a target="_blank" rel="noopener noreferrer" href={`https://dash.cloudflare.com/${cfAccountId.value}/workers/durable-objects/view/${StaticDatabase.Tenant.Main['eaas-api-prod_TenantD0']}/studio?objectId=${data.t_do_id_hex}`} class="text-primary-accent inline-flex items-center gap-1.5 hover:underline">
									{data.doExists ? <LuCheck class="h-3.5 w-3.5 text-green-500" /> : <LuX class="h-3.5 w-3.5 text-red-500" />}
									Durable object
								</a>
								<a target="_blank" rel="noopener noreferrer" href={`https://dash.cloudflare.com/${cfAccountId.value}/workers/durable-objects/view/${StaticDatabase.Tenant.Logs['eaas-api-prod_TenantD0Logs']}/studio?objectId=${data.t_logs_do_id_hex}`} class="text-primary-accent inline-flex items-center gap-1.5 hover:underline">
									{data.logsDoExists ? <LuCheck class="h-3.5 w-3.5 text-green-500" /> : <LuX class="h-3.5 w-3.5 text-amber-500" />}
									Logs durable object
								</a>
								{!data.rootExists && (
									<span class="inline-flex items-center gap-1.5 text-amber-600 dark:text-amber-400">
										<LuAlertTriangle class="h-3.5 w-3.5" />
										No root row — ids below are derived
									</span>
								)}
							</div>
						)}
					/>
				</div>
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

			<TenantTabs />

			<div class="mt-6">
				<Slot />
			</div>
		</section>
	);
});
