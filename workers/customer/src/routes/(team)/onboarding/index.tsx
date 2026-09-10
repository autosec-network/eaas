import type { Session } from '@auth/qwik';
import { Resource, component$, useResource$, useSignal, type ClassList } from '@builder.io/qwik';
import { Form, routeAction$, useLocation, z, zod$ } from '@builder.io/qwik-city';
import { LuLoader } from '@qwikest/icons/lucide';
import { SiBitwarden } from '@qwikest/icons/simpleicons';
import { TenantByoBwNoteSchema, TenantPropertiesSchema } from 'db';
import { SQLCache } from 'db/cache';
import { DebugLogWriter, drizzleD0 } from 'db/core';
import * as rootSchema from 'db/schemas/root';
import * as tenantSchema from 'db/schemas/tenant/main';
import type { DrizzleD1Database } from 'drizzle-orm/d1';
import { DefaultLogger } from 'drizzle-orm/logger';
import { eq, sql } from 'drizzle-orm/sql';
import { Buffer } from 'node:buffer';
import type { UUID } from 'node:crypto';
import { DOJurisdictions, Permissions } from 'types';
import { BitwardenCloudEndpoints } from 'types/bw';
import { TenantLogEventStatus, TenantLogEventType, TenantLogQueueMessageSchema } from 'types/tenants/logging';
import { v7 as uuidv7 } from 'uuid';
import * as zm from 'zod/mini';
import { getProjects } from '~/helpers/bitwarden-projects';
import { deriveId, isLocal, resolveDoStub, type DOLocator } from '~/helpers/do-proxy';
import { proxiedImageUrl } from '~/helpers/image-proxy';
import { useSession } from '~/routes/plugin@auth';

// eslint-disable-next-line @typescript-eslint/ban-ts-comment
// @ts-ignore this gets generated automatically later in the build process
import * as m from '~/paraglide/messages';

const CLOUD_PRESETS = {
	us: { base: BitwardenCloudEndpoints.Api.us, auth: BitwardenCloudEndpoints.Identity.us },
	eu: { base: BitwardenCloudEndpoints.Api.eu, auth: BitwardenCloudEndpoints.Identity.eu },
} as const;

