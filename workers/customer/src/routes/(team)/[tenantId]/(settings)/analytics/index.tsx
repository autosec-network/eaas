import type { Session } from '@auth/qwik';
import { $, component$, useSignal, useVisibleTask$ } from '@builder.io/qwik';
import { routeAction$, routeLoader$, z, zod$ } from '@builder.io/qwik-city';
import { drizzleD0 } from 'db/core';
import * as rootSchema from 'db/schemas/root';
import * as tenantLogsSchema from 'db/schemas/tenant/logs';
import * as tenantSchema from 'db/schemas/tenant/main';
import type { DrizzleD1Database } from 'drizzle-orm/d1';
import { and, desc, eq, inArray, sql } from 'drizzle-orm/sql';
import type { SqliteRemoteDatabase } from 'drizzle-orm/sqlite-proxy';
import { hexToUuid } from 'helpers';
import type { AnalyticsSize } from 'types';
import { Permissions } from 'types';
import { TenantLogEventStatus, TenantLogEventType, TenantLogQueueMessageSchema } from 'types/tenants/logging';
import { v7 as uuidv7 } from 'uuid';
import type * as zm from 'zod/mini';
import { resolveDoStub, type DOLocator } from '~/helpers/do-proxy';
import { usePermissions } from '~/routes/(team)/[tenantId]/layout';
import type { EnvVars } from '~/types';

// eslint-disable-next-line @typescript-eslint/ban-ts-comment
// @ts-ignore this gets generated automatically later in the build process
import * as m from '~/paraglide/messages';

/**
 * The shape encrypt/decrypt audit rows carry in their `context` - just enough to render an example of the anonymized analytics row they also produce, never any plaintext, ciphertext, or key material.
 */
interface CryptoOperationContext {
	count?: number;
	size?: keyof typeof AnalyticsSize;
	/**
	 * One entry per payload the request covered. `bitStrength` is `null` for an algorithm that has no choice of key size, written explicitly rather than omitted so every row reads the same. Each entry also carries a `digest` of the plaintext, which is deliberately **not** surfaced in this preview - the analytics row that leaves the tenant never contains it.
	 */
	operations?: { algorithm?: string; bitStrength?: string | null; cipher?: string; size?: keyof typeof AnalyticsSize }[];
}

/**
 * Which tenant-log event types also produce a (fully anonymized, tenant-less) `EAAS_PLATFORM_ANALYTICS` row, and how to render an example of that row from the log's own `context`.
 *
 * The encrypt/decrypt endpoints (`workers/api/src/v0/encrypt.ts`, `decrypt.ts`) write one platform-analytics point per operation - `{ operation, algorithm, size, count }`, with no tenant identifier - whenever this toggle is on. The builders below reconstruct a representative point from an audit row's own `context` so the preview shows exactly the shape that leaves the tenant. Add an entry here for any future event type that starts feeding `EAAS_PLATFORM_ANALYTICS`, so this preview stays honest about what the toggle controls.
 */
const ANALYTICS_PREVIEW_BUILDERS: Partial<Record<TenantLogEventType, (context: Record<string, unknown>) => Record<string, unknown>>> = {
	[TenantLogEventType['encrypted data']]: (context) => cryptoAnalyticsPreview('encrypt', context),
	[TenantLogEventType['decrypted data']]: (context) => cryptoAnalyticsPreview('decrypt', context),
};

function cryptoAnalyticsPreview(operation: 'encrypt' | 'decrypt', context: CryptoOperationContext): Record<string, unknown> {
	const first = context.operations?.[0];
	return {
		operation,
		algorithm: first?.cipher ?? '',
		size: first?.size ?? context.size ?? null,
		count: context.count ?? 1,
	};
}

/**
 * Jurisdiction alone - the one thing needed to address a tenant's logs Durable Object that the page layout doesn't already put on `sharedMap`.
 */
