import { Resource, component$, useComputed$, useResource$, useSignal, type ClassList } from '@builder.io/qwik';
import { LuLoader } from '@qwikest/icons/lucide';
import { SiBitwarden } from '@qwikest/icons/simpleicons';
import { DOJurisdictions } from 'types';
import { BitwardenCloudEndpoints } from 'types/bw';
import { getProjects } from '~/helpers/bitwarden-projects';

// eslint-disable-next-line @typescript-eslint/ban-ts-comment
// @ts-ignore this gets generated automatically later in the build process
import * as m from '~/paraglide/messages';

const CLOUD_PRESETS = {
	us: { base: BitwardenCloudEndpoints.Api.us, auth: BitwardenCloudEndpoints.Identity.us },
	eu: { base: BitwardenCloudEndpoints.Api.eu, auth: BitwardenCloudEndpoints.Identity.eu },
} as const;

const inputClass: ClassList = 'focus:border-primary-accent focus:ring-primary-accent w-full rounded-xl border border-gray-300 bg-white px-4 py-3 text-sm text-gray-900 placeholder-gray-500 outline-none focus:ring-1 disabled:opacity-60 dark:border-gray-600 dark:bg-gray-900 dark:text-white dark:placeholder-gray-400';

const labelClass: ClassList = 'mb-1.5 block text-sm font-medium text-gray-700 dark:text-gray-300';

const choiceClass = (selected: boolean): string[] => ['flex-1', 'cursor-pointer', 'rounded-xl', 'border', 'px-4', 'py-2.5', 'text-center', 'text-sm', 'font-medium', 'transition-all', 'duration-150', ...(selected ? ['border-primary-accent', 'bg-primary-accent/10', 'text-primary-accent', 'dark:bg-primary-accent/20'] : ['border-gray-300', 'text-gray-600', 'hover:border-gray-400', 'dark:border-gray-600', 'dark:text-gray-400', 'dark:hover:border-gray-500'])];

export interface VaultConnectionCurrent {
	mode: 'managed' | 'bitwarden';
	endpoints: { base: string; authentication: string } | null;
	project: string | null;
	/**
	 * `project`, resolved to its Bitwarden display name where possible. Falls back to the raw id (equal to `project`) if resolution failed - compare against `project` rather than checking truthiness to tell the two cases apart.
	 */
	projectName: string | null;
	jurisdiction: DOJurisdictions | null;
	canEdit: boolean;
}

interface VaultConnectionFieldsProps {
	current: VaultConnectionCurrent;
	isRunning: boolean;
}

/**
 * The vault picker from onboarding, re-rendered against a tenant that already has one.
 *
 * Everything here is a plain named `<input>`: the component owns no action and submits nothing itself, it just fills whichever `<Form>` wraps it. That keeps the route in charge of the request while this stays responsible for the one thing it can decide locally - what the customer is actually changing, and therefore which choices they have to make about their existing key material.
 *
 * The stored access token is never sent to the browser, so any change at all means re-entering it.
 */
