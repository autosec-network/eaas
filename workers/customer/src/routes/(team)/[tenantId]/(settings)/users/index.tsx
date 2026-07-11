import type { Session } from '@auth/qwik';
import type { QRL } from '@builder.io/qwik';
import { $, component$, Resource, useSignal, useVisibleTask$ } from '@builder.io/qwik';
import { routeAction$, routeLoader$, z, zod$ } from '@builder.io/qwik-city';
import * as tenantSchema from 'db/schemas/tenant/main';
import type { DrizzleD1Database } from 'drizzle-orm/d1';
import { and, eq, ne, sql } from 'drizzle-orm/sql';
import type { SqliteRemoteDatabase } from 'drizzle-orm/sqlite-proxy';
import { Permissions } from 'types';
import type { ExtractKeysWithPrefix } from 'types/tenants';
import * as zm from 'zod/mini';
import UserRow from '~/components/team/user-row/user-row';
import { usePermissions } from '~/routes/(team)/[tenantId]/layout';

// eslint-disable-next-line @typescript-eslint/ban-ts-comment
// @ts-ignore this gets generated automatically later in the build process
import * as m from '~/paraglide/messages';

type UserRoles = NonNullable<ExtractKeysWithPrefix<typeof tenantSchema.users.$inferInsert, 'r_'>>;
const PERM_FIELDS = Object.keys(tenantSchema.users).filter((key) => key.startsWith('r_')) as [UserRoles, ...UserRoles[]];

// eslint-disable-next-line qwik/loader-location, @typescript-eslint/require-await
const useTenantUsers = routeLoader$(async ({ sharedMap, resolveValue }) => async () => {
	const youPerms = await resolveValue(usePermissions);

	if (!youPerms) {
		throw new Error('User not allowed in tenant');
	}

	const session = sharedMap.get('session') as Session;

	// eslint-disable-next-line @typescript-eslint/no-unused-vars
	const { overrides, ...cleanYou } = youPerms;
	const you = {
		...cleanYou,
		approved: true,
		u_id: session.user!.u_id,
		do_id: session.user!.do_id,
	};

	if (you.r_roles >= Permissions.Read) {
		const t_db = sharedMap.get('t_db') as DrizzleD1Database;

		const others = await t_db
			.select({
				approved: tenantSchema.users.approved,
				u_id: tenantSchema.users.u_id,
				do_id: tenantSchema.users.do_id,
				r_tenant: tenantSchema.users.r_tenant,
				r_users: tenantSchema.users.r_users,
				r_roles: tenantSchema.users.r_roles,
				r_billing: tenantSchema.users.r_billing,
				r_apikeys: tenantSchema.users.r_apikeys,
				r_keyring: tenantSchema.users.r_keyring,
				r_datakey: tenantSchema.users.r_datakey,
				r_logs: tenantSchema.users.r_logs,
			})
			.from(tenantSchema.users)
			.where(ne(tenantSchema.users.u_id, sql`unhex(${session.user?.u_id.hex})`))
			.then((rows) =>
				rows.map((row) => ({
					...row,
					u_id: {
						hex: row.u_id.toString('hex'),
						base64: row.u_id.toString('base64'),
						base64url: row.u_id.toString('base64url'),
					},
					do_id: row.do_id.toString('hex'),
				})),
			);

		return {
			users: [you, ...others],
			canEditRoles: you.r_roles >= Permissions.Write,
		};
	}

	return {
		users: [you],
		canEditRoles: false,
	};
});

// eslint-disable-next-line qwik/loader-location
const useUpdatePermission = routeAction$(
	async (data, { sharedMap, fail }) => {
		const session = sharedMap.get('session') as Session;
		const t_db = sharedMap.get('t_db') as SqliteRemoteDatabase;

		const [you] = await t_db
			.select({ r_roles: tenantSchema.users.r_roles })
			.from(tenantSchema.users)
			.where(and(eq(tenantSchema.users.u_id, sql`unhex(${session.user!.u_id.hex})`), eq(tenantSchema.users.approved, true)))
			.limit(1);

		if ((you?.r_roles ?? 0) < Permissions.Write) {
			return fail(403, { message: 'Insufficient permissions' });
		}

		await t_db
			.update(tenantSchema.users)
			.set({
				[data.field]: data.value,
				m_time: new Date(),
			})
			.where(eq(tenantSchema.users.u_id, sql`unhex(${data.u_id_hex})`));

		return { success: true };
	},
	zod$({
		u_id_hex: z
			.string()
			.trim()
			.toLowerCase()
			.length(32)
			.refine((string) => zm.hex().safeParse(string).success),
		field: z.enum(PERM_FIELDS),
		value: z.number().int().min(0).max(3),
	}),
);

