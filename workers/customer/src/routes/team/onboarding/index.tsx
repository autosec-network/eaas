import type { Session } from '@auth/qwik';
import { Resource, component$, useResource$, useSignal, type ClassList } from '@builder.io/qwik';
import { Form, routeAction$, routeLoader$, server$, useLocation, z, zod$ } from '@builder.io/qwik-city';
import { LuLoader } from '@qwikest/icons/lucide';
import { SiBitwarden } from '@qwikest/icons/simpleicons';
import { TenantByoBwNoteSchema, TenantPropertiesSchema } from 'db';
import * as rootSchema from 'db/schemas/root';
import type { DrizzleD1Database } from 'drizzle-orm/d1';
import { eq, sql } from 'drizzle-orm/sql';
import { Buffer } from 'node:buffer';
import type { UUID } from 'node:crypto';
import { DOJurisdictions } from 'types';
import { BitwardenCloudEndpoints } from 'types/bw';
import { v7 as uuidv7 } from 'uuid';
import type * as zm from 'zod/mini';

const CLOUD_PRESETS = {
	us: { base: BitwardenCloudEndpoints.Api.us, auth: BitwardenCloudEndpoints.Identity.us },
	eu: { base: BitwardenCloudEndpoints.Api.eu, auth: BitwardenCloudEndpoints.Identity.eu },
} as const;

// eslint-disable-next-line qwik/loader-location
const useEu = routeLoader$(({ platform }) => ((platform.request ?? platform).cf as IncomingRequestCfProperties).isEUCountry === '1');

const getProjects = server$(async function (jurisdiction: DOJurisdictions | null, baseEndpoint: string, authEndpoint: string, apiKey: string) {
	const doId = jurisdiction ? this.platform.env.BITWARDEN_SESSION.jurisdiction(jurisdiction).newUniqueId() : this.platform.env.BITWARDEN_SESSION.newUniqueId();
	const doStub = this.platform.env.BITWARDEN_SESSION.get(doId);

	try {
		await doStub.init({ t_jurisdiction: null, t_do_id: null, endpoints: { base: baseEndpoint, authentication: authEndpoint } });
		await doStub.auth(apiKey);
		const projects = await doStub.getProjects();

		return Promise.all(
			projects
				.sort((a, b) => new Date(b.revisionDate).getTime() - new Date(a.revisionDate).getTime())
				.map(async ({ id, name }) => ({
					id,
					name: await doStub.decryptSecret(apiKey, name),
				})),
		);
	} catch (error) {
		console.error('Error fetching projects', error);
		// eslint-disable-next-line preserve-caught-error
		throw new Error(`Unable to fetch projects. Attempt ${doId.toString()}`);
	} finally {
		this.platform.ctx.waitUntil(doStub.nuke('Session ended'));
	}
});

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
			.refine((url) => TenantPropertiesSchema.def.shape.avatar.safeParse(url).success)
			.optional(),
	]),
	jurisdiction: z.union([z.nativeEnum(DOJurisdictions), z.literal('none').transform(() => null)]),
});
// eslint-disable-next-line qwik/loader-location
const useOnboardTenant = routeAction$(
	async (data, { sharedMap, platform, redirect }) => {
		// Generate tenant ID
		const t_id = uuidv7() as UUID;
		const t_id_hex = t_id.replaceAll('-', '');
		const t_id_base64url = Buffer.from(t_id_hex, 'hex').toString('base64url');
		// Get placeholder for tenant DO
		const t_doNamespace = data.jurisdiction ? platform.env.TENANT_D0.jurisdiction(data.jurisdiction) : platform.env.TENANT_D0;
		const t_doId = t_doNamespace.idFromName(t_id);

		const r_db = sharedMap.get('r_db') as DrizzleD1Database<typeof rootSchema>;
		const session = sharedMap.get('session') as Session;

		// Insert refs into root
		await r_db.batch([
			r_db.insert(rootSchema.tenants).values({
				t_id: sql`unhex(${t_id_hex})`,
				jurisdiction: data.jurisdiction,
				do_id: sql`unhex(${t_doId.toString()})`,
			}),
			r_db.insert(rootSchema.users_tenants).values({
				t_id: sql`unhex(${t_id_hex})`,
				u_id: sql`unhex(${session.user!.u_id.hex})`,
			}),
		]);

		// Load tenant DO
		const t_doStub = platform.env.TENANT_D0.get(t_doId);

		if (data.vaultMode === 'bitwarden') {
			// Store access token in our bitwarden securely
			const bw_doId = data.jurisdiction ? platform.env.BITWARDEN_SESSION.jurisdiction(data.jurisdiction).newUniqueId() : platform.env.BITWARDEN_SESSION.newUniqueId();
			const bw_doStub = platform.env.BITWARDEN_SESSION.get(bw_doId);
			try {
				// Connect to our bitwarden, but respecting the jurisdiction
				await bw_doStub.init({
					t_jurisdiction: null,
					t_do_id: null,
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

				platform.ctx.waitUntil(bw_doStub.nuke('Cleaning up'));

				// Now save the id ref to the tenant so we can retreive the access token when needed
				await t_doStub.updateProperties(
					{
						byo_bw: secret.id,
					},
					false,
					true,
				);
			} catch (error) {
				console.error('Error saving BYO bitwarden', error);

				// Rollback
				platform.ctx.waitUntil(
					r_db
						.delete(rootSchema.tenants)
						.where(eq(rootSchema.tenants.t_id, sql`unhex(${t_id_hex})`))
						.limit(1),
				);
				platform.ctx.waitUntil(t_doStub.nuke('Rolling back tenant creation'));

				// eslint-disable-next-line preserve-caught-error
				throw new Error(`Unable to save BYO bitwarden. Attempt ${bw_doId.toString()}`);
			} finally {
				platform.ctx.waitUntil(bw_doStub.nuke('Session ended'));
			}
		}

		// Save the rest of the tenant info
		await t_doStub.updateProperties(
			{
				name: data.name,
				avatar: data.avatar,
				m_time: new Date(),
			},
			false,
			true,
		);

		console.debug('Redirecting to', `/team/${t_id_base64url}`);
		// Return the tenant ID for redirection
		throw redirect(302, `/team/${t_id_base64url}`);
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
					.refine((url) => TenantByoBwNoteSchema.def.shape.endpoints.def.shape.base.safeParse(url).success),
				authCloudEndpoint: z
					.string()
					.url()
					// Use zod3 to do zod4
					.refine((url) => TenantByoBwNoteSchema.def.shape.endpoints.def.shape.authentication.safeParse(url).success),
				accessToken: z.string().nonempty(),
				project: z
					.string()
					.uuid()
					.nonempty()
					// Use zod3 to do zod4
					.refine((url) => TenantByoBwNoteSchema.def.shape.project.safeParse(url).success),
			}),
		]),
	),
);

