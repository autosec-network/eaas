import type { Session } from '@auth/qwik';
import { $, Resource, component$, getLocale, useComputed$, useSignal, useStore, useVisibleTask$ } from '@builder.io/qwik';
import { Form, routeAction$, routeLoader$, z, zod$ } from '@builder.io/qwik-city';
import * as rootSchema from 'db/schemas/root';
import * as tenantSchema from 'db/schemas/tenant/main';
import type { DrizzleD1Database } from 'drizzle-orm/d1';
import { and, asc, desc, eq, sql } from 'drizzle-orm/sql';
import type { SqliteRemoteDatabase } from 'drizzle-orm/sqlite-proxy';
import { createApiKey as createApiKeyHelper } from 'helpers';
import { Buffer } from 'node:buffer';
import { Permissions } from 'types';
import { usePermissions } from '~/routes/(team)/[tenantId]/layout';
import { useTimezone } from '~/routes/layout';

// eslint-disable-next-line @typescript-eslint/ban-ts-comment
// @ts-ignore this gets generated automatically later in the build process
import * as m from '~/paraglide/messages';

interface KeyringPolicyInput {
	kr_id_base64url: string;
	r_datakeys: Permissions;
	r_encrypt: boolean;
	r_decrypt: boolean;
	r_rewrap: boolean;
	r_sign: boolean;
	r_verify: boolean;
	r_hmac: boolean;
}

type ApiKeyRowWithPolicies = Omit<typeof tenantSchema.api_keys.$inferSelect, 'ak_id' | 'hash'> & {
	ak_id: {
		hex: string;
		base64: string;
		base64url: string;
	};
	keyring_policies: KeyringPolicyInput[];
};

const toDatetimeLocal = (d: Date): string => {
	const parts = new Intl.DateTimeFormat(undefined, { year: 'numeric', month: '2-digit', day: '2-digit', hour: '2-digit', minute: '2-digit', hourCycle: 'h23' }).formatToParts(d);
	const get = (type: string) => parts.find((p) => p.type === type)!.value;
	return `${get('year')}-${get('month')}-${get('day')}T${get('hour')}:${get('minute')}`;
};

const keyringPolicySchema = z.object({
	kr_id_base64url: z.string().trim().length(22).base64url(),
	r_datakeys: z.coerce.number().int().min(1).max(3),
	r_encrypt: z.coerce.boolean(),
	r_decrypt: z.coerce.boolean(),
	r_rewrap: z.coerce.boolean(),
	r_sign: z.coerce.boolean(),
	r_verify: z.coerce.boolean(),
	r_hmac: z.coerce.boolean(),
});

const parseKeyringPoliciesJson = (rawJson: string): KeyringPolicyInput[] => {
	const parsed = JSON.parse(rawJson) as unknown;
	const validated = z.array(keyringPolicySchema).parse(parsed);
	const unique = new Map<string, KeyringPolicyInput>();

	validated.forEach((policy) => {
		unique.set(policy.kr_id_base64url, policy);
	});

	return Array.from(unique.values());
};

const defaultPolicyForKeyring = (kr_id_base64url: string): KeyringPolicyInput => ({
	kr_id_base64url,
	r_datakeys: Permissions.Read,
	r_encrypt: true,
	r_decrypt: false,
	r_rewrap: true,
	r_sign: true,
	r_verify: true,
	r_hmac: true,
});

const toPolicyInput = (row: typeof tenantSchema.api_keys_keyrings.$inferSelect): KeyringPolicyInput => ({
	kr_id_base64url: row.kr_id.toString('base64url'),
	r_datakeys: row.r_datakeys,
	r_encrypt: row.r_encrypt,
	r_decrypt: row.r_decrypt,
	r_rewrap: row.r_rewrap,
	r_sign: row.r_sign,
	r_verify: row.r_verify,
	r_hmac: row.r_hmac,
});

// eslint-disable-next-line qwik/loader-location
const useApiKeys = routeLoader$(({ sharedMap, resolveValue }) => async () => {
	const perms = await resolveValue(usePermissions);

	if (perms && perms.r_apikeys >= Permissions.Read) {
		const t_db = sharedMap.get('t_db') as SqliteRemoteDatabase;

		const [apiKeyRows, keyringPolicyRows] = await Promise.all([t_db.select().from(tenantSchema.api_keys).orderBy(desc(tenantSchema.api_keys.b_time)), t_db.select().from(tenantSchema.api_keys_keyrings)]);

		const policiesByAkId = keyringPolicyRows.reduce<Record<string, KeyringPolicyInput[]>>((acc, row) => {
			const akIdBase64url = row.ak_id.toString('base64url');
			const list = acc[akIdBase64url] ?? [];
			list.push(toPolicyInput(row));
			acc[akIdBase64url] = list;
			return acc;
		}, {});

		return apiKeyRows.map(
			(row) =>
				({
					...row,
					ak_id: {
						hex: row.ak_id.toString('hex'),
						base64: row.ak_id.toString('base64'),
						base64url: row.ak_id.toString('base64url'),
					},
					keyring_policies: policiesByAkId[row.ak_id.toString('base64url')] ?? [],
				}) satisfies ApiKeyRowWithPolicies,
		);
	} else {
		return [] as ApiKeyRowWithPolicies[];
	}
});