const permLabelKeys: Record<UserRoles, () => string> = {
	r_tenant: () => m.users_permission_tenant(),
	r_users: () => m.users_permission_users(),
	r_roles: () => m.users_permission_roles(),
	r_billing: () => m.users_permission_billing(),
	r_apikeys: () => m.users_permission_apikeys(),
	r_keyring: () => m.users_permission_keyring(),
	r_datakey: () => m.users_permission_datakey(),
	r_logs: () => m.users_permission_logs(),
} as const;

const permValueLabel = (v: Permissions): string => {
	switch (v) {
		case Permissions.None:
			return m.users_role_none();
		case Permissions.Read:
			return m.users_role_read();
		case Permissions.Write:
			return m.users_role_write();
		case Permissions.Admin:
			return m.users_role_admin();
	}
};

export default component$(() => {
	const tenantUsers = useTenantUsers();
	const updatePermission = useUpdatePermission();

	return (
		<div class="mx-auto w-fit max-w-full px-6 py-10">
			<div class="mb-8">
				<h1 class="text-2xl font-bold tracking-tight text-gray-900 dark:text-white">{m.users_page_title()}</h1>
				<p class="mt-1 text-sm text-gray-500 dark:text-gray-400">{m.users_page_subtitle()}</p>
			</div>

			<div class="border-surface-light/60 dark:border-surface-dark/60 dark:bg-surface-dark/70 overflow-x-auto rounded-2xl border bg-white/70 shadow-sm backdrop-blur-md">
				<div class="border-surface-light/60 dark:border-surface-dark/60 hidden border-b md:block">
					<div class="flex w-fit items-center gap-2 px-5 py-3">
						<span class="min-w-[200px] text-xs font-semibold tracking-wide text-gray-500 uppercase dark:text-gray-400">{m.users_user()}</span>
						<span class="w-20 flex-shrink-0 text-xs font-semibold tracking-wide text-gray-500 uppercase dark:text-gray-400">{m.users_status()}</span>
						{PERM_FIELDS.map((field) => (
							<span key={field} class="min-w-[90px] text-center text-xs font-semibold tracking-wide text-gray-500 uppercase dark:text-gray-400">
								{permLabelKeys[field]()}
							</span>
						))}
					</div>
				</div>

				<Resource
					value={tenantUsers}
					onPending={() => (
						<li class="space-y-3">
							<div class="h-16 animate-pulse rounded-2xl bg-gray-200 dark:bg-gray-700" />
							<div class="h-16 animate-pulse rounded-2xl bg-gray-200 dark:bg-gray-700" />
						</li>
					)}
					onResolved={(payload) => {
						const { users, canEditRoles } = payload;

						return (
							<ul class="divide-surface-light/60 dark:divide-surface-dark/60 divide-y">
								{users.map((user) => {
									const uIdHex = user.u_id.hex;

									return (
										<li key={uIdHex} class={'hover:bg-gray-50 dark:hover:bg-gray-800/30'}>
											<div class="hidden w-fit flex-row items-center gap-2 px-5 py-3 md:flex">
												<div class="flex min-w-[200px] items-center gap-2">
													<UserRow u_id_hex={uIdHex} do_id={user.do_id} />
												</div>

												<div class="w-20 flex-shrink-0">{user.approved ? <span class="inline-flex items-center rounded-full bg-green-100 px-2 py-0.5 text-[11px] font-medium text-green-700 dark:bg-green-900/30 dark:text-green-400">{m.users_approved()}</span> : <span class="inline-flex items-center rounded-full bg-amber-100 px-2 py-0.5 text-[11px] font-medium text-amber-700 dark:bg-amber-900/30 dark:text-amber-400">{m.users_not_approved()}</span>}</div>

												{PERM_FIELDS.map((field) => {
													const val = Number(user[field]);

													if (canEditRoles) {
														return (
															<PermissionDropdown
																key={field}
																field={field}
																value={val}
																onUpdate$={$(async (newVal) => {
																	await updatePermission.submit({ u_id_hex: uIdHex, field, value: newVal });
																})}
															/>
														);
													}

													return <span key={field} class="min-w-[90px] text-center text-sm text-gray-700 dark:text-gray-300"></span>;
												})}
											</div>

											<div class="space-y-3 px-5 py-4 md:hidden">
												<div class="flex items-center justify-between">
													<div class="flex items-center gap-2">
														<UserRow u_id_hex={uIdHex} do_id={user.do_id} />
													</div>
													{user.approved ? <span class="inline-flex items-center rounded-full bg-green-100 px-2 py-0.5 text-[11px] font-medium text-green-700 dark:bg-green-900/30 dark:text-green-400">{m.users_approved()}</span> : <span class="inline-flex items-center rounded-full bg-amber-100 px-2 py-0.5 text-[11px] font-medium text-amber-700 dark:bg-amber-900/30 dark:text-amber-400">{m.users_not_approved()}</span>}
												</div>

												<div class="flex flex-wrap gap-2">
													{PERM_FIELDS.map((field) => {
														const val = Number(user[field]);

														return (
															<div key={field} class="dark:border-surface-dark/60 flex w-[calc(50%-4px)] items-center justify-between rounded-lg border border-gray-200/80 bg-white px-3 py-2 shadow-sm dark:bg-gray-800/40 dark:shadow-none">
																<span class="text-[11px] font-semibold tracking-wide text-gray-600 uppercase dark:text-gray-400">{permLabelKeys[field]()}</span>
																{canEditRoles ? (
																	<PermissionDropdown
																		field={field}
																		value={val}
																		mobile
																		onUpdate$={$(async (newVal) => {
																			await updatePermission.submit({ u_id_hex: uIdHex, field, value: newVal });
																		})}
																	/>
																) : (
																	<span class="dark:border-surface-dark/60 dark:bg-surface-dark rounded-md border border-gray-200 bg-white px-2.5 py-1 text-xs font-semibold text-gray-800 shadow-sm dark:text-gray-300 dark:shadow-none">{permValueLabel(val)}</span>
																)}
															</div>
														);
													})}
												</div>
											</div>
										</li>
									);
								})}
							</ul>
						);
					}}
					onRejected={(error) =>
						error instanceof Error ? (
							<p class="text-red-600">
								{m.common_error_label()} {error.name}: {error.message}
							</p>
						) : (
							<pre class="text-red-600">{JSON.stringify(error, null, '\t')}</pre>
						)
					}
				/>
			</div>
		</div>
	);
});