const inputClass: ClassList = 'focus:border-primary-accent focus:ring-primary-accent w-full rounded-xl border border-gray-300 bg-white px-4 py-3 text-sm text-gray-900 placeholder-gray-500 outline-none focus:ring-1 disabled:opacity-60 dark:border-gray-600 dark:bg-gray-900 dark:text-white dark:placeholder-gray-400';

const labelClass: ClassList = 'mb-1.5 block text-sm font-medium text-gray-700 dark:text-gray-300';

export default component$(() => {
	const location = useLocation();
	const action = useOnboardTenant();
	const isEU = useEu();

	const jurisdiction = useSignal(isEU.value ? DOJurisdictions['The European Union'] : '');
	const vaultMode = useSignal<'managed' | 'bitwarden'>('bitwarden');
	const bwRegion = useSignal<'us' | 'eu' | 'custom'>(isEU.value ? 'eu' : 'us');
	const customBase = useSignal<string>('');
	const customAuth = useSignal<string>('');
	const teamNamePreview = useSignal<string>('');
	const avatarPreview = useSignal<string>('');
	const baseEndpoint = useSignal<string>(isEU.value ? CLOUD_PRESETS.eu.base : CLOUD_PRESETS.us.base);
	const authEndpoint = useSignal<string>(isEU.value ? CLOUD_PRESETS.eu.auth : CLOUD_PRESETS.us.auth);
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
				<h1 class="text-2xl font-bold tracking-tight text-gray-900 dark:text-white">Create a Team</h1>
				<p class="mt-1 text-sm text-gray-500 dark:text-gray-400">Set up a new team with encryption key management.</p>
			</div>

			<div class="border-surface-light/60 shadow-primary-accent/5 dark:border-surface-dark/60 dark:bg-surface-dark/70 rounded-2xl border bg-white/70 p-8 shadow-xl backdrop-blur-md">
				<Form action={action} class="space-y-5">
					{/* Team Name */}
					<div class="flex flex-col gap-4 md:flex-row md:items-end">
						<div class="flex items-center justify-center md:mb-1">
							<div class="border-primary-accent/20 bg-primary-accent/10 text-primary-accent flex h-14 w-14 items-center justify-center overflow-hidden rounded-full border text-lg font-semibold">{avatarPreview.value ? <img src={avatarPreview.value} width={56} height={56} alt="Team avatar preview" class="h-full w-full object-cover" /> : <span>{teamNamePreview.value.trim().charAt(0).toUpperCase() || '?'}</span>}</div>
						</div>
						<div class="flex-1">
							<label for="name" class={labelClass}>
								Team Name
							</label>
							<input id="name" name="name" autoComplete="username" type="text" placeholder="e.g. Acme Corp" required class={inputClass} onInput$={(_, el) => (teamNamePreview.value = el.value)} />
						</div>
						<div class="flex-1">
							<label for="avatar" class={labelClass}>
								Avatar URL
							</label>
							<input
								id="avatar"
								name="avatar"
								type="url"
								autoComplete="url"
								inputMode="url"
								placeholder="https://example.com/avatar.png"
								pattern="https://.*"
								class={[inputClass, 'font-mono']}
								onInput$={(_, el) => {
									if (TenantPropertiesSchema.def.shape.avatar.safeParse(el.value).success) {
										const proxyUrl = new URL('/image/proxy', location.url.origin);
										proxyUrl.searchParams.set('url', el.value);
										avatarPreview.value = proxyUrl.href;
									}
								}}
							/>
						</div>
					</div>

					{/* Jurisdiction */}
					<div>
						<label for="jurisdiction" class={labelClass}>
							<span class="block">Data (General) Jurisdiction</span>
							<span class="text-xs text-gray-400 dark:text-gray-500">This is where we store your data (login info, logs and encrypted byo connection info) and connect to bitwarden from</span>
						</label>
						<select id="jurisdiction" name="jurisdiction" class={inputClass} onChange$={(_, el) => (jurisdiction.value = el.value)}>
							<option selected={!isEU.value} value="none">
								Anywhere
							</option>
							<option selected={isEU.value} value={DOJurisdictions['The European Union']}>
								The European Union
							</option>
							<option value={DOJurisdictions['FedRAMP-compliant data centers']}>FedRAMP-compliant data centers</option>
							<option value={DOJurisdictions['FedRAMP High authorization']}>FedRAMP High authorization</option>
						</select>
					</div>

					{/* Cloud Endpoints */}
					<div>
						<span class={labelClass}>Secret Vault</span>
						<p class="text-xs text-gray-400 dark:text-gray-500">This is where the actual encryption keys are stored for us to do normal operations with</p>
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
										'Autosec Stored'
									) : (
										<>
											<SiBitwarden class="inline-block align-middle text-[#175DDC]" /> BYO Bitwarden
										</>
									)}
								</label>
							))}
						</div>
						{vaultMode.value === 'managed' ? (
							<p class="mt-2 text-xs text-gray-400 dark:text-gray-500">Keys are stored and managed by the platform. No configuration needed. Not recommended for production.</p>
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
											{region === 'us' ? 'US Cloud' : region === 'eu' ? 'EU Cloud' : '🖥️ Self-hosted'}
										</button>
									))}
								</div>
								<p class="mt-2 text-xs text-gray-400 dark:text-gray-500">{bwRegion.value === 'custom' ? 'Keys are stored in your self-hosted server, but managed by this platform. Recommended for advanced teams.' : `Keys are stored in your own account on Bitwarden's ${bwRegion.value.toUpperCase()} cloud, but managed by this platform. Recommended for most teams.`}</p>
								<div class="mt-3 flex gap-4">
									<div class="flex-1">
										<label for="baseCloudEndpoint" class={labelClass}>
											Base Endpoint
										</label>
										<input
											id="baseCloudEndpoint"
											name="baseCloudEndpoint"
											type="url"
											autoComplete="url"
											placeholder="https://your.domain.com/api"
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
											Auth Endpoint
										</label>
										<input
											id="authCloudEndpoint"
											name="authCloudEndpoint"
											type="url"
											autoComplete="url"
											placeholder="https://your.domain.com/identity/connect/token"
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
							<p class="mb-2 text-xs text-gray-400 dark:text-gray-500">This service should have its own project, machine account, and access token to prevent cross-contamination and leakage of secrets. Do not directly manipulate the secrets inside the project or else you'll break it.</p>
							<p class="mb-2 block font-medium text-gray-700 dark:text-gray-300">
								Instructions:
								<ol class="block list-inside list-decimal text-sm text-gray-700 dark:text-gray-300">
									<li>
										Log in to your online web vault
										{bwRegion.value !== 'custom' && (
											<>
												{' '}
												(<a target="_blank" referrerPolicy="no-referrer" class="underline" href={`https://vault.bitwarden.${bwRegion.value === 'us' ? 'com' : 'eu'}`}>{`https://vault.bitwarden.${bwRegion.value === 'us' ? 'com' : 'eu'}`}</a>)
											</>
										)}
									</li>
									<li>On the left navigation, go to "Secrets Manager", then "Projects"</li>
									<li>Click "+ New" in the top right and choose "Project" and name it</li>
									<li>On the left navigation, go to "Machine accounts"</li>
									<li>Click "+ New" in the top right and choose "Machine account" and name it</li>
									<li>Under the "Projects" tab, choose the project you created earlier, click "Add", and set the "Permissions" to "Can read, write". Then click save.</li>
									<li>Under the "Access tokens" tab, click "+ Create access token", name it and set expiration to whatever you prefer</li>
									<li>Copy the generated token and paste it in the "Access Token" field below</li>
									<li>Select the project you created earlier from the "Project" dropdown</li>
								</ol>
							</p>

							{/* Access Token */}
							<div>
								<label for="accessToken" class={labelClass}>
									Access Token
								</label>
								<input id="accessToken" name="accessToken" type="password" autoComplete="off" required placeholder="Your Bitwarden API token" class={[inputClass, 'font-mono']} onInput$={(_, el) => (apiKey.value = el.value)} />
							</div>

							{/* Project Select */}
							<div>
								<label for="project" class={labelClass}>
									Project
								</label>
								<Resource
									value={projects}
									onPending={() => (
										<>
											<select id="project" name="project" disabled class={inputClass + ' disabled:cursor-not-allowed'}>
												<option value="">Loading projects...</option>
											</select>
											<p class="mt-1 text-xs text-gray-400 dark:text-gray-500">Connecting to Bitwarden...</p>
										</>
									)}
									onRejected={(error) => (
										<>
											<select id="project" name="project" disabled class={inputClass + ' disabled:cursor-not-allowed'}>
												<option value="">Unable to load projects</option>
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
															{name}
														</option>
													))}
												</select>
												<p class="mt-1 text-xs text-gray-400 dark:text-gray-500">
													{resolved.length} project{resolved.length !== 1 ? 's' : ''} found
												</p>
											</>
										) : (
											<>
												<select id="project" name="project" disabled class={inputClass + ' disabled:cursor-not-allowed'}>
													<option value="">{baseEndpoint.value ? 'No projects found' : 'Enter endpoints & API key first'}</option>
												</select>
												<p class="mt-1 text-xs text-gray-400 dark:text-gray-500">Available after connecting to Bitwarden.</p>
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
							Something went wrong. Please check your inputs. <span class="font-mono">{JSON.stringify({ fieldErrors: action.value.fieldErrors, formErrors: action.value.formErrors })}</span>
						</div>
					) : null}

					{/* Submit */}
					<button type="submit" class="bg-primary-accent hover:bg-primary-accent/85 hover:shadow-primary-accent/25 mx-auto mt-2 flex w-full max-w-lg cursor-pointer items-center justify-center gap-2 rounded-xl px-4 py-3 text-sm font-medium text-white transition-all duration-150 hover:shadow-md active:scale-[0.98] disabled:cursor-wait disabled:opacity-60" disabled={action.isRunning}>
						{action.isRunning ? (
							<>
								<LuLoader class="h-4 w-4 animate-spin" />
								Creating...
							</>
						) : (
							'Create Team'
						)}
					</button>
				</Form>
			</div>
		</div>
	);
});