const useOnboardTenantBaseSchema = z.object({
	name: z.string().nonempty(),
	avatar: z.union([
		// Fake placeholder because empty inputs are technically zero length strings
		z
			.string()
			.trim()
			.length(0)
			.transform(() => undefined),
		// Real avatar check
		z
			.string()
			.trim()
			.nonempty()
			.url()
			// Use zod3 to do zod4
			.refine((url) => zm.validate(TenantPropertiesSchema.def.shape.avatar, url))
			.optional(),
	]),
	jurisdiction: z.union([z.nativeEnum(DOJurisdictions), z.literal('none').transform(() => null)]),
});
// eslint-disable-next-line qwik/loader-location
const useOnboardTenant = routeAction$(
	async (data, { sharedMap, platform, redirect, request }) => {
		// Generate tenant ID
		const t_id = uuidv7() as UUID;
		const t_id_hex = t_id.replaceAll('-', '');
		const t_id_base64url = Buffer.from(t_id_hex, 'hex').toString('base64url');
		// Locally we can't derive a jurisdictional id (workerd throws), so defer that to the proxy and leave the derivation-carrying locator raw.
		const useProxy = isLocal(platform) && !!platform.env.TENANT_D0_PROXY;
		const t_locator: DOLocator = { name: t_id, jurisdiction: data.jurisdiction ?? undefined };
		// `tenants.do_id` is NOT NULL, so we must persist the resolved id hex — resolve it on the proxy when local (jurisdictional `idFromName` throws in workerd).
		const t_do_id_hex = useProxy ? await platform.env.TENANT_D0_PROXY!.resolveId(t_locator) : deriveId(platform.env.TENANT_D0, t_locator).toString();

		const r_db = sharedMap.get('r_db') as DrizzleD1Database;
		const session = sharedMap.get('session') as Session;

		// Load tenant DO (not instantiated until the first RPC call, so resolving it here is safe even if we bail out before ever writing to it)
		const t_doStub = resolveDoStub(platform, platform.env.TENANT_D0, platform.env.TENANT_D0_PROXY, t_locator);
		// The tenant's logs live in their own DO, named after the tenant with a `_logs` suffix so it's derivable from `t_id` alone. Only reached to wipe it on rollback — the rows themselves are written by `api`'s queue consumer, which derives the same name off the message's `t_id`.
		const t_logs_locator: DOLocator = { name: `${t_id}_logs`, jurisdiction: data.jurisdiction ?? undefined };
		const t_logs_doStub = resolveDoStub(platform, platform.env.TENANT_D0_LOGS, platform.env.TENANT_D0_LOGS_PROXY, t_logs_locator);
		/**
		 * Audit logs for this onboarding, buffered rather than enqueued as they happen: any failure below rolls the whole tenant back — logs DO included — and a message already on the queue would land *after* that rollback and resurrect it. They go out in one batch at the very end, once nothing can roll back anymore.
		 *
		 * Order is still the order the events happened in, not the order they're enqueued, because each row's UUIDv7 is minted at the moment it's recorded. Only successes are recorded.
		 */
		const pendingLogs: zm.input<typeof TenantLogQueueMessageSchema>[] = [];
		const logTenantEvent = async (event_type: TenantLogEventType, context: Record<string, unknown>) => {
			// The log's UUIDv7 carries this same millisecond, matching the `timestamp` column
			const timestamp = new Date();
			const headers = (platform.request ?? request).headers;
			// `Cf-Ray` is `<hex id>-<colo>`, and only the id half is hex, so that's all the blob column can hold
			const ray_id = headers.get('CF-Ray')?.split('-')[0];

			const log: zm.input<typeof TenantLogQueueMessageSchema> = {
				t_id: t_id_hex,
				jurisdiction: data.jurisdiction,
				id: uuidv7({ msecs: timestamp.getTime() }).replaceAll('-', ''),
				timestamp: timestamp.toISOString(),
				event_type,
				context,
				ip: headers.get('CF-Connecting-IP'),
				user_agent: headers.get('User-Agent'),
				ray_id,
				u_id: session.user!.u_id.hex,
				status: TenantLogEventStatus.success,
			};
			// We want to post the raw version to the queue, not the parsed version, so we can validate it in the consumer. This also ensures we don't accidentally mutate the object after validation.
			await TenantLogQueueMessageSchema.parseAsync(log);
			return pendingLogs.push(log);
		};
		try {
			// Insert refs into root
			await r_db.batch([
				r_db.insert(rootSchema.tenants).values({
					t_id: sql`unhex(${t_id_hex})`,
					jurisdiction: data.jurisdiction,
					do_id: sql`unhex(${t_do_id_hex})`,
				}),
				r_db.insert(rootSchema.users_tenants).values({
					t_id: sql`unhex(${t_id_hex})`,
					u_id: sql`unhex(${session.user!.u_id.hex})`,
				}),
			]);

			// The tenant exists as of the root rows landing, so this is its first audit log
			await logTenantEvent(TenantLogEventType.created, {
				name: data.name,
				avatar: data.avatar,
				jurisdiction: data.jurisdiction,
				vault: data.vaultMode,
			});

			if (data.vaultMode === 'bitwarden') {
				/**
				 * Deliberately **not** taken from (or added to) the tenant's session pool, unlike every other Bitwarden call on the dashboard: everything in this action is still rollback-able, and a pooled session would outlive a rollback that nuked the tenant it was pooled under. Passing `t_do_id: null` is what keeps it out of the pool - the same reasoning that has this action buffer its audit logs instead of sending them as they happen.
				 *
				 * Store access token in our bitwarden securely. An id minted by the local `workerd` namespace isn't valid for the deployed one the proxy resolves against, so when proxying, mint it on the proxy (which can also apply the jurisdiction workerd doesn't support).
				 */
				const bwUseProxy = isLocal(platform) && !!platform.env.BITWARDEN_SESSION_PROXY;
				const bw_id = bwUseProxy ? await platform.env.BITWARDEN_SESSION_PROXY!.newUniqueId(data.jurisdiction ?? undefined) : (data.jurisdiction ? platform.env.BITWARDEN_SESSION.jurisdiction(data.jurisdiction) : platform.env.BITWARDEN_SESSION).newUniqueId().toString();
				const bw_doStub = resolveDoStub(platform, platform.env.BITWARDEN_SESSION, platform.env.BITWARDEN_SESSION_PROXY, { id: bw_id, jurisdiction: data.jurisdiction ?? undefined });
				// Tracks whether the secret landed in our root Bitwarden org, so a later failure (e.g. `updateProperties`) can delete it instead of leaving it orphaned there
				let createdSecretId: string | undefined;
				try {
					// Connect to our bitwarden, but respecting the jurisdiction
					await bw_doStub.init({
						t_jurisdiction: data.jurisdiction,
						t_do_id: null,
						t_id: t_id_hex,
						u_id: session.user!.u_id.hex,
						ak_id: null,
						endpoints: {
							base: data.jurisdiction === DOJurisdictions['The European Union'] ? BitwardenCloudEndpoints.Api.eu : BitwardenCloudEndpoints.Api.us,
							authentication: data.jurisdiction === DOJurisdictions['The European Union'] ? BitwardenCloudEndpoints.Identity.eu : BitwardenCloudEndpoints.Identity.us,
						},
					});
					const rootAccessToken = data.jurisdiction === DOJurisdictions['The European Union'] ? platform.env.EU_BW_SM_ACCESS_TOKEN : platform.env.US_BW_SM_ACCESS_TOKEN;
					await bw_doStub.auth(rootAccessToken);

					// Encrypt the access token and connection metadata and store it
					const secret = await bw_doStub.setSecret({
						projectId: data.jurisdiction === DOJurisdictions['The European Union'] ? platform.env.EU_BW_SM_PROJECT_ID : platform.env.US_BW_SM_PROJECT_ID,
						key: await bw_doStub.encryptSecret(rootAccessToken, [t_id_base64url, 'bw'].join('/')),
						value: await bw_doStub.encryptSecret(rootAccessToken, data.accessToken),
						note: await bw_doStub.encryptSecret(
							rootAccessToken,
							JSON.stringify({
								project: data.project,
								endpoints: {
									base: data.baseCloudEndpoint,
									authentication: data.authCloudEndpoint,
								},
							} satisfies zm.input<typeof TenantByoBwNoteSchema>),
						),
					});
					createdSecretId = secret.id;

					// The token itself never goes in the log - only where it now lives and what it connects to
					await logTenantEvent(TenantLogEventType['changed byo vault token'], {
						secret: secret.id,
						project: data.project,
						endpoints: {
							base: data.baseCloudEndpoint,
							authentication: data.authCloudEndpoint,
						},
					});

					// Now save the id ref to the tenant so we can retreive the access token when needed
					await t_doStub.updateProperties(
						{
							byo_bw: secret.id,
						},
						false,
						true,
					);

					// Pointing `byo_bw` at that secret is what actually moves the tenant off our managed vault
					await logTenantEvent(TenantLogEventType['changed vault'], {
						from: null,
						to: 'bitwarden',
					});
				} catch (error) {
					console.error('Error saving BYO bitwarden', error);

					// Roll back the secret we created in our root Bitwarden org, if we got that far, before the session gets nuked below
					if (createdSecretId) {
						try {
							await bw_doStub.deleteSecrets([createdSecretId]);
						} catch (cleanupError) {
							console.error('Failed to roll back orphaned bitwarden secret', cleanupError);
						}
					}

					// eslint-disable-next-line preserve-caught-error
					throw new Error(`Unable to save BYO bitwarden. Attempt ${bw_id}`);
				} finally {
					platform.ctx.waitUntil(bw_doStub.nuke('Session ended'));
				}
			}

			const now = new Date();
			// Save the rest of the tenant info
			await t_doStub.updateProperties(
				{
					name: data.name,
					avatar: data.avatar,
					m_time: now,
				},
				false,
				true,
			);

			const browserCache = sharedMap.get('browserCache') as boolean;
			const t_db = drizzleD0(t_doStub, {
				...(platform.env.NODE_ENV !== 'production' && { logger: new DefaultLogger({ writer: new DebugLogWriter(t_do_id_hex) }) }),
				cache: new SQLCache(
					{
						dbName: t_do_id_hex,
						dbType: 'do',
						strategy: browserCache ? 'all' : 'explicit',
						cacheTTL: parseInt(platform.env.SQL_TTL, 10),
						logging: platform.env.NODE_ENV !== 'production',
					},
					// eslint-disable-next-line @typescript-eslint/no-unnecessary-condition
					globalThis.caches ?? platform.caches,
				),
			});

			await t_db.insert(tenantSchema.users).values({
				u_id: sql`unhex(${session.user?.u_id.hex})`,
				do_id: sql`unhex(${session.user?.do_id})`,
				a_time: now,
				b_time: now,
				m_time: now,
				approved: true,
				r_tenant: Permissions.Admin,
				r_users: Permissions.Admin,
				r_roles: Permissions.Write,
				r_billing: Permissions.Admin,
				r_apikeys: Permissions.Admin,
				r_keyring: Permissions.Admin,
				r_datakey: Permissions.Admin,
				r_logs: Permissions.Admin,
			});

			// Nothing can roll the tenant back past this point, so the buffered audit trail is safe to hand over. `api`'s queue consumer is what creates the logs DO, on its first insert. A failed enqueue mustn't undo a tenant that's otherwise fully created, so it's logged and swallowed rather than thrown.
			platform.ctx.waitUntil(platform.env.LOGS.sendBatch(pendingLogs.map((body) => ({ body, contentType: 'json' }))));
		} catch (error) {
			console.error('Error onboarding tenant, rolling back', error);

			// `users_tenants.t_id` cascades on delete, so removing the tenant row is enough to clean up both root tables. `t_id` is a fresh UUIDv7, so this is a harmless no-op if the insert never happened.
			platform.ctx.waitUntil(
				r_db
					.delete(rootSchema.tenants)
					.where(eq(rootSchema.tenants.t_id, sql`unhex(${t_id_hex})`))
					.limit(1),
			);
			// Wipes any properties/rows already written to the tenant DO (byo_bw ref, name/avatar, the admin user row); harmless no-op if nothing was ever written
			platform.ctx.waitUntil(t_doStub.nuke('Rolling back tenant creation'));
			// Same for the logs DO, so a tenant that never finished onboarding doesn't leave one behind; wiping the storage is what makes a Durable Object stop existing, so this is harmless even if we bailed out before creating it
			platform.ctx.waitUntil(t_logs_doStub.nuke('Rolling back tenant creation'));

			throw error;
		}

		// Return the tenant ID for redirection
		throw redirect(302, `/${t_id_base64url}`);
	},
	zod$(
		z.discriminatedUnion('vaultMode', [
			useOnboardTenantBaseSchema.extend({
				vaultMode: z.literal('managed'),
			}),
			useOnboardTenantBaseSchema.extend({
				vaultMode: z.literal('bitwarden'),
				baseCloudEndpoint: z
					.string()
					.url()
					// Use zod3 to do zod4
					.refine((url) => zm.validate(TenantByoBwNoteSchema.def.shape.endpoints.def.shape.base, url)),
				authCloudEndpoint: z
					.string()
					.url()
					// Use zod3 to do zod4
					.refine((url) => zm.validate(TenantByoBwNoteSchema.def.shape.endpoints.def.shape.authentication, url)),
				accessToken: z.string().nonempty(),
				project: z
					.string()
					.uuid()
					.nonempty()
					// Use zod3 to do zod4
					.refine((url) => zm.validate(TenantByoBwNoteSchema.def.shape.project, url)),
			}),
		]),
	),
);