// eslint-disable-next-line qwik/loader-location
const useTenantKeyrings = routeLoader$(async ({ sharedMap, resolveValue }) => {
	const perms = await resolveValue(usePermissions);

	if (!perms || perms.r_apikeys < Permissions.Read) {
		return [] as (Pick<typeof tenantSchema.keyrings.$inferSelect, 'name'> & { kr_id_base64url: string })[];
	}

	const t_db = sharedMap.get('t_db') as SqliteRemoteDatabase;
	const rows = await t_db.select().from(tenantSchema.keyrings).orderBy(asc(tenantSchema.keyrings.name));

	return rows.map((row) => ({
		name: row.name,
		kr_id_base64url: row.kr_id.toString('base64url'),
	}));
});

const uuidBase64urlSchema = z.string().trim().length(22).base64url();

const getYourApiKeyPermission = (sharedMap: Map<string, unknown>): Promise<Permissions> => {
	const t_db = sharedMap.get('t_db') as SqliteRemoteDatabase;
	const session = sharedMap.get('session') as Session;

	return t_db
		.select({ r_apikeys: tenantSchema.users.r_apikeys })
		.from(tenantSchema.users)
		.where(and(eq(tenantSchema.users.u_id, sql`unhex(${session.user?.u_id.hex})`), eq(tenantSchema.users.approved, true)))
		.limit(1)
		.then(([you]) => you?.r_apikeys ?? Permissions.None);
};

// eslint-disable-next-line qwik/loader-location
const useCreateApiKey = routeAction$(
	async (data, { sharedMap, fail }) => {
		const yourPerm = await getYourApiKeyPermission(sharedMap as Map<string, unknown>);

		if (yourPerm >= Permissions.Write) {
			const now = new Date();
			const createdApiKey = await createApiKeyHelper();
			const expires = new Date(data.expires);

			await Promise.all([
				(() => {
					const r_db = sharedMap.get('r_db') as DrizzleD1Database;
					const t_id_hex = sharedMap.get('t_id_hex') as string;

					return r_db.insert(rootSchema.api_keys_tenants).values({
						ak_id: sql`unhex(${createdApiKey.ak_id.hex})`,
						t_id: sql`unhex(${t_id_hex})`,
						expires,
					});
				})(),
				(() => {
					const t_db = sharedMap.get('t_db') as SqliteRemoteDatabase;

					return t_db.insert(tenantSchema.api_keys).values({
						ak_id: sql`unhex(${createdApiKey.ak_id.hex})`,
						name: data.name,
						hash: sql`unhex(${createdApiKey.ak_secret_hash.hex})`,
						last_identifier: createdApiKey.token.slice(-4),
						expires,
						b_time: now,
						c_time: now,
						m_time: now,
						r_keyrings: data.r_keyrings,
						r_apikeys: data.r_apikeys,
					});
				})(),
			]);

			return {
				success: true,
				token: createdApiKey.token,
				ak_id_base64url: createdApiKey.ak_id.base64url,
			};
		} else {
			return fail(403, { message: 'Insufficient permissions' });
		}
	},
	zod$(
		z.object({
			name: z.string().trim().nonempty(),
			expires: z.string().trim().nonempty().datetime({ local: false, offset: false, precision: 3 }),
			r_keyrings: z.coerce.number().int().min(0).max(3),
			r_apikeys: z.coerce.number().int().min(0).max(3),
		}),
	),
);

// eslint-disable-next-line qwik/loader-location
const useEditApiKey = routeAction$(
	async (data, { sharedMap, fail }) => {
		const yourPerm = await getYourApiKeyPermission(sharedMap as Map<string, unknown>);

		if (yourPerm < Permissions.Write) {
			return fail(403, { message: 'Insufficient permissions' });
		}

		const t_db = sharedMap.get('t_db') as SqliteRemoteDatabase;
		const akIdHex = Buffer.from(data.ak_id_base64url, 'base64url').toString('hex');
		const expires = new Date(data.expires);

		await t_db
			.update(tenantSchema.api_keys)
			.set({
				name: data.name,
				expires,
				r_keyrings: data.r_keyrings,
				r_apikeys: data.r_apikeys,
				c_time: new Date(),
			})
			.where(eq(tenantSchema.api_keys.ak_id, sql`unhex(${akIdHex})`));

		return {
			success: true,
		};
	},
	zod$(
		z.object({
			ak_id_base64url: uuidBase64urlSchema,
			name: z.string().trim().nonempty(),
			expires: z.string().trim().nonempty().datetime({ local: false, offset: false, precision: 3 }),
			r_keyrings: z.coerce.number().int().min(0).max(3),
			r_apikeys: z.coerce.number().int().min(0).max(3),
		}),
	),
);