export const VaultConnectionFields = component$<VaultConnectionFieldsProps>(({ current, isRunning }) => {
	const initialRegion = current.endpoints?.base === CLOUD_PRESETS.eu.base ? 'eu' : current.endpoints?.base === CLOUD_PRESETS.us.base ? 'us' : current.endpoints ? 'custom' : current.jurisdiction === DOJurisdictions['The European Union'] ? 'eu' : 'us';

	const vaultMode = useSignal<'managed' | 'bitwarden'>(current.mode);
	const bwRegion = useSignal<'us' | 'eu' | 'custom'>(initialRegion);
	const customBase = useSignal(initialRegion === 'custom' ? (current.endpoints?.base ?? '') : '');
	const customAuth = useSignal(initialRegion === 'custom' ? (current.endpoints?.authentication ?? '') : '');
	const baseEndpoint = useSignal(current.endpoints?.base ?? CLOUD_PRESETS[initialRegion === 'eu' ? 'eu' : 'us'].base);
	const authEndpoint = useSignal(current.endpoints?.authentication ?? CLOUD_PRESETS[initialRegion === 'eu' ? 'eu' : 'us'].auth);
	const apiKey = useSignal('');
	const project = useSignal(current.project ?? '');
	const strategy = useSignal('');
	const debounceTimer = useSignal(0);

	/**
	 * Moving between our vault and the customer's own always moves key material, whichever direction it goes.
	 */
	const modeChanged = useComputed$(() => vaultMode.value !== current.mode);

	/**
	 * Staying on a BYO vault but pointing at a different server or project. The keys don't follow on their own, so this needs answering too - unless the customer already moved them.
	 */
	const connectionChanged = useComputed$(() => vaultMode.value === 'bitwarden' && current.mode === 'bitwarden' && (baseEndpoint.value !== current.endpoints?.base || authEndpoint.value !== current.endpoints.authentication || project.value !== current.project));

	const needsApproval = useComputed$(() => modeChanged.value || connectionChanged.value);

	/**
	 * A managed vault has nothing to submit unless something about it changed; a BYO vault always has a token to re-set.
	 */
	const nothingToDo = useComputed$(() => !needsApproval.value && vaultMode.value === 'managed');

	const canSubmit = useComputed$(() => current.canEdit && !isRunning && !nothingToDo.value && (vaultMode.value !== 'bitwarden' || (Boolean(apiKey.value) && Boolean(project.value))) && (!needsApproval.value || Boolean(strategy.value)));

	// eslint-disable-next-line @typescript-eslint/unbound-method
	const projects = useResource$(({ track, cleanup }) => {
		const base = track(() => baseEndpoint.value);
		const auth = track(() => authEndpoint.value);
		const key = track(() => apiKey.value);
		const mode = track(() => vaultMode.value);

		if (mode !== 'bitwarden' || !base || !auth || !key) return Promise.resolve([]);

		cleanup(() => {
			window.clearTimeout(debounceTimer.value);
		});

		return new Promise<{ id: string; name: string }[]>((resolve, reject) => {
			debounceTimer.value = window.setTimeout(() => {
				getProjects(current.jurisdiction, base, auth, key).then(resolve).catch(reject);
			}, 600);
		});
	});

	return (
		<>
			{/* Where the keys live */}
			<div>
				<span class={labelClass}>{m.team_onboarding_vault_label()}</span>
				<p class="mb-2 text-xs text-gray-400 dark:text-gray-500">{m.team_onboarding_vault_help()}</p>
				<div class="flex gap-2">
					{(['managed', 'bitwarden'] as const).map((mode) => (
						<label key={mode} class={choiceClass(vaultMode.value === mode)}>
							<input
								type="radio"
								name="vaultMode"
								value={mode}
								checked={vaultMode.value === mode}
								disabled={!current.canEdit}
								class="hidden"
								onChange$={() => {
									vaultMode.value = mode;
									// A change of mode always needs an explicit answer about the existing keys, so never carry a stale one over
									strategy.value = '';
									if (mode === 'bitwarden') {
										if (bwRegion.value === 'custom') {
											baseEndpoint.value = customBase.value;
											authEndpoint.value = customAuth.value;
										} else {
											baseEndpoint.value = CLOUD_PRESETS[bwRegion.value].base;
											authEndpoint.value = CLOUD_PRESETS[bwRegion.value].auth;
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
									disabled={!current.canEdit}
									class={[...choiceClass(bwRegion.value === region), 'py-2']}
									onClick$={() => {
										bwRegion.value = region;
										if (region === 'custom') {
											baseEndpoint.value = customBase.value;
											authEndpoint.value = customAuth.value;
										} else {
											baseEndpoint.value = CLOUD_PRESETS[region].base;
											authEndpoint.value = CLOUD_PRESETS[region].auth;
										}
										strategy.value = '';
									}}>
									{region === 'us' ? m.team_onboarding_region_us() : region === 'eu' ? m.team_onboarding_region_eu() : m.team_onboarding_region_custom()}
								</button>
							))}
						</div>
						<p class="mt-2 text-xs text-gray-400 dark:text-gray-500">{bwRegion.value === 'custom' ? m.team_onboarding_region_custom_hint() : m.team_onboarding_region_cloud_hint()}</p>

						<div class="mt-3 flex flex-col gap-4 md:flex-row">
							<div class="flex-1">
								<label for="vault-base-endpoint" class={labelClass}>
									{m.team_onboarding_base_endpoint_label()}
								</label>
								<input
									id="vault-base-endpoint"
									name="baseCloudEndpoint"
									type="url"
									autoComplete="url"
									placeholder={m.team_onboarding_base_endpoint_placeholder()}
									class={[inputClass, 'font-mono', { 'cursor-not-allowed': bwRegion.value !== 'custom' }]}
									readOnly={bwRegion.value !== 'custom'}
									disabled={!current.canEdit}
									value={baseEndpoint.value}
									required
									onInput$={(_, el) => {
										customBase.value = el.value;
										baseEndpoint.value = el.value;
										strategy.value = '';
									}}
								/>
							</div>
							<div class="flex-1">
								<label for="vault-auth-endpoint" class={labelClass}>
									{m.team_onboarding_auth_endpoint_label()}
								</label>
								<input
									id="vault-auth-endpoint"
									name="authCloudEndpoint"
									type="url"
									autoComplete="url"
									placeholder={m.team_onboarding_auth_endpoint_placeholder()}
									class={[inputClass, 'font-mono', { 'cursor-not-allowed': bwRegion.value !== 'custom' }]}
									readOnly={bwRegion.value !== 'custom'}
									disabled={!current.canEdit}
									value={authEndpoint.value}
									required
									onInput$={(_, el) => {
										customAuth.value = el.value;
										authEndpoint.value = el.value;
										strategy.value = '';
									}}
								/>
							</div>
						</div>

						<div class="mt-3">
							<label for="vault-access-token" class={labelClass}>
								{m.team_onboarding_access_token_label()}
							</label>
							<input id="vault-access-token" name="accessToken" type="password" autoComplete="off" required disabled={!current.canEdit} placeholder={m.team_onboarding_access_token_placeholder()} class={[inputClass, 'font-mono']} onInput$={(_, el) => (apiKey.value = el.value)} />
							<p class="mt-1 text-xs text-gray-400 dark:text-gray-500">{m.vault_config_token_hint()}</p>
						</div>

						<div class="mt-3">
							<label for="vault-project" class={labelClass}>
								{m.team_onboarding_project_label()}
							</label>
							<Resource
								value={projects}
								onPending={() => (
									<select id="vault-project" name="project" disabled class={[inputClass, 'disabled:cursor-not-allowed']}>
										<option value="">{m.team_onboarding_projects_loading()}</option>
									</select>
								)}
								onRejected={(error) => (
									<>
										<select id="vault-project" name="project" disabled class={[inputClass, 'disabled:cursor-not-allowed']}>
											<option value="">{m.team_onboarding_projects_unable()}</option>
										</select>
										<p class="mt-1 text-xs text-red-500 dark:text-red-400">{error.message}</p>
									</>
								)}
								onResolved={(resolved) =>
									resolved.length > 0 ? (
										<>
											<select
												id="vault-project"
												name="project"
												class={inputClass}
												required
												disabled={!current.canEdit}
												onChange$={(_, el) => {
													project.value = el.value;
													strategy.value = '';
												}}>
												{resolved.map(({ id, name }) => (
													<option selected={id === project.value} key={id} value={id}>
														{name}
													</option>
												))}
											</select>
											<p class="mt-1 text-xs text-gray-400 dark:text-gray-500">{resolved.length === 1 ? m.team_onboarding_project_found_singular() : m.team_onboarding_project_found_plural()}</p>
										</>
									) : (
										/* Nothing to list yet - keep the tenant's existing project selected so a token-only change is still submittable */
										<>
											<select id="vault-project" name="project" class={inputClass} disabled={!current.canEdit || !current.project} required>
												{/* `projectName` falls back to the bare id when resolution failed, in which case it's identical to `project` and showing it twice would be redundant */}
												{current.project ? <option value={current.project}>{current.projectName && current.projectName !== current.project ? `${current.projectName} (${current.project})` : current.project}</option> : <option value="">{m.team_onboarding_projects_enter_credentials()}</option>}
											</select>
											<p class="mt-1 text-xs text-gray-400 dark:text-gray-500">{m.team_onboarding_projects_available_hint()}</p>
										</>
									)
								}
							/>
						</div>
					</>
				)}
			</div>

			{/* What this change means for the keys that already exist */}
			<div class="dark:border-surface-dark/60 mt-5 rounded-xl border border-gray-200/80 p-4">
				{needsApproval.value ? (
					<>
						<p class="text-sm font-semibold text-gray-900 dark:text-white">{m.vault_config_strategy_title()}</p>
						<p class="mt-1 text-xs text-gray-500 dark:text-gray-400">{modeChanged.value ? m.vault_config_change_mode() : m.vault_config_change_connection()}</p>

						<div class="mt-3 flex flex-col gap-2">
							{/* Only offered when the vault itself isn't changing: "I already moved them" can't be true of a vault the keys were never in */}
							{(modeChanged.value ? (['transfer', 'delete'] as const) : (['manual', 'transfer', 'delete'] as const)).map((option) => (
								<label key={option} class={['flex', 'cursor-pointer', 'items-start', 'gap-3', 'rounded-xl', 'border', 'p-3', 'text-left', 'transition-all', 'duration-150', ...(strategy.value === option ? ['border-primary-accent', 'bg-primary-accent/10', 'dark:bg-primary-accent/20'] : ['border-gray-300', 'hover:border-gray-400', 'dark:border-gray-600', 'dark:hover:border-gray-500'])]}>
									<input type="radio" name="strategy" value={option} checked={strategy.value === option} disabled={!current.canEdit} class="mt-1" onChange$={() => (strategy.value = option)} />
									<span>
										<span class="block text-sm font-medium text-gray-900 dark:text-white">{option === 'manual' ? m.vault_config_strategy_manual() : option === 'transfer' ? m.vault_config_strategy_transfer() : m.vault_config_strategy_delete()}</span>
										<span class="block text-xs text-gray-500 dark:text-gray-400">{option === 'manual' ? m.vault_config_strategy_manual_hint() : option === 'transfer' ? m.vault_config_strategy_transfer_hint() : m.vault_config_strategy_delete_hint()}</span>
									</span>
								</label>
							))}
						</div>

						{strategy.value === 'transfer' || strategy.value === 'delete' ? (
							<>
								<p class="mt-3 text-xs text-amber-600 dark:text-amber-400">{strategy.value === 'delete' ? m.vault_config_approval_notice_delete() : m.vault_config_approval_notice_transfer()}</p>
								{/* `transfer` and `delete` both run the atomic copy-on-write migration, and that always means a new tenant id underneath - this is the one cost of that design worth surfacing before anyone approves it */}
								<p class="mt-2 text-xs text-amber-600 dark:text-amber-400">{m.vault_config_new_id_notice()}</p>
							</>
						) : null}
					</>
				) : (
					<>
						{/* Submitted as a hidden field rather than inferred server-side, so the request always says which of the four paths it believes it is on */}
						<input type="hidden" name="strategy" value="token" />
						<p class="text-xs text-gray-500 dark:text-gray-400">{nothingToDo.value ? m.vault_config_change_none() : m.vault_config_change_token()}</p>
					</>
				)}
			</div>

			{current.canEdit ? (
				<button type="submit" disabled={!canSubmit.value} class="bg-primary-accent hover:bg-primary-accent/85 hover:shadow-primary-accent/25 mt-5 inline-flex cursor-pointer items-center justify-center gap-2 rounded-xl px-4 py-2.5 text-sm font-medium text-white transition-all duration-150 hover:shadow-md active:scale-[0.98] disabled:cursor-not-allowed disabled:opacity-60">
					{isRunning ? (
						<>
							<LuLoader class="h-4 w-4 animate-spin" />
							{m.vault_config_saving()}
						</>
					) : needsApproval.value ? (
						m.vault_config_submit_approval()
					) : (
						m.vault_config_submit()
					)}
				</button>
			) : (
				<p class="mt-5 text-xs text-amber-600 dark:text-amber-400">{m.vault_config_needs_write()}</p>
			)}
		</>
	);
});