const inputClass: ClassList = 'focus:border-primary-accent focus:ring-primary-accent w-full rounded-xl border border-gray-300 bg-white px-4 py-3 text-sm text-gray-900 placeholder-gray-500 outline-none focus:ring-1 disabled:opacity-60 dark:border-gray-600 dark:bg-gray-900 dark:text-white dark:placeholder-gray-400';

const labelClass: ClassList = 'mb-1.5 block text-sm font-medium text-gray-700 dark:text-gray-300';

export default component$(() => {
	const location = useLocation();
	const action = useOnboardTenant();
	const session = useSession();

	const jurisdiction = useSignal(session.value?.user?.do_jurisdiction === DOJurisdictions['The European Union'] ? DOJurisdictions['The European Union'] : '');
	const vaultMode = useSignal<'managed' | 'bitwarden'>('bitwarden');
	const bwRegion = useSignal<'us' | 'eu' | 'custom'>(session.value?.user?.do_jurisdiction === DOJurisdictions['The European Union'] ? 'eu' : 'us');
	const customBase = useSignal<string>('');
	const customAuth = useSignal<string>('');
	const teamNamePreview = useSignal<string>('');
	const avatarPreview = useSignal<string>('');
	const baseEndpoint = useSignal<string>(session.value?.user?.do_jurisdiction === DOJurisdictions['The European Union'] ? CLOUD_PRESETS.eu.base : CLOUD_PRESETS.us.base);
	const authEndpoint = useSignal<string>(session.value?.user?.do_jurisdiction === DOJurisdictions['The European Union'] ? CLOUD_PRESETS.eu.auth : CLOUD_PRESETS.us.auth);
	const apiKey = useSignal('');
	const debounceTimer = useSignal(0);

	// eslint-disable-next-line @typescript-eslint/unbound-method
	const projects = useResource$(({ track, cleanup }) => {
		const j = track(() => jurisdiction.value);
		const base = track(() => baseEndpoint.value);
		const auth = track(() => authEndpoint.value);
		const key = track(() => apiKey.value);

		if (!base || !auth || !key) return Promise.resolve([]);

		cleanup(() => {
			window.clearTimeout(debounceTimer.value);
		});

		return new Promise<{ id: string; name: string }[]>((resolve, reject) => {
			debounceTimer.value = window.setTimeout(() => {
				getProjects(j && j !== 'none' ? (j as DOJurisdictions) : null, base, auth, key)
					.then(resolve)
					.catch(reject);
			}, 600);
		});
	});

	return (
		<div class="mx-auto w-full max-w-7xl px-6 py-10">
			<div class="mb-8">
				<h1 class="text-2xl font-bold tracking-tight text-gray-900 dark:text-white">{m.team_onboarding_title()}</h1>
				<p class="mt-1 text-sm text-gray-500 dark:text-gray-400">{m.team_onboarding_subtitle()}</p>
			</div>

			<div class="border-surface-light/60 shadow-primary-accent/5 dark:border-surface-dark/60 dark:bg-surface-dark/70 rounded-2xl border bg-white/70 p-8 shadow-xl backdrop-blur-md">
				<Form action={action} class="space-y-5">
					{/* Team Name */}
					<div class="flex flex-col gap-4 md:flex-row md:items-end">
						<div class="flex items-center justify-center md:mb-1">
							<div class="border-primary-accent/20 bg-primary-accent/10 text-primary-accent flex h-14 w-14 items-center justify-center overflow-hidden rounded-full border text-lg font-semibold">{avatarPreview.value ? <img src={avatarPreview.value} width={56} height={56} alt={m.team_onboarding_avatar_preview_alt()} class="h-full w-full object-cover" /> : <span>{teamNamePreview.value.trim().charAt(0).toUpperCase() || '?'}</span>}</div>
						</div>
						<div class="flex-1">
							<label for="name" class={labelClass}>
								{m.team_onboarding_name_label()}
							</label>
							<input id="name" name="name" autoComplete="username" type="text" placeholder={m.team_onboarding_name_placeholder()} required class={inputClass} onInput$={(_, el) => (teamNamePreview.value = el.value)} />
						</div>
						<div class="flex-1">
							<label for="avatar" class={labelClass}>
								{m.team_onboarding_avatar_label()}
							</label>
							<input
								id="avatar"
								name="avatar"
								type="url"
								autoComplete="url"
								inputMode="url"
								placeholder={m.team_onboarding_avatar_placeholder()}
								pattern="https://.*"
								class={[inputClass, 'font-mono']}
								onInput$={(_, el) => {
									if (zm.validate(TenantPropertiesSchema.def.shape.avatar, el.value)) {
										avatarPreview.value = proxiedImageUrl(location.url.origin, el.value);
									}
								}}
							/>
						</div>
					</div>

					{/* Jurisdiction */}
					<div>
						<label for="jurisdiction" class={labelClass}>
							<span class="block">{m.team_onboarding_jurisdiction_label()}</span>
							<span class="text-xs text-gray-400 dark:text-gray-500">{m.team_onboarding_jurisdiction_help()}</span>
						</label>
						<select id="jurisdiction" name="jurisdiction" class={inputClass} onChange$={(_, el) => (jurisdiction.value = el.value)}>
							<option selected={!session.value?.user?.do_jurisdiction} value="none">
								{m.team_onboarding_jurisdiction_anywhere()}
							</option>
							<option selected={session.value?.user?.do_jurisdiction === DOJurisdictions['The European Union']} value={DOJurisdictions['The European Union']}>
								{m.team_onboarding_jurisdiction_eu()}
							</option>
							<option selected={session.value?.user?.do_jurisdiction === DOJurisdictions['FedRAMP-compliant data centers']} value={DOJurisdictions['FedRAMP-compliant data centers']}>
								{m.team_onboarding_jurisdiction_fedramp()}
							</option>
							<option selected={session.value?.user?.do_jurisdiction === DOJurisdictions['FedRAMP High authorization']} value={DOJurisdictions['FedRAMP High authorization']}>
								{m.team_onboarding_jurisdiction_fedramp_high()}
							</option>
							<option selected={session.value?.user?.do_jurisdiction === DOJurisdictions['The United States']} value={DOJurisdictions['The United States']}>
								{m.team_onboarding_jurisdiction_us()}
							</option>
						</select>
					</div>

					{/* Cloud Endpoints */}
					<div>
						<span class={labelClass}>{m.team_onboarding_vault_label()}</span>
						<p class="text-xs text-gray-400 dark:text-gray-500">{m.team_onboarding_vault_help()}</p>
						<div class="flex gap-2">
							{(['managed', 'bitwarden'] as const).map((mode) => (
								<label key={mode} class={['flex-1', 'cursor-pointer', 'rounded-xl', 'border', 'px-4', 'py-2.5', 'text-center', 'text-sm', 'font-medium', 'transition-all', 'duration-150', ...(vaultMode.value === mode ? ['border-primary-accent', 'bg-primary-accent/10', 'text-primary-accent', 'dark:bg-primary-accent/20'] : ['border-gray-300', 'text-gray-600', 'hover:border-gray-400', 'dark:border-gray-600', 'dark:text-gray-400', 'dark:hover:border-gray-500'])]}>
									<input
										type="radio"
										name="vaultMode"
										value={mode}
										checked={vaultMode.value === mode}
										class="hidden"
										onChange$={() => {
											vaultMode.value = mode;
											if (mode === 'bitwarden') {
												if (bwRegion.value === 'us' || bwRegion.value === 'eu') {
													baseEndpoint.value = CLOUD_PRESETS[bwRegion.value].base;
													authEndpoint.value = CLOUD_PRESETS[bwRegion.value].auth;
												} else {
													baseEndpoint.value = customBase.value;
													authEndpoint.value = customAuth.value;
												}
											}
										}}
									/>
									{mode === 'managed' ? (
										m.team_onboarding_vault_managed()
									) : (
										<>
											<SiBitwarden class="inline-block align-middle text-[#175DDC]" /> {m.team_onboarding_vault_bitwarden()}
										</>
									)}
								</label>
							))}
						</div>
						{vaultMode.value === 'managed' ? (
							<p class="mt-2 text-xs text-gray-400 dark:text-gray-500">{m.team_onboarding_vault_managed_hint()}</p>
						) : (
							<>
								<div class="mt-3 flex gap-2">
									{(['us', 'eu', 'custom'] as const).map((region) => (
										<button
											key={region}
											type="button"
											class={['flex-1', 'cursor-pointer', 'rounded-xl', 'border', 'px-4', 'py-2', 'text-sm', 'font-medium', 'transition-all', 'duration-150', ...(bwRegion.value === region ? ['border-primary-accent', 'bg-primary-accent/10', 'text-primary-accent', 'dark:bg-primary-accent/20'] : ['border-gray-300', 'text-gray-600', 'hover:border-gray-400', 'dark:border-gray-600', 'dark:text-gray-400', 'dark:hover:border-gray-500'])]}
											onClick$={() => {
												bwRegion.value = region;
												if (region === 'us' || region === 'eu') {
													baseEndpoint.value = CLOUD_PRESETS[region].base;
													authEndpoint.value = CLOUD_PRESETS[region].auth;
												} else {
													baseEndpoint.value = customBase.value;
													authEndpoint.value = customAuth.value;
												}
											}}>
											{region === 'us' ? m.team_onboarding_region_us() : region === 'eu' ? m.team_onboarding_region_eu() : m.team_onboarding_region_custom()}
										</button>
									))}
								</div>
								<p class="mt-2 text-xs text-gray-400 dark:text-gray-500">{bwRegion.value === 'custom' ? m.team_onboarding_region_custom_hint() : m.team_onboarding_region_cloud_hint()}</p>
								<div class="mt-3 flex gap-4">
									<div class="flex-1">
										<label for="baseCloudEndpoint" class={labelClass}>
											{m.team_onboarding_base_endpoint_label()}
										</label>
										<input
											id="baseCloudEndpoint"
											name="baseCloudEndpoint"
											type="url"
											autoComplete="url"
											placeholder={m.team_onboarding_base_endpoint_placeholder()}
											class={[inputClass, 'font-mono', { 'cursor-not-allowed': bwRegion.value !== 'custom' }]}
											readOnly={bwRegion.value !== 'custom'}
											value={baseEndpoint.value}
											required
											onInput$={(_, el) => {
												customBase.value = el.value;
												baseEndpoint.value = el.value;
											}}
										/>
									</div>
									<div class="flex-1">
										<label for="authCloudEndpoint" class={labelClass}>
											{m.team_onboarding_auth_endpoint_label()}
										</label>
										<input
											id="authCloudEndpoint"
											name="authCloudEndpoint"
											type="url"
											autoComplete="url"
											placeholder={m.team_onboarding_auth_endpoint_placeholder()}
											class={[inputClass, 'font-mono', { 'cursor-not-allowed': bwRegion.value !== 'custom' }]}
											readOnly={bwRegion.value !== 'custom'}
											value={authEndpoint.value}
											required
											onInput$={(_, el) => {
												customAuth.value = el.value;
												authEndpoint.value = el.value;
											}}
										/>
									</div>
								</div>
							</>
						)}
					</div>

					{vaultMode.value === 'bitwarden' && (
						<>
							<p class="mb-2 text-xs text-gray-400 dark:text-gray-500">{m.team_onboarding_byo_warning()}</p>
							<div class="mb-2 block font-medium text-gray-700 dark:text-gray-300">
								{m.team_onboarding_instructions_title()}
								<ol class="block list-inside list-decimal text-sm text-gray-700 dark:text-gray-300">
									<li>
										{m.team_onboarding_instruction_1()}
										{bwRegion.value !== 'custom' && (
											<>
												{' '}
												(<a target="_blank" referrerPolicy="no-referrer" class="underline" href={`https://vault.bitwarden.${bwRegion.value === 'us' ? 'com' : 'eu'}`}>{`https://vault.bitwarden.${bwRegion.value === 'us' ? 'com' : 'eu'}`}</a>)
											</>
										)}
									</li>
									<li>{m.team_onboarding_instruction_2()}</li>
									<li>{m.team_onboarding_instruction_3()}</li>
									<li>{m.team_onboarding_instruction_4()}</li>
									<li>{m.team_onboarding_instruction_5()}</li>
									<li>{m.team_onboarding_instruction_6()}</li>
									<li>{m.team_onboarding_instruction_7()}</li>
									<li>{m.team_onboarding_instruction_8()}</li>
									<li>{m.team_onboarding_instruction_9()}</li>
								</ol>
							</div>

							{/* Access Token */}
							<div>
								<label for="accessToken" class={labelClass}>
									{m.team_onboarding_access_token_label()}
								</label>
								<input id="accessToken" name="accessToken" type="password" autoComplete="off" required placeholder={m.team_onboarding_access_token_placeholder()} class={[inputClass, 'font-mono']} onInput$={(_, el) => (apiKey.value = el.value)} />
							</div>

							{/* Project Select */}
							<div>
								<label for="project" class={labelClass}>
									{m.team_onboarding_project_label()}
								</label>
								<Resource
									value={projects}
									onPending={() => (
										<>
											<select id="project" name="project" disabled class={inputClass + ' disabled:cursor-not-allowed'}>
												<option value="">{m.team_onboarding_projects_loading()}</option>
											</select>
											<p class="mt-1 text-xs text-gray-400 dark:text-gray-500">{m.team_onboarding_projects_connecting()}</p>
										</>
									)}
									onRejected={(error) => (
										<>
											<select id="project" name="project" disabled class={inputClass + ' disabled:cursor-not-allowed'}>
												<option value="">{m.team_onboarding_projects_unable()}</option>
											</select>
											<p class="mt-1 text-xs text-red-500 dark:text-red-400">{error.message}</p>
										</>
									)}
									onResolved={(resolved) =>
										resolved.length > 0 ? (
											<>
												<select id="project" name="project" class={inputClass} required>
													{resolved.map(({ id, name }, index) => (
														<option selected={index === 0} key={id} value={id}>
															{`${name} (${id})`}
														</option>
													))}
												</select>
												<p class="mt-1 text-xs text-gray-400 dark:text-gray-500">{resolved.length === 1 ? m.team_onboarding_project_found_singular() : m.team_onboarding_project_found_plural()}</p>
											</>
										) : (
											<>
												<select id="project" name="project" disabled class={inputClass + ' disabled:cursor-not-allowed'}>
													<option value="">{baseEndpoint.value ? m.team_onboarding_projects_none() : m.team_onboarding_projects_enter_credentials()}</option>
												</select>
												<p class="mt-1 text-xs text-gray-400 dark:text-gray-500">{m.team_onboarding_projects_available_hint()}</p>
											</>
										)
									}
								/>
							</div>
						</>
					)}

					{/* Error */}
					{action.value?.failed ? (
						<div class="rounded-lg border border-red-200 bg-red-50 p-3 text-sm text-red-700 dark:border-red-800 dark:bg-red-900/30 dark:text-red-300">
							{m.team_onboarding_form_error()} <span class="font-mono">{JSON.stringify({ fieldErrors: action.value.fieldErrors, formErrors: action.value.formErrors })}</span>
						</div>
					) : null}

					{/* Submit */}
					<button type="submit" class="bg-primary-accent hover:bg-primary-accent/85 hover:shadow-primary-accent/25 mx-auto mt-2 flex w-full max-w-lg cursor-pointer items-center justify-center gap-2 rounded-xl px-4 py-3 text-sm font-medium text-white transition-all duration-150 hover:shadow-md active:scale-[0.98] disabled:cursor-wait disabled:opacity-60" disabled={action.isRunning}>
						{action.isRunning ? (
							<>
								<LuLoader class="h-4 w-4 animate-spin" />
								{m.team_onboarding_creating()}
							</>
						) : (
							m.team_onboarding_submit()
						)}
					</button>
				</Form>
			</div>
		</div>
	);
});