const readTenantJurisdiction = (r_db: DrizzleD1Database, t_id_hex: string) =>
	r_db
		.select({ jurisdiction: rootSchema.tenants.jurisdiction })
		.from(rootSchema.tenants)
		.where(eq(rootSchema.tenants.t_id, sql`unhex(${t_id_hex})`))
		.limit(1)
		.then((rows) => rows[0]?.jurisdiction ?? null);

// eslint-disable-next-line qwik/loader-location
const useAnalyticsSettings = routeLoader$(async ({ sharedMap, platform, resolveValue }) => {
	const perms = await resolveValue(usePermissions);
	if (!perms || perms.r_tenant < Permissions.Read) return null;

	const t_do = sharedMap.get('t_do') as ReturnType<EnvVars['TENANT_D0']['get']>;
	const t_id_hex = sharedMap.get('t_id_hex') as string;
	const r_db = sharedMap.get('r_db') as DrizzleD1Database;

	const [{ platform_analytics }, jurisdiction] = await Promise.all([t_do.getProperties({ platform_analytics: true }), readTenantJurisdiction(r_db, t_id_hex)]);

	// No event type is mapped yet, so there's nothing worth opening the logs DO for - see the map's own doc comment
	const mappedEventTypes = Object.keys(ANALYTICS_PREVIEW_BUILDERS).map(Number) as TenantLogEventType[];

	// The preview is built from raw audit-log context, so it's gated on `r_logs` (viewing logs) same as it would be anywhere else - `r_tenant` alone (checked above, for the toggle itself) isn't the right permission to read log contents with
	let preview: Record<string, unknown> | null = null;
	if (mappedEventTypes.length > 0 && perms.r_logs >= Permissions.Read) {
		const locator: DOLocator = { name: `${hexToUuid(t_id_hex)}_logs`, jurisdiction: jurisdiction ?? undefined };
		const logsStub = resolveDoStub(platform, platform.env.TENANT_D0_LOGS, platform.env.TENANT_D0_LOGS_PROXY, locator);
		const logs_db = drizzleD0(logsStub);

		const [recent] = await logs_db.select({ event_type: tenantLogsSchema.logs.event_type, context: tenantLogsSchema.logs.context }).from(tenantLogsSchema.logs).where(inArray(tenantLogsSchema.logs.event_type, mappedEventTypes)).orderBy(desc(tenantLogsSchema.logs.id)).limit(1);

		if (recent) preview = ANALYTICS_PREVIEW_BUILDERS[recent.event_type]!(recent.context as Record<string, unknown>);
	}

	return {
		enabled: platform_analytics ?? true,
		preview,
		canEdit: perms.r_tenant >= Permissions.Write,
	};
});

// eslint-disable-next-line qwik/loader-location
const useUpdateAnalyticsSetting = routeAction$(
	async (data, { sharedMap, platform, fail, request }) => {
		const session = sharedMap.get('session') as Session;
		const t_db = sharedMap.get('t_db') as SqliteRemoteDatabase;

		const [you] = await t_db
			.select({ r_tenant: tenantSchema.users.r_tenant })
			.from(tenantSchema.users)
			.where(and(eq(tenantSchema.users.u_id, sql`unhex(${session.user!.u_id.hex})`), eq(tenantSchema.users.approved, true)))
			.limit(1);

		if (!you || you.r_tenant < Permissions.Write) {
			return fail(403, { message: 'Insufficient permissions' });
		}

		const t_do = sharedMap.get('t_do') as ReturnType<EnvVars['TENANT_D0']['get']>;
		const t_id_hex = sharedMap.get('t_id_hex') as string;
		const r_db = sharedMap.get('r_db') as DrizzleD1Database;
		const now = new Date();

		const [jurisdiction] = await Promise.all([readTenantJurisdiction(r_db, t_id_hex), t_do.updateProperties({ platform_analytics: data.enabled, m_time: now }, false, true)]);

		const headers = (platform.request ?? request).headers;
		const log: zm.input<typeof TenantLogQueueMessageSchema> = {
			t_id: t_id_hex,
			jurisdiction,
			id: uuidv7({ msecs: now.getTime() }).replaceAll('-', ''),
			timestamp: now.toISOString(),
			event_type: TenantLogEventType['changed platform analytics setting'],
			context: { enabled: data.enabled },
			ip: headers.get('CF-Connecting-IP'),
			user_agent: headers.get('User-Agent'),
			// `Cf-Ray` is `<hex id>-<colo>`, and only the id half is hex, so that's all the blob column can hold
			ray_id: headers.get('CF-Ray')?.split('-')[0],
			u_id: session.user!.u_id.hex,
			status: TenantLogEventStatus.success,
		};
		// Post the raw version, not the parsed one, so the consumer validates it independently
		await TenantLogQueueMessageSchema.parseAsync(log);
		platform.ctx.waitUntil(platform.env.LOGS.sendBatch([{ body: log, contentType: 'json' }]));

		return { success: true, enabled: data.enabled };
	},
	zod$({ enabled: z.boolean() }),
);

