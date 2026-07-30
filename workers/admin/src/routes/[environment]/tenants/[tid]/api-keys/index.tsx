import { component$, getLocale, Resource } from '@builder.io/qwik';
import { Link, routeLoader$, useLocation, type DocumentHead } from '@builder.io/qwik-city';
import { LuAlertTriangle, LuCheck, LuScrollText, LuX } from '@qwikest/icons/lucide';
import * as rootSchema from 'db/schemas/root';
import * as tenantSchema from 'db/schemas/tenant/main';
import type { DrizzleD1Database } from 'drizzle-orm/d1';
import { asc, desc, eq, sql } from 'drizzle-orm/sql';
import type { SqliteRemoteDatabase } from 'drizzle-orm/sqlite-proxy';
import type { Permissions } from 'types';
import type { ExtractKeysWithPrefix } from 'types/tenants';
import { permissionLabel } from '~/routes/[environment]/tenants/db-helpers';
import { hexToUuid } from '~/routes/[environment]/users/db-helpers';
import { useTimezone } from '~/routes/layout';

type ApiKeyRoles = NonNullable<ExtractKeysWithPrefix<typeof tenantSchema.api_keys.$inferSelect, 'r_'>>;
type KeyringPolicyRoles = NonNullable<ExtractKeysWithPrefix<typeof tenantSchema.api_keys_keyrings.$inferSelect, 'r_'>>;

/** Taken off the schemas so a new permission column shows up here without touching this file */
const API_KEY_ROLE_FIELDS = Object.keys(tenantSchema.api_keys).filter((key) => key.startsWith('r_')) as [ApiKeyRoles, ...ApiKeyRoles[]];
const KEYRING_POLICY_ROLE_FIELDS = Object.keys(tenantSchema.api_keys_keyrings).filter((key) => key.startsWith('r_')) as [KeyringPolicyRoles, ...KeyringPolicyRoles[]];

/** Some `r_` columns are graded permissions, others are plain operation toggles — the column's own type says which */
type RoleValue = boolean | Permissions;
const pickRoles = <TField extends string>(row: Record<TField, RoleValue>, fields: TField[]) => fields.map((field): [TField, RoleValue] => [field, row[field]]);

/**
 * API keys live inside the tenant's Durable Object, while the root `api_keys_tenants` table is what the API itself resolves a key against — a key missing from either side is broken, so both are loaded.
 */
export const useTenantApiKeys = routeLoader$(({ sharedMap }) => {
	const r_db = sharedMap.get('r_db') as DrizzleD1Database;
	const t_db = sharedMap.get('t_db') as SqliteRemoteDatabase;
	const t_id_hex = sharedMap.get('t_id_hex') as string;

	return async () => {
		const [apiKeyRows, policyRows, keyringRows, rootRows] = await Promise.all([
			t_db.select().from(tenantSchema.api_keys).orderBy(desc(tenantSchema.api_keys.b_time)),
			t_db.select().from(tenantSchema.api_keys_keyrings),
			t_db
				.select({
					kr_id: tenantSchema.keyrings.kr_id,
					name: tenantSchema.keyrings.name,
				})
				.from(tenantSchema.keyrings)
				.orderBy(asc(tenantSchema.keyrings.name)),
			r_db
				.select({
					ak_id: rootSchema.api_keys_tenants.ak_id,
					expires: rootSchema.api_keys_tenants.expires,
				})
				.from(rootSchema.api_keys_tenants)
				.where(eq(rootSchema.api_keys_tenants.t_id, sql`unhex(${t_id_hex})`)),
		]);

		const keyringNames = new Map(keyringRows.map((row) => [row.kr_id.toString('hex'), row.name]));
		const rootByAkId = new Map(rootRows.map((row) => [row.ak_id.toString('hex'), row.expires]));

		const policiesByAkId = policyRows.reduce<Record<string, { kr_id_hex: string; keyringName: string | null; roles: [KeyringPolicyRoles, RoleValue][] }[]>>((acc, row) => {
			const ak_id_hex = row.ak_id.toString('hex');
			const kr_id_hex = row.kr_id.toString('hex');

			acc[ak_id_hex] ??= [];
			acc[ak_id_hex].push({
				kr_id_hex,
				keyringName: keyringNames.get(kr_id_hex) ?? null,
				roles: pickRoles(row, KEYRING_POLICY_ROLE_FIELDS),
			});

			return acc;
		}, {});

		const apiKeys = apiKeyRows.map((row) => {
			const ak_id_hex = row.ak_id.toString('hex');
			const rootExpires = rootByAkId.get(ak_id_hex);

			return {
				ak_id_hex,
				ak_id_uuid: hexToUuid(ak_id_hex),
				ak_id_base64url: row.ak_id.toString('base64url'),
				name: row.name,
				last_identifier: row.last_identifier,
				expires: row.expires,
				a_time: row.a_time,
				b_time: row.b_time,
				c_time: row.c_time,
				m_time: row.m_time,
				roles: pickRoles(row, API_KEY_ROLE_FIELDS),
				policies: policiesByAkId[ak_id_hex] ?? [],
				rootLinked: rootExpires !== undefined,
				// The API trusts root's copy of `expires`, so a drifted value silently changes when the key stops working
				rootExpiresMismatch: rootExpires !== undefined && rootExpires.getTime() !== row.expires.getTime() ? rootExpires : null,
			};
		});

		const tenantAkIds = new Set(apiKeys.map((apiKey) => apiKey.ak_id_hex));

		return {
			apiKeys,
			rootOnly: rootRows
				.map((row) => ({
					ak_id_hex: row.ak_id.toString('hex'),
					ak_id_base64url: row.ak_id.toString('base64url'),
					expires: row.expires,
				}))
				.filter((row) => !tenantAkIds.has(row.ak_id_hex))
				.map((row) => ({ ...row, ak_id_uuid: hexToUuid(row.ak_id_hex) })),
		};
	};
});