interface PermissionDropdownProps {
	field: string;
	value: Permissions;
	mobile?: boolean;
	onUpdate$: QRL<(newVal: Permissions) => Promise<void>>;
}

const PermissionDropdown = component$<PermissionDropdownProps>(({ field, value, mobile = false, onUpdate$ }) => {
	const current = useSignal<Permissions>(value);
	const loading = useSignal(false);

	// eslint-disable-next-line qwik/no-use-visible-task
	useVisibleTask$(({ track }) => {
		track(() => value);
		current.value = value;
	});

	return (
		<select
			name={field}
			value={current.value}
			disabled={loading.value}
			onChange$={async (event, element) => {
				const next = parseInt(element.value, 10);
				const prev = current.value;

				if (next !== current.value) {
					// Update last value
					current.value = next;
					loading.value = true;

					await onUpdate$(next)
						.catch(() => {
							current.value = prev;
						})
						.finally(() => {
							loading.value = false;
						});
				}
			}}
			class={['min-w-[90px] cursor-pointer rounded-lg border px-2 py-1 text-center text-xs font-medium transition-colors', mobile ? 'border-gray-300 bg-white text-gray-900 shadow-sm ring-1 ring-gray-200/70 hover:border-gray-400' : 'border-surface-light/60 bg-white text-gray-700 hover:border-gray-300', 'dark:border-surface-dark/60 dark:bg-surface-dark dark:text-gray-300 dark:ring-0 dark:hover:border-gray-500', loading.value && 'animate-pulse opacity-50']}>
			<option selected={current.value === Permissions.None} value="0">
				{m.users_role_none()}
			</option>
			<option selected={current.value === Permissions.Read} value="1">
				{m.users_role_read()}
			</option>
			<option selected={current.value === Permissions.Write} value="2">
				{m.users_role_write()}
			</option>
			<option selected={current.value === Permissions.Admin} value="3">
				{m.users_role_admin()}
			</option>
		</select>
	);
});