const cardClass = 'border-surface-light/60 dark:border-surface-dark/60 dark:bg-surface-dark/70 rounded-2xl border bg-white/70 p-6 shadow-sm backdrop-blur-md';

export default component$(() => {
	const settings = useAnalyticsSettings();
	const update = useUpdateAnalyticsSetting();

	const enabled = useSignal(settings.value?.enabled ?? true);
	const saving = useSignal(false);

	// eslint-disable-next-line qwik/no-use-visible-task
	useVisibleTask$(({ track }) => {
		const value = track(() => settings.value?.enabled);
		if (value !== undefined) enabled.value = value;
	});

	if (!settings.value) {
		return (
			<div class="mx-auto w-full max-w-3xl px-6 py-10">
				<p class="text-sm text-gray-500 dark:text-gray-400">{m.common_error_label()}</p>
			</div>
		);
	}

	const { preview, canEdit } = settings.value;

	return (
		<div class="mx-auto w-full max-w-3xl px-6 py-10">
			<div class="mb-8">
				<h1 class="text-2xl font-bold tracking-tight text-gray-900 dark:text-white">{m.analytics_page_title()}</h1>
				<p class="mt-1 text-sm text-gray-500 dark:text-gray-400">{m.analytics_page_subtitle()}</p>
			</div>

			<section class={cardClass}>
				<div class="flex items-start justify-between gap-4">
					<div>
						<h2 class="text-sm font-semibold text-gray-900 dark:text-white">{m.analytics_toggle_label()}</h2>
						<p class="mt-1 text-sm text-gray-500 dark:text-gray-400">{m.analytics_toggle_description()}</p>
					</div>

					<button
						type="button"
						role="switch"
						aria-checked={enabled.value}
						disabled={!canEdit || saving.value}
						onClick$={$(async () => {
							const prev = enabled.value;
							const next = !prev;
							enabled.value = next;
							saving.value = true;

							await update
								.submit({ enabled: next })
								.catch(() => {
									enabled.value = prev;
								})
								.finally(() => {
									saving.value = false;
								});
						})}
						class={['relative inline-flex h-6 w-11 shrink-0 items-center rounded-full transition-colors', enabled.value ? 'bg-primary-accent' : 'bg-gray-300 dark:bg-gray-700', (!canEdit || saving.value) && 'cursor-not-allowed opacity-50']}>
						<span class={['inline-block h-4 w-4 transform rounded-full bg-white transition-transform', enabled.value ? 'translate-x-6' : 'translate-x-1']} />
					</button>
				</div>

				<div class="border-surface-light/60 dark:border-surface-dark/60 mt-6 border-t pt-4">
					<h3 class="text-xs font-semibold tracking-wide text-gray-500 uppercase dark:text-gray-400">{m.analytics_preview_title()}</h3>

					{preview ? <pre class="dark:bg-surface-dark mt-2 overflow-x-auto rounded-lg bg-gray-50 p-3 text-xs text-gray-700 dark:text-gray-300">{JSON.stringify(preview, null, '\t')}</pre> : <p class="mt-2 text-sm text-gray-500 dark:text-gray-400">{m.analytics_preview_empty()}</p>}
				</div>
			</section>
		</div>
	);
});