export const head: DocumentHead = {
	title: 'Tenant API Keys — EaaS Admin',
};

export default component$(() => {
	const loc = useLocation();
	const locale = getLocale();
	const timezone = useTimezone();
	const apiKeysData = useTenantApiKeys();

	const logsHref = (ak_id_base64url: string) => `/${loc.params['environment']}/tenants/${loc.params['tid']}/logs/?ak=${ak_id_base64url}`;

	const RoleChip = ({ field, value }: { field: string; value: RoleValue }) =>
		typeof value === 'boolean' ? (
			<span class={['inline-flex items-center rounded-full px-2 py-0.5 text-xs', value ? 'bg-green-100 text-green-800 dark:bg-green-900/30 dark:text-green-400' : 'bg-gray-100 text-gray-500 dark:bg-gray-700 dark:text-gray-400'].join(' ')}>{field}</span>
		) : (
			<span class="border-default-medium inline-flex items-center gap-1 rounded-full border px-2 py-0.5 text-xs dark:border-gray-600">
				{field}: {permissionLabel(value)}
			</span>
		);

	const Timestamp = ({ label, value }: { label: string; value: Date | null }) => (
		<p>
			<span class="text-body-subtle dark:text-gray-500">{label}: </span>
			{value ? (
				<time dateTime={value.toISOString()} title={[value.toLocaleString(locale, { hour12: false, timeZone: 'UTC' }), 'UTC'].join(' ')}>
					{[value.toLocaleString(locale, { timeZone: timezone.value.long }), timezone.value.short].join(' ')}
				</time>
			) : (
				<span class="text-body-subtle italic dark:text-gray-500">never</span>
			)}
		</p>
	);

	return (
		<Resource
			value={apiKeysData}
			onPending={() => (
				<div class="px-4 py-8 text-center">
					<span class="text-body-subtle dark:text-gray-500">Loading API keys…</span>
				</div>
			)}
			onRejected={(error) => (
				<div class="rounded-lg border border-red-300 bg-red-50 p-4 text-sm text-red-800 dark:border-red-800 dark:bg-red-900/20 dark:text-red-400">
					Failed to load API keys: {error.name}: {error.message}
				</div>
			)}
			onResolved={(data) => (
				<div class="space-y-6">
					{data.apiKeys.length === 0 ? (
						<p class="text-body-subtle text-sm dark:text-gray-500">This tenant has no API keys.</p>
					) : (
						<ul class="flex flex-col gap-4">
							{data.apiKeys.map((apiKey) => (
								<li key={apiKey.ak_id_hex} class="border-default-medium bg-surface-light dark:bg-surface-dark border p-4">
									<div class="flex flex-col gap-3 lg:flex-row lg:items-start lg:justify-between">
										<div>
											<h2 class="text-heading text-base font-semibold dark:text-white">
												{apiKey.name} <span class="text-body-subtle font-mono text-xs dark:text-gray-500">****{apiKey.last_identifier}</span>
											</h2>
											<code class="text-body-subtle text-xs break-all dark:text-gray-500">{apiKey.ak_id_uuid}</code>
											<div class="mt-2 flex flex-wrap items-center gap-2 text-xs">
												{apiKey.roles.map(([field, value]) => (
													<RoleChip key={field} field={field} value={value} />
												))}
												<span class="inline-flex items-center gap-1">
													{apiKey.rootLinked ? <LuCheck class="h-3.5 w-3.5 text-green-500" /> : <LuX class="h-3.5 w-3.5 text-red-500" />}
													root link
												</span>
											</div>
										</div>

										<div class="text-body text-xs lg:text-right dark:text-gray-400">
											<Timestamp label="Last used" value={apiKey.a_time} />
											<Timestamp label="Created" value={apiKey.b_time} />
											<Timestamp label="Permissions changed" value={apiKey.c_time} />
											<Timestamp label="Rotated" value={apiKey.m_time} />
											<Timestamp label="Expires" value={apiKey.expires} />
											<Link prefetch="js" href={logsHref(apiKey.ak_id_base64url)} class="text-primary-accent mt-2 inline-flex items-center gap-1.5 hover:underline">
												<LuScrollText class="h-3.5 w-3.5" />
												View logs for this key
											</Link>
										</div>
									</div>

									{!apiKey.rootLinked && <p class="mt-3 text-xs text-red-600 dark:text-red-400">No `api_keys_tenants` row in root — the API can't resolve this key to this tenant, so it will never authenticate.</p>}
									{apiKey.rootExpiresMismatch && (
										<p class="mt-3 text-xs text-amber-600 dark:text-amber-400">
											Root expires at{' '}
											<time dateTime={apiKey.rootExpiresMismatch.toISOString()} title={[apiKey.rootExpiresMismatch.toLocaleString(locale, { hour12: false, timeZone: 'UTC' }), 'UTC'].join(' ')}>
												{[apiKey.rootExpiresMismatch.toLocaleString(locale, { timeZone: timezone.value.long }), timezone.value.short].join(' ')}
											</time>
											, which disagrees with the tenant's copy above.
										</p>
									)}

									{/* Per-keyring policies */}
									<div class="mt-4">
										<h3 class="text-body-subtle mb-2 text-xs uppercase dark:text-gray-400">Keyring permissions ({apiKey.policies.length})</h3>
										{apiKey.policies.length === 0 ? (
											<p class="text-body-subtle text-xs dark:text-gray-500">Not linked to any keyring.</p>
										) : (
											<ul class="flex flex-col gap-2">
												{apiKey.policies.map((policy) => (
													<li key={policy.kr_id_hex} class="border-default-medium flex flex-wrap items-center gap-2 border p-2 dark:border-gray-700">
														<span class="text-body text-sm dark:text-gray-300">{policy.keyringName ?? <code class="text-xs break-all">{policy.kr_id_hex}</code>}</span>
														{policy.roles.map(([field, value]) => (
															<RoleChip key={field} field={field} value={value} />
														))}
													</li>
												))}
											</ul>
										)}
									</div>
								</li>
							))}
						</ul>
					)}

					{/* Root rows with no key behind them */}
					{data.rootOnly.length > 0 && (
						<div class="border-default-medium bg-surface-light dark:bg-surface-dark border p-4">
							<h2 class="text-heading mb-1 flex items-center gap-2 text-lg font-semibold dark:text-white">
								<LuAlertTriangle class="h-4 w-4 text-amber-500" />
								Linked in root only
							</h2>
							<p class="text-body-subtle mb-3 text-sm dark:text-gray-400">Root maps these API keys to this tenant, but the tenant's own database has no record of them.</p>
							<ul class="flex flex-col gap-2">
								{data.rootOnly.map((apiKey) => (
									<li key={apiKey.ak_id_hex} class="flex flex-wrap items-center justify-between gap-2">
										<code class="text-xs break-all">{apiKey.ak_id_uuid}</code>
										<Link prefetch="js" href={logsHref(apiKey.ak_id_base64url)} class="text-primary-accent inline-flex items-center gap-1.5 text-xs hover:underline">
											<LuScrollText class="h-3.5 w-3.5" />
											View logs
										</Link>
									</li>
								))}
							</ul>
						</div>
					)}
				</div>
			)}
		/>
	);
});