// eslint-disable-next-line qwik/loader-location
const useSaveApiKeyKeyringPolicies = routeAction$(
	async (data, { sharedMap, fail }) => {
		const yourPerm = await getYourApiKeyPermission(sharedMap as Map<string, unknown>);

		if (yourPerm < Permissions.Write) {
			return fail(403, { message: 'Insufficient permissions' });
		}

		const t_db = sharedMap.get('t_db') as SqliteRemoteDatabase;
		const akIdHex = Buffer.from(data.ak_id_base64url, 'base64url').toString('hex');
		const keyringPolicies = parseKeyringPoliciesJson(data.keyring_policies);

		await t_db.delete(tenantSchema.api_keys_keyrings).where(eq(tenantSchema.api_keys_keyrings.ak_id, sql`unhex(${akIdHex})`));

		if (keyringPolicies.length > 0) {
			await t_db.insert(tenantSchema.api_keys_keyrings).values(
				keyringPolicies.map((policy) => ({
					ak_id: sql`unhex(${akIdHex})`,
					kr_id: sql`unhex(${Buffer.from(policy.kr_id_base64url, 'base64url').toString('hex')})`,
					r_datakeys: policy.r_datakeys,
					r_encrypt: policy.r_encrypt,
					r_decrypt: policy.r_decrypt,
					r_rewrap: policy.r_rewrap,
					r_sign: policy.r_sign,
					r_verify: policy.r_verify,
					r_hmac: policy.r_hmac,
				})),
			);
		}

		return { success: true };
	},
	zod$(
		z.object({
			ak_id_base64url: uuidBase64urlSchema,
			keyring_policies: z.string().trim().default('[]'),
		}),
	),
);

// eslint-disable-next-line qwik/loader-location
const useRotateApiKey = routeAction$(
	async (data, { sharedMap, fail }) => {
		const yourPerm = await getYourApiKeyPermission(sharedMap as Map<string, unknown>);

		if (yourPerm < Permissions.Write) {
			return fail(403, { message: 'Insufficient permissions' });
		}

		const t_db = sharedMap.get('t_db') as SqliteRemoteDatabase;
		const now = new Date();
		const createdApiKey = await createApiKeyHelper(Buffer.from(data.ak_id_base64url, 'base64url').toString('hex'));
		const [, , secretBase64url = ''] = createdApiKey.token.split('.');

		if (secretBase64url.length < 4) {
			return fail(500, { message: 'Generated API key secret is invalid' });
		}

		await t_db
			.update(tenantSchema.api_keys)
			.set({
				hash: sql`unhex(${createdApiKey.ak_secret_hash.hex})`,
				last_identifier: secretBase64url.slice(-4),
				m_time: now,
			})
			.where(eq(tenantSchema.api_keys.ak_id, sql`unhex(${createdApiKey.ak_id.hex})`));

		return {
			success: true,
			token: createdApiKey.token,
		};
	},
	zod$(
		z.object({
			ak_id_base64url: uuidBase64urlSchema,
		}),
	),
);

// eslint-disable-next-line qwik/loader-location
const useDeleteApiKey = routeAction$(
	async (data, { sharedMap, fail }) => {
		const yourPerm = await getYourApiKeyPermission(sharedMap as Map<string, unknown>);

		if (yourPerm < Permissions.Admin) {
			return fail(403, { message: 'Insufficient permissions' });
		}

		const t_db = sharedMap.get('t_db') as SqliteRemoteDatabase;
		const akHex = Buffer.from(data.ak_id_base64url, 'base64url').toString('hex');

		const [exists] = await t_db
			.select({ ak_id: tenantSchema.api_keys.ak_id })
			.from(tenantSchema.api_keys)
			.where(eq(tenantSchema.api_keys.ak_id, sql`unhex(${akHex})`))
			.limit(1);

		if (!exists) {
			return fail(404, { message: 'API key not found' });
		}

		await t_db.delete(tenantSchema.api_keys).where(eq(tenantSchema.api_keys.ak_id, sql`unhex(${akHex})`));

		return {
			success: true,
		};
	},
	zod$(
		z.object({
			ak_id_base64url: uuidBase64urlSchema,
		}),
	),
);

const fieldClass = 'w-full rounded-lg border border-gray-300 bg-white px-2 py-1.5 text-xs text-gray-900 outline-none dark:border-gray-600 dark:bg-gray-900 dark:text-white';
const buttonClass = 'rounded-lg px-3 py-1.5 text-xs font-medium transition-all duration-150 active:scale-[0.98]';

export default component$(() => {
	const locale = getLocale();
	const timezone = useTimezone();
	const userPermissions = usePermissions();
	const apiKeys = useApiKeys();
	const tenantKeyrings = useTenantKeyrings();
	const createApiKey = useCreateApiKey();
	const editApiKey = useEditApiKey();
	const saveApiKeyKeyringPolicies = useSaveApiKeyKeyringPolicies();
	const rotateApiKey = useRotateApiKey();
	const deleteApiKey = useDeleteApiKey();
	const editKeyringPoliciesJson = useStore<Record<string, string>>({});
	const expiresValue = useSignal('');
	const expiresIsoValue = useComputed$(() => {
		const raw = expiresValue.value;
		if (!raw) return '';
		const d = new Date(raw);
		return Number.isNaN(d.getTime()) ? '' : d.toISOString();
	});
	const editExpiresIso = useStore<Record<string, string>>({});
	const modalMode = useSignal<'create-persist' | 'edit'>('edit');
	const modalTargetAkId = useSignal<string | null>(null);
	const modalPolicies = useSignal<KeyringPolicyInput[]>([]);
	const modalToken = useSignal<string | null>(null);
	const copiedBannerKey = useSignal(false);
	const copiedModalKey = useSignal(false);

	// eslint-disable-next-line qwik/no-use-visible-task
	useVisibleTask$(() => {
		void import('flowbite').then(({ initModals }) => initModals());
	});

	// eslint-disable-next-line qwik/no-use-visible-task
	useVisibleTask$(({ track }) => {
		const result = track(() => createApiKey.value);
		if (result?.success && result.ak_id_base64url && result.token) {
			document.getElementById('hide-create-modal')?.click();
			void openCreateKeyringModal(result.ak_id_base64url, result.token);
		}
	});

	const openCreateKeyringModal = $((akIdBase64url: string | undefined, token?: string) => {
		if (!akIdBase64url) return;
		modalMode.value = 'create-persist';
		modalTargetAkId.value = akIdBase64url;
		modalToken.value = token ?? null;
		modalPolicies.value = [];
		document.getElementById('show-keyring-modal')?.click();
	});

	const openEditKeyringModal = $((akIdBase64url: string, fallbackPolicies: KeyringPolicyInput[]) => {
		modalMode.value = 'edit';
		modalTargetAkId.value = akIdBase64url;
		modalPolicies.value = parseKeyringPoliciesJson(editKeyringPoliciesJson[akIdBase64url] ?? JSON.stringify(fallbackPolicies));
		document.getElementById('show-keyring-modal')?.click();
	});

	const upsertPolicy = $((policy: KeyringPolicyInput) => {
		const found = modalPolicies.value.find((item) => item.kr_id_base64url === policy.kr_id_base64url);
		if (found) {
			modalPolicies.value = modalPolicies.value.map((item) => (item.kr_id_base64url === policy.kr_id_base64url ? policy : item));
		} else {
			modalPolicies.value = [...modalPolicies.value, policy];
		}
	});

	const removePolicy = $((kr_id_base64url: string) => {
		modalPolicies.value = modalPolicies.value.filter((item) => item.kr_id_base64url !== kr_id_base64url);
	});

	const saveKeyringPolicyModal = $(async () => {
		const json = JSON.stringify(modalPolicies.value);
		if (modalMode.value === 'edit' && modalTargetAkId.value) {
			editKeyringPoliciesJson[modalTargetAkId.value] = json;
			document.getElementById('hide-keyring-modal')?.click();
			return;
		}

		if (modalMode.value === 'create-persist' && modalTargetAkId.value) {
			await saveApiKeyKeyringPolicies.submit({
				ak_id_base64url: modalTargetAkId.value,
				keyring_policies: json,
			});
			modalToken.value = null;
			document.getElementById('hide-keyring-modal')?.click();
		}
	});

	return (
		<div class="mx-auto w-full max-w-7xl px-6 py-10">
			<div class="mb-8 flex items-start justify-between gap-4">
				<div>
					<h1 class="text-2xl font-bold tracking-tight text-gray-900 dark:text-white">{m.users_permission_apikeys()}</h1>
					<p class="mt-1 text-sm text-gray-500 dark:text-gray-400">{m.apikeys_page_subtitle()}</p>
				</div>
				{userPermissions.value && userPermissions.value.r_apikeys >= Permissions.Write ? (
					<button type="button" data-modal-target="create-api-key-modal" data-modal-toggle="create-api-key-modal" class={[buttonClass, 'bg-primary-accent hover:bg-primary-accent/85 text-white']}>
						+ New
					</button>
				) : null}
			</div>

			{createApiKey.value?.success && createApiKey.value.token ? (
				<div class="mb-6 rounded-xl border border-amber-300 bg-amber-50 p-4 text-sm text-amber-900 dark:border-amber-800 dark:bg-amber-950/40 dark:text-amber-200">
					<div class="mb-2 flex items-center justify-between gap-2">
						<p class="font-semibold">{m.apikeys_banner_new_title()}</p>
						<button
							type="button"
							class="rounded border border-amber-400 px-2 py-0.5 text-xs font-medium text-amber-800 hover:bg-amber-100 dark:border-amber-700 dark:text-amber-300 dark:hover:bg-amber-900/40"
							onClick$={async () => {
								await navigator.clipboard.writeText(createApiKey.value?.token ?? '');
								copiedBannerKey.value = true;
								setTimeout(() => (copiedBannerKey.value = false), 2000);
							}}>
							{copiedBannerKey.value ? m.common_copied() : m.common_copy()}
						</button>
					</div>
					<pre class="overflow-x-auto rounded-lg bg-black/10 p-2 text-xs dark:bg-white/10">{createApiKey.value.token}</pre>
				</div>
			) : null}

			{rotateApiKey.value?.success && rotateApiKey.value.token ? (
				<div class="mb-6 rounded-xl border border-amber-300 bg-amber-50 p-4 text-sm text-amber-900 dark:border-amber-800 dark:bg-amber-950/40 dark:text-amber-200">
					<p class="mb-2 font-semibold">{m.apikeys_banner_rotated_title()}</p>
					<pre class="overflow-x-auto rounded-lg bg-black/10 p-2 text-xs dark:bg-white/10">{rotateApiKey.value.token}</pre>
				</div>
			) : null}

			<div class="border-surface-light/60 dark:border-surface-dark/60 dark:bg-surface-dark/70 overflow-x-auto rounded-2xl border bg-white/70 shadow-sm backdrop-blur-md">
				<Resource
					value={apiKeys}
					onPending={() => (
						<div class="space-y-3 p-4">
							<div class="h-12 animate-pulse rounded-xl bg-gray-200 dark:bg-gray-700" />
							<div class="h-12 animate-pulse rounded-xl bg-gray-200 dark:bg-gray-700" />
						</div>
					)}
					onResolved={(rows) =>
						rows.length < 1 ? (
							<div class="p-4 text-sm text-gray-500 dark:text-gray-400">{m.apikeys_empty()}</div>
						) : (
							<ul class="divide-surface-light/60 dark:divide-surface-dark/60 divide-y">
								{rows.map((row) => (
									<li key={row.ak_id.base64} class="p-4">
										<div class="mb-2 flex items-center justify-between gap-2">
											<div>
												<p class="text-sm font-semibold text-gray-900 dark:text-white">{row.name}</p>
												<p class="text-xs text-gray-500 dark:text-gray-400">****{row.last_identifier}</p>
											</div>
											<div class="text-right text-xs text-gray-500 dark:text-gray-400">
												<p>
													{m.apikeys_label_created()}{' '}
													<time dateTime={row.b_time.toISOString()} title={`${row.b_time.toLocaleString(locale, { hour12: false, timeZone: 'UTC' })} UTC`}>
														{`${row.b_time.toLocaleString(locale, { timeZone: timezone.value.long })} ${timezone.value.short}`}
													</time>
												</p>
												{row.a_time ? (
													<p>
														{m.apikeys_label_used()}{' '}
														<time dateTime={row.a_time.toISOString()} title={`${row.a_time.toLocaleString(locale, { hour12: false, timeZone: 'UTC' })} UTC`}>
															{`${row.a_time.toLocaleString(locale, { timeZone: timezone.value.long })} ${timezone.value.short}`}
														</time>
													</p>
												) : null}
												<p>
													{m.apikeys_label_expires()}{' '}
													<time dateTime={row.expires.toISOString()} title={`${row.expires.toLocaleString(locale, { hour12: false, timeZone: 'UTC' })} UTC`}>
														{`${row.expires.toLocaleString(locale, { timeZone: timezone.value.long })} ${timezone.value.short}`}
													</time>
												</p>
											</div>
										</div>

										<div class="flex flex-col gap-2 md:flex-row md:items-end md:gap-3">
											{userPermissions.value && userPermissions.value.r_apikeys >= Permissions.Write ? (
												<Form action={editApiKey} class="flex flex-1 flex-col gap-2 md:flex-row md:items-end md:gap-2">
													<input type="hidden" name="ak_id_base64url" value={row.ak_id.base64url} />
													<input type="hidden" name="keyring_policies" value={editKeyringPoliciesJson[row.ak_id.base64url] ?? JSON.stringify(row.keyring_policies)} />
													<label class="flex-1 text-xs text-gray-600 dark:text-gray-300">
														{m.apikeys_field_name()}
														<input name="name" class={fieldClass} required minLength={2} maxLength={120} value={row.name} />
													</label>
													<label class="flex-1 text-xs text-gray-600 dark:text-gray-300">
														{m.apikeys_field_expires_utc()}
														<input
															type="datetime-local"
															required
															class={fieldClass}
															value={toDatetimeLocal(new Date(row.expires))}
															onChange$={(_, el) => {
																editExpiresIso[row.ak_id.base64url] = el.value ? new Date(el.value).toISOString() : '';
															}}
														/>
														<input type="hidden" name="expires" value={editExpiresIso[row.ak_id.base64url] ?? new Date(row.expires).toISOString()} />
													</label>
													<label class="w-full text-xs text-gray-600 md:w-28 dark:text-gray-300">
														{m.users_permission_keyring()}
														<select name="r_keyrings" class={fieldClass} value={String(row.r_keyrings)}>
															<option value={Permissions.None}>{m.users_role_none()}</option>
															<option value={Permissions.Read}>{m.users_role_read()}</option>
															<option value={Permissions.Write}>{m.users_role_write()}</option>
															<option value={Permissions.Admin}>{m.users_role_admin()}</option>
														</select>
													</label>
													<label class="w-full text-xs text-gray-600 md:w-28 dark:text-gray-300">
														{m.users_permission_apikeys()}
														<select name="r_apikeys" class={fieldClass} value={String(row.r_apikeys)}>
															<option value={Permissions.None}>{m.users_role_none()}</option>
															<option value={Permissions.Read}>{m.users_role_read()}</option>
															<option value={Permissions.Write}>{m.users_role_write()}</option>
															<option value={Permissions.Admin}>{m.users_role_admin()}</option>
														</select>
													</label>
													<button type="button" class={[buttonClass, 'border border-gray-300 text-gray-700 hover:bg-gray-100 dark:border-gray-600 dark:text-gray-200 dark:hover:bg-gray-800']} onClick$={() => openEditKeyringModal(row.ak_id.base64url, row.keyring_policies)}>
														{m.apikeys_configure_keyrings_btn()}
													</button>
													<button type="submit" class={[buttonClass, 'border border-gray-300 text-gray-700 hover:bg-gray-100 dark:border-gray-600 dark:text-gray-200 dark:hover:bg-gray-800']}>
														{m.common_save()}
													</button>
												</Form>
											) : null}

											{userPermissions.value && userPermissions.value.r_apikeys >= Permissions.Write ? (
												<Form action={rotateApiKey}>
													<input type="hidden" name="ak_id_base64url" value={row.ak_id.base64url} />
													<button type="submit" class={[buttonClass, 'border border-amber-300 text-amber-700 hover:bg-amber-100 dark:border-amber-800 dark:text-amber-300 dark:hover:bg-amber-900/40']}>
														{m.apikeys_rotate_btn()}
													</button>
												</Form>
											) : null}

											{userPermissions.value && userPermissions.value.r_apikeys >= Permissions.Admin ? (
												<Form action={deleteApiKey}>
													<input type="hidden" name="ak_id_base64url" value={row.ak_id.base64url} />
													<button type="submit" class={[buttonClass, 'border border-red-300 text-red-700 hover:bg-red-100 dark:border-red-800 dark:text-red-300 dark:hover:bg-red-900/40']}>
														{m.common_delete()}
													</button>
												</Form>
											) : null}
										</div>
										<p class="mt-2 text-xs text-gray-500 dark:text-gray-400">{m.apikeys_keyring_block_count({ count: (editKeyringPoliciesJson[row.ak_id.base64url] ? parseKeyringPoliciesJson(editKeyringPoliciesJson[row.ak_id.base64url]!) : row.keyring_policies).length })}</p>
									</li>
								))}
							</ul>
						)
					}
					onRejected={(error) =>
						error instanceof Error ? (
							<p class="p-4 text-red-600">
								{m.common_error_label()} {error.message}
							</p>
						) : (
							<pre class="p-4 text-red-600">{JSON.stringify(error, null, '\t')}</pre>
						)
					}
				/>
			</div>

			<div id="create-api-key-modal" tabIndex={-1} aria-hidden="true" class="fixed top-0 right-0 left-0 z-50 hidden h-[calc(100%-1rem)] max-h-full w-full items-center justify-center overflow-x-hidden overflow-y-auto md:inset-0">
				<div class="relative max-h-full w-full max-w-3xl p-4">
					<div class="relative rounded-lg bg-white shadow-sm dark:bg-gray-700">
						<div class="flex items-center justify-between rounded-t border-b border-gray-200 p-4 md:p-5 dark:border-gray-600">
							<div>
								<h3 class="text-lg font-semibold text-gray-900 dark:text-white">{m.apikeys_create_title()}</h3>
								<p class="text-sm text-gray-500 dark:text-gray-400">{m.apikeys_create_step1_subtitle()}</p>
							</div>
							<button type="button" data-modal-hide="create-api-key-modal" class="ms-auto rounded-lg bg-transparent px-2 py-1 text-sm font-medium text-gray-400 hover:bg-gray-200 hover:text-gray-900 dark:hover:bg-gray-600 dark:hover:text-white">
								{m.common_discard()}
							</button>
						</div>

						<Form action={createApiKey}>
							<div class="space-y-4 p-4 md:p-5">
								<div class="flex flex-col gap-3 md:flex-row">
									<label class="flex-1 text-sm text-gray-600 dark:text-gray-300">
										{m.apikeys_field_name()}
										<input name="name" required minLength={2} maxLength={120} class={fieldClass} />
										<span class="mt-1 block text-xs text-gray-500 dark:text-gray-400">{m.apikeys_name_hint()}</span>
									</label>
									<label class="flex-1 text-sm text-gray-600 dark:text-gray-300">
										{m.apikeys_field_expiration()}
										<input type="datetime-local" required class={fieldClass} bind:value={expiresValue} />
										<input type="hidden" name="expires" value={expiresIsoValue.value} />
										<span class="mt-1.5 flex flex-wrap gap-1">
											<button type="button" class="text-2xs rounded border border-gray-300 px-1.5 py-0.5 text-gray-600 hover:bg-gray-100 dark:border-gray-600 dark:text-gray-300 dark:hover:bg-gray-800" onClick$={() => (expiresValue.value = toDatetimeLocal(new Date(Date.now() + 30 * 86_400_000)))}>
												{m.apikeys_chip_30d()}
											</button>
											<button type="button" class="text-2xs rounded border border-gray-300 px-1.5 py-0.5 text-gray-600 hover:bg-gray-100 dark:border-gray-600 dark:text-gray-300 dark:hover:bg-gray-800" onClick$={() => (expiresValue.value = toDatetimeLocal(new Date(Date.now() + 90 * 86_400_000)))}>
												{m.apikeys_chip_90d()}
											</button>
											<button type="button" class="text-2xs rounded border border-gray-300 px-1.5 py-0.5 text-gray-600 hover:bg-gray-100 dark:border-gray-600 dark:text-gray-300 dark:hover:bg-gray-800" onClick$={() => (expiresValue.value = toDatetimeLocal(new Date(Date.now() + 365 * 86_400_000)))}>
												{m.apikeys_chip_1y()}
											</button>
										</span>
										<span class="mt-1 block text-xs text-gray-500 dark:text-gray-400">{m.apikeys_expiration_hint()}</span>
									</label>
								</div>
								<div class="flex flex-col gap-3 md:flex-row">
									<label class="flex-1 text-sm text-gray-600 dark:text-gray-300">
										{m.apikeys_field_r_keyrings()}
										<select name="r_keyrings" class={fieldClass} value={String(Number(tenantSchema.api_keys.r_keyrings.default ?? 0))}>
											<option value={Permissions.None}>{m.apikeys_perm_keyrings_none()}</option>
											<option value={Permissions.Read}>{m.apikeys_perm_keyrings_read()}</option>
											<option value={Permissions.Write}>{m.apikeys_perm_keyrings_write()}</option>
											<option value={Permissions.Admin}>{m.apikeys_perm_keyrings_admin()}</option>
										</select>
										<span class="mt-1 block text-xs text-gray-500 dark:text-gray-400">{m.apikeys_r_keyrings_hint()}</span>
									</label>
									<label class="flex-1 text-sm text-gray-600 dark:text-gray-300">
										{m.apikeys_field_r_apikeys()}
										<select name="r_apikeys" class={fieldClass} value={String(Number(tenantSchema.api_keys.r_apikeys.default ?? 0))}>
											<option value={Permissions.None}>{m.apikeys_perm_apikeys_none()}</option>
											<option value={Permissions.Read}>{m.apikeys_perm_apikeys_read()}</option>
											<option value={Permissions.Write}>{m.apikeys_perm_apikeys_write()}</option>
											<option value={Permissions.Admin}>{m.apikeys_perm_apikeys_admin()}</option>
										</select>
										<span class="mt-1 block text-xs text-gray-500 dark:text-gray-400">{m.apikeys_r_apikeys_hint()}</span>
									</label>
								</div>
							</div>
							<div class="flex items-center justify-end space-x-3 rounded-b border-t border-gray-200 p-4 md:p-5 dark:border-gray-600">
								<button type="submit" class={[buttonClass, 'bg-primary-accent hover:bg-primary-accent/85 text-white']}>
									{m.apikeys_save_step1()}
								</button>
							</div>
						</Form>
					</div>
				</div>
			</div>

			<button id="show-keyring-modal" type="button" data-modal-target="keyring-policies-modal" data-modal-show="keyring-policies-modal" class="hidden" />
			<button id="hide-keyring-modal" type="button" data-modal-hide="keyring-policies-modal" class="hidden" />
			<button id="hide-create-modal" type="button" data-modal-hide="create-api-key-modal" class="hidden" />

			<div id="keyring-policies-modal" data-modal-backdrop="static" tabIndex={-1} aria-hidden="true" class="fixed top-0 right-0 left-0 z-50 hidden h-[calc(100%-1rem)] max-h-full w-full items-center justify-center overflow-x-hidden overflow-y-auto md:inset-0">
				<div class="relative max-h-[92dvh] w-full max-w-7xl p-4">
					<div class="relative flex max-h-[92dvh] flex-col overflow-hidden rounded-lg bg-white shadow-sm dark:bg-gray-700">
						<div class="flex items-center justify-between rounded-t border-b border-gray-200 p-4 md:p-5 dark:border-gray-600">
							<div>
								<h3 class="text-lg font-semibold text-gray-900 dark:text-white">{m.apikeys_keyrings_modal_title()}</h3>
								<p class="text-sm text-gray-500 dark:text-gray-400">{m.apikeys_keyrings_modal_subtitle()}</p>
							</div>
							<button type="button" data-modal-hide="keyring-policies-modal" class="ms-auto rounded-lg bg-transparent px-2 py-1 text-sm font-medium text-gray-400 hover:bg-gray-200 hover:text-gray-900 dark:hover:bg-gray-600 dark:hover:text-white">
								{modalMode.value === 'edit' ? m.common_cancel() : m.common_discard()}
							</button>
						</div>
						{modalToken.value ? (
							<div class="border-b border-amber-200 bg-amber-50 px-4 py-3 dark:border-amber-800 dark:bg-amber-950/30">
								<div class="mb-1.5 flex items-center justify-between gap-2">
									<p class="text-xs font-semibold text-amber-800 dark:text-amber-300">{m.apikeys_step1_complete_heading()}</p>
									<button
										type="button"
										class="rounded border border-amber-400 px-2 py-0.5 text-xs font-medium text-amber-800 hover:bg-amber-100 dark:border-amber-700 dark:text-amber-300 dark:hover:bg-amber-900/40"
										onClick$={async () => {
											await navigator.clipboard.writeText(modalToken.value ?? '');
											copiedModalKey.value = true;
											setTimeout(() => (copiedModalKey.value = false), 2000);
										}}>
										{copiedModalKey.value ? m.common_copied() : m.common_copy()}
									</button>
								</div>
								<pre class="overflow-x-auto rounded-lg bg-black/10 p-2 text-xs text-amber-900 dark:bg-white/10 dark:text-amber-200">{modalToken.value}</pre>
							</div>
						) : null}
						<div class="flex flex-1 gap-4 overflow-hidden p-4 md:p-5">
							<div class="w-full max-w-sm overflow-y-auto rounded-xl border border-gray-200 bg-gray-50 p-4 dark:border-gray-600 dark:bg-gray-800/50">
								<h4 class="mb-3 text-sm font-semibold text-gray-900 dark:text-white">{m.apikeys_permission_legend_title()}</h4>
								<div class="space-y-3 text-sm text-gray-600 dark:text-gray-300">
									<div>
										<p class="font-semibold">{m.apikeys_legend_keyrings_title()}</p>
										<p>{m.apikeys_legend_keyrings_body()}</p>
									</div>
									<div>
										<p class="font-semibold">{m.apikeys_legend_apikeys_title()}</p>
										<p>{m.apikeys_legend_apikeys_body()}</p>
									</div>
									<div>
										<p class="font-semibold">{m.apikeys_legend_datakeys_title()}</p>
										<p>{m.apikeys_legend_datakeys_body()}</p>
									</div>
									<div>
										<p class="font-semibold">{m.apikeys_legend_ops_title()}</p>
										<p>{m.apikeys_legend_ops_body()}</p>
									</div>
								</div>
							</div>

							<div class="flex-1 overflow-y-auto rounded-xl border border-gray-200 p-4 dark:border-gray-600">
								<div class="space-y-3">
									{tenantKeyrings.value.map((keyring) => {
										const policy = modalPolicies.value.find((item) => item.kr_id_base64url === keyring.kr_id_base64url);
										const enabled = Boolean(policy);

										return (
											<div key={keyring.kr_id_base64url} class="rounded-xl border border-gray-200 p-3 dark:border-gray-600">
												<div class="flex items-center justify-between gap-3">
													<div>
														<p class="text-sm font-semibold text-gray-900 dark:text-white">{keyring.name}</p>
														<p class="text-xs text-gray-500 dark:text-gray-400">{keyring.kr_id_base64url}</p>
													</div>
													<label class="inline-flex items-center gap-2 text-sm text-gray-700 dark:text-gray-300">
														<input
															type="checkbox"
															checked={enabled}
															onChange$={(event, target) => {
																if (target.checked) {
																	void upsertPolicy(defaultPolicyForKeyring(keyring.kr_id_base64url));
																} else {
																	void removePolicy(keyring.kr_id_base64url);
																}
																void event;
															}}
														/>
														{m.apikeys_link_keyring()}
													</label>
												</div>

												{policy ? (
													<div class="mt-3 flex flex-wrap gap-2">
														<label class="text-sm text-gray-600 dark:text-gray-300">
															{m.apikeys_field_datakeys()}
															<select
																class={fieldClass}
																value={String(policy.r_datakeys)}
																onChange$={(_, target) =>
																	void upsertPolicy({
																		...policy,
																		r_datakeys: parseInt(target.value, 10),
																	})
																}>
																<option value={Permissions.Read}>{m.apikeys_perm_datakeys_read()}</option>
																<option value={Permissions.Write}>{m.apikeys_perm_datakeys_write()}</option>
																<option value={Permissions.Admin}>{m.apikeys_perm_datakeys_admin()}</option>
															</select>
														</label>

														{(
															[
																['r_encrypt', m.apikeys_op_encrypt()],
																['r_decrypt', m.apikeys_op_decrypt()],
																['r_rewrap', m.apikeys_op_rewrap()],
																['r_sign', m.apikeys_op_sign()],
																['r_verify', m.apikeys_op_verify()],
																['r_hmac', m.apikeys_op_hmac()],
															] as [keyof Pick<KeyringPolicyInput, 'r_encrypt' | 'r_decrypt' | 'r_rewrap' | 'r_sign' | 'r_verify' | 'r_hmac'>, string][]
														).map(([flag, label]) => (
															<label key={flag} class="inline-flex items-center gap-2 rounded-lg border border-gray-200 px-2 py-1 text-sm text-gray-700 dark:border-gray-600 dark:text-gray-300">
																<input
																	type="checkbox"
																	checked={Boolean(policy[flag])}
																	onChange$={(_, target) =>
																		void upsertPolicy({
																			...policy,
																			[flag]: target.checked,
																		})
																	}
																/>
																{label}
															</label>
														))}
													</div>
												) : null}
											</div>
										);
									})}
								</div>
							</div>
						</div>

						<div class="flex items-center justify-between rounded-b border-t border-gray-200 p-4 md:p-5 dark:border-gray-600">
							<p class="text-xs text-gray-500 dark:text-gray-400">{m.apikeys_keyrings_linked({ count: modalPolicies.value.length })}</p>
							<div class="flex items-center space-x-3">
								<button type="button" data-modal-hide="keyring-policies-modal" class="rounded-lg border border-gray-200 bg-white px-5 py-2.5 text-sm font-medium text-gray-500 hover:bg-gray-100 hover:text-gray-900 focus:z-10 focus:ring-4 focus:ring-gray-100 focus:outline-none dark:border-gray-500 dark:bg-gray-700 dark:text-gray-300 dark:hover:bg-gray-600 dark:hover:text-white dark:focus:ring-gray-600">
									{m.common_cancel()}
								</button>
								<button type="button" class={[buttonClass, 'bg-primary-accent hover:bg-primary-accent/85 text-white']} onClick$={() => saveKeyringPolicyModal()}>
									{m.apikeys_save_keyrings()}
								</button>
							</div>
						</div>
					</div>
				</div>
			</div>
		</div>
	);
});
