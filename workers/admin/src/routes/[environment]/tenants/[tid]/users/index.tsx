import { $, component$, Resource, useSignal } from '@builder.io/qwik';
import { Link, routeAction$, routeLoader$, useLocation, z, zod$, type DocumentHead } from '@builder.io/qwik-city';
import { LuAlertTriangle, LuCheck, LuTrash2, LuUserPlus, LuX } from '@qwikest/icons/lucide';
import * as rootSchema from 'db/schemas/root';
import * as tenantSchema from 'db/schemas/tenant/main';
import type { DrizzleD1Database } from 'drizzle-orm/d1';
import { and, asc, eq, sql } from 'drizzle-orm/sql';
import type { SqliteRemoteDatabase } from 'drizzle-orm/sqlite-proxy';
import type { Permissions } from 'types';
import type { ExtractKeysWithPrefix } from 'types/tenants';
import { PermissionSelect } from '~/components/permission-select/permission-select';
import { actionErrorMessage } from '~/routes/[environment]/tenants/db-helpers';
import { serializeActionError, uuidAnyFormatSchema } from '~/routes/[environment]/tenants/tenant-ops';
import { hexToUuid } from '~/routes/[environment]/users/db-helpers';

type UserRoles = NonNullable<ExtractKeysWithPrefix<typeof tenantSchema.users.$inferInsert, 'r_'>>;
const PERM_FIELDS = Object.keys(tenantSchema.users).filter((key) => key.startsWith('r_')) as [UserRoles, ...UserRoles[]];

/**
 * A tenant's membership is written in two places — the root `users_tenants` link and the row inside the tenant's own Durable Object — so both are loaded and any user present in only one of them is called out.
 */
export const useTenantUsers = routeLoader$(({ sharedMap }) => {
	const r_db = sharedMap.get('r_db') as DrizzleD1Database;
	const t_db = sharedMap.get('t_db') as SqliteRemoteDatabase;
	const t_id_hex = sharedMap.get('t_id_hex') as string;

	return async () => {
		const [tenantRows, rootRows] = await Promise.all([
			t_db.select().from(tenantSchema.users).orderBy(asc(tenantSchema.users.b_time)),
			r_db
				.select({
					u_id: rootSchema.users_tenants.u_id,
					jurisdiction: rootSchema.users.jurisdiction,
					do_id: rootSchema.users.do_id,
				})
				.from(rootSchema.users_tenants)
				.innerJoin(rootSchema.users, eq(rootSchema.users.u_id, rootSchema.users_tenants.u_id))
				.where(eq(rootSchema.users_tenants.t_id, sql`unhex(${t_id_hex})`)),
		]);

		const rootByUid = new Map(
			rootRows.map((row) => {
				const u_id_hex = row.u_id.toString('hex');
				return [
					u_id_hex,
					{
						u_id_hex,
						u_id_uuid: hexToUuid(u_id_hex),
						u_id_base64url: row.u_id.toString('base64url'),
						jurisdiction: row.jurisdiction,
						do_id: row.do_id?.toString('hex') ?? null,
					},
				] as const;
			}),
		);

		// Columns are picked apart rather than spread: the raw blob columns are `Buffer`s, which can't cross into the client
		const users = tenantRows.map((row) => {
			const u_id_hex = row.u_id.toString('hex');
			const do_id_hex = row.do_id.toString('hex');
			const rootLink = rootByUid.get(u_id_hex) ?? null;

			return {
				u_id_hex,
				u_id_uuid: hexToUuid(u_id_hex),
				u_id_base64url: row.u_id.toString('base64url'),
				do_id_hex,
				approved: row.approved,
				a_time: row.a_time,
				b_time: row.b_time,
				m_time: row.m_time,
				permissions: Object.fromEntries(PERM_FIELDS.map((field) => [field, row[field]])) as Record<UserRoles, Permissions>,
				rootLinked: rootLink !== null,
				// The tenant keeps its own copy of the user's DO id; a mismatch means one of the two is stale
				doIdMatchesRoot: rootLink?.do_id ? rootLink.do_id === do_id_hex : null,
			};
		});

		const tenantUids = new Set(users.map((user) => user.u_id_hex));

		return {
			users,
			// Linked in root but never written into the tenant's own database — they can't actually use the tenant
			rootOnly: rootRows.map((row) => rootByUid.get(row.u_id.toString('hex'))!).filter((row) => !tenantUids.has(row.u_id_hex)),
		};
	};
});

export const useUpdateTenantUserPermission = routeAction$(
	async (data, { sharedMap, fail }) => {
		const t_db = sharedMap.get('t_db') as SqliteRemoteDatabase;

		return t_db
			.update(tenantSchema.users)
			.set({
				[data.field]: data.value,
				m_time: new Date(),
			})
			.where(eq(tenantSchema.users.u_id, sql`unhex(${data.userId})`))
			.then(() => ({ updated: true }))
			.catch((err: unknown) => fail(500, serializeActionError(err)));
	},
	zod$({
		userId: uuidAnyFormatSchema,
		field: z.enum(PERM_FIELDS),
		value: z.coerce.number().int().min(0).max(3),
	}),
);

export const useSetTenantUserApproved = routeAction$(
	async (data, { sharedMap, fail }) => {
		const t_db = sharedMap.get('t_db') as SqliteRemoteDatabase;

		return t_db
			.update(tenantSchema.users)
			.set({
				approved: data.approved,
				m_time: new Date(),
			})
			.where(eq(tenantSchema.users.u_id, sql`unhex(${data.userId})`))
			.then(() => ({ updated: true }))
			.catch((err: unknown) => fail(500, serializeActionError(err)));
	},
	zod$({
		userId: uuidAnyFormatSchema,
		// Sent as '0'/'1' rather than a boolean so it survives either transport (JSON body or form encoding), where `z.coerce.boolean()` would read "false" as true
		approved: z.enum(['0', '1']).transform((approved) => approved === '1'),
	}),
);

/**
 * Writes both halves of a tenant membership, so it doubles as the repair action for a user that only exists on one side. Both inserts ignore conflicts, meaning an existing row (and the permissions on it) is never overwritten.
 */
export const useLinkTenantUser = routeAction$(
	async (data, { sharedMap, fail }) => {
		const r_db = sharedMap.get('r_db') as DrizzleD1Database;
		const t_db = sharedMap.get('t_db') as SqliteRemoteDatabase;
		const t_id_hex = sharedMap.get('t_id_hex') as string;

		const [user] = await r_db
			.select({
				do_id: rootSchema.users.do_id,
			})
			.from(rootSchema.users)
			.where(eq(rootSchema.users.u_id, sql`unhex(${data.userId})`))
			.limit(1)
			.then((rows) => rows.map((row) => ({ do_id: row.do_id?.toString('hex') ?? null })));

		if (!user) return fail(404, serializeActionError(new Error(`No user ${hexToUuid(data.userId)} exists in the root lookup table.`)));
		// `tenants.users.do_id` is NOT NULL, so a user who has never signed in (and therefore has no durable object yet) can't be a tenant member
		if (!user.do_id) return fail(409, serializeActionError(new Error(`User ${hexToUuid(data.userId)} has no durable object yet, so they can't be added to a tenant.`)));

		const now = new Date();

		return r_db
			.insert(rootSchema.users_tenants)
			.values({
				u_id: sql`unhex(${data.userId})`,
				t_id: sql`unhex(${t_id_hex})`,
			})
			.onConflictDoNothing()
			.then(() =>
				t_db
					.insert(tenantSchema.users)
					.values({
						u_id: sql`unhex(${data.userId})`,
						do_id: sql`unhex(${user.do_id})`,
						b_time: now,
						m_time: now,
						approved: true,
					})
					.onConflictDoNothing(),
			)
			.then(() => ({ linked: true }))
			.catch((err: unknown) => fail(500, serializeActionError(err)));
	},
	zod$({ userId: uuidAnyFormatSchema }),
);

export const useUnlinkTenantUser = routeAction$(
	async (data, { sharedMap, fail }) => {
		const r_db = sharedMap.get('r_db') as DrizzleD1Database;
		const t_db = sharedMap.get('t_db') as SqliteRemoteDatabase;
		const t_id_hex = sharedMap.get('t_id_hex') as string;

		return t_db
			.delete(tenantSchema.users)
			.where(eq(tenantSchema.users.u_id, sql`unhex(${data.userId})`))
			.then(() => r_db.delete(rootSchema.users_tenants).where(and(eq(rootSchema.users_tenants.u_id, sql`unhex(${data.userId})`), eq(rootSchema.users_tenants.t_id, sql`unhex(${t_id_hex})`))))
			.then(() => ({ removed: true }))
			.catch((err: unknown) => fail(500, serializeActionError(err)));
	},
	zod$({ userId: uuidAnyFormatSchema }),
);

export const head: DocumentHead = {
	title: 'Tenant Users — EaaS Admin',
};

export default component$(() => {
	const loc = useLocation();
	const tenantUsers = useTenantUsers();
	const updatePermissionAction = useUpdateTenantUserPermission();
	const setApprovedAction = useSetTenantUserApproved();
	const linkUserAction = useLinkTenantUser();
	const unlinkUserAction = useUnlinkTenantUser();

	const newUserId = useSignal('');
	const actionError = useSignal('');

	const handleLinkUser = $(async (userId: string) => {
		const trimmed = userId.trim();
		if (!trimmed) return;

		const result = await linkUserAction.submit({ userId: trimmed });
		if (result.value.failed) {
			actionError.value = actionErrorMessage(result.value, 'Failed to add user.');
			return;
		}

		newUserId.value = '';
	});

	const handleUnlinkUser = $(async (userId: string, label: string) => {
		if (!window.confirm(`Are you sure you want to remove ${label} from this tenant?`)) return;

		const result = await unlinkUserAction.submit({ userId });
		if (result.value.failed) actionError.value = actionErrorMessage(result.value, 'Failed to remove user.');
	});

	return (
		<div class="space-y-8">
			{/* Error Banner */}
			{actionError.value && (
				<div class="flex items-center justify-between rounded-lg border border-red-300 bg-red-50 p-4 text-sm text-red-800 dark:border-red-800 dark:bg-red-900/20 dark:text-red-400">
					<span>{actionError.value}</span>
					<button type="button" class="ml-4 text-red-800 hover:underline dark:text-red-400" onClick$={() => (actionError.value = '')}>
						Dismiss
					</button>
				</div>
			)}

			{/* Add user */}
			<div class="border-default-medium bg-surface-light dark:bg-surface-dark flex flex-col gap-3 border p-4 lg:flex-row lg:items-center">
				<div class="flex-1">
					<label class="text-body mb-1 block text-sm font-medium dark:text-gray-300" for="add-user-id">
						Add user by ID
					</label>
					<input id="add-user-id" type="text" placeholder="UUIDv7, hex (32), base64 (24), or base64url (22)" class="border-default-medium bg-deep-light text-body block w-full rounded-lg border p-2.5 font-mono text-sm focus:border-blue-500 focus:ring-blue-500 dark:border-gray-600 dark:bg-gray-700 dark:text-white dark:placeholder-gray-400" bind:value={newUserId} onKeyDown$={(event) => (event.key === 'Enter' ? handleLinkUser(newUserId.value) : undefined)} />
				</div>
				<button type="button" class="inline-flex items-center gap-1.5 rounded-lg bg-green-600 px-4 py-2 text-sm font-medium text-white hover:bg-green-700 disabled:opacity-50" disabled={!newUserId.value.trim() || linkUserAction.isRunning} onClick$={() => handleLinkUser(newUserId.value)}>
					<LuUserPlus class="h-4 w-4" />
					Add user
				</button>
			</div>

			<Resource
				value={tenantUsers}
				onPending={() => (
					<div class="px-4 py-8 text-center">
						<span class="text-body-subtle dark:text-gray-500">Loading tenant users…</span>
					</div>
				)}
				onRejected={(error) => (
					<div class="rounded-lg border border-red-300 bg-red-50 p-4 text-sm text-red-800 dark:border-red-800 dark:bg-red-900/20 dark:text-red-400">
						Failed to load tenant users: {error.name}: {error.message}
					</div>
				)}
				onResolved={(data) => (
					<>
						<div class="overflow-x-auto">
							<table class="text-body w-full text-left text-sm dark:text-gray-400">
								<thead class="bg-surface-light text-body-subtle text-xs uppercase dark:bg-gray-700 dark:text-gray-400">
									<tr>
										<th scope="col" class="px-4 py-3">
											User
										</th>
										<th scope="col" class="px-4 py-3 text-center">
											Root link
										</th>
										<th scope="col" class="px-4 py-3 text-center">
											Approved
										</th>
										{PERM_FIELDS.map((field) => (
											<th key={field} scope="col" class="px-4 py-3 text-center">
												{field}
											</th>
										))}
										<th scope="col" class="px-4 py-3">
											Actions
										</th>
									</tr>
								</thead>
								<tbody>
									{data.users.map((user) => (
										<tr key={user.u_id_hex} class="border-default-medium hover:bg-surface-light border-b dark:border-gray-700 dark:hover:bg-gray-600">
											<td class="px-4 py-3">
												<Link prefetch="js" href={`/${loc.params['environment']}/users/${user.u_id_base64url}/`} class="text-primary-accent hover:underline">
													<code class="text-xs break-all">{user.u_id_uuid}</code>
												</Link>
												<div class="text-body-subtle mt-0.5 text-xs dark:text-gray-500">
													<code class="break-all">{user.u_id_base64url}</code>
												</div>
												{user.doIdMatchesRoot === false && <p class="mt-1 text-xs text-red-600 dark:text-red-400">do_id differs from root</p>}
											</td>
											<td class="px-4 py-3 text-center">
												{user.rootLinked ? (
													<LuCheck class="mx-auto h-5 w-5 text-green-500" />
												) : (
													<div class="flex items-center justify-center gap-1">
														<LuX class="h-5 w-5 text-red-500" />
														<button type="button" class="text-xs text-blue-500 hover:underline" onClick$={() => handleLinkUser(user.u_id_hex)}>
															Fix
														</button>
													</div>
												)}
											</td>
											<td class="px-4 py-3 text-center">
												<input
													type="checkbox"
													class="border-default-medium h-4 w-4 rounded bg-gray-100 text-blue-600 focus:ring-2 focus:ring-blue-500 dark:border-gray-600 dark:bg-gray-700 dark:ring-offset-gray-800"
													checked={user.approved}
													onChange$={async (_, element) => {
														const result = await setApprovedAction.submit({ userId: user.u_id_hex, approved: element.checked ? '1' : '0' });
														if (result.value.failed) actionError.value = actionErrorMessage(result.value, 'Failed to update approval.');
													}}
												/>
											</td>
											{PERM_FIELDS.map((field) => (
												<td key={field} class="px-4 py-3 text-center">
													<PermissionSelect
														name={field}
														value={user.permissions[field]}
														onUpdate$={$(async (value: Permissions) => {
															const result = await updatePermissionAction.submit({ userId: user.u_id_hex, field, value });
															if (result.value.failed) {
																actionError.value = actionErrorMessage(result.value, 'Failed to update permission.');
																throw new Error(actionError.value);
															}
														})}
													/>
												</td>
											))}
											<td class="px-4 py-3">
												<button type="button" class="text-red-500 hover:text-red-700" title="Remove from tenant" onClick$={() => handleUnlinkUser(user.u_id_hex, user.u_id_uuid)}>
													<LuTrash2 class="h-4 w-4" />
												</button>
											</td>
										</tr>
									))}
									{data.users.length === 0 && (
										<tr>
											<td colSpan={4 + PERM_FIELDS.length} class="px-4 py-8 text-center">
												<span class="text-body-subtle dark:text-gray-500">No users</span>
											</td>
										</tr>
									)}
								</tbody>
							</table>
						</div>

						{/* Root links with nothing behind them */}
						{data.rootOnly.length > 0 && (
							<div class="border-default-medium bg-surface-light dark:bg-surface-dark border p-4">
								<h2 class="text-heading mb-1 flex items-center gap-2 text-lg font-semibold dark:text-white">
									<LuAlertTriangle class="h-4 w-4 text-amber-500" />
									Linked in root only
								</h2>
								<ul class="mt-3 flex flex-col gap-2">
									{data.rootOnly.map((user) => (
										<li key={user.u_id_hex} class="flex flex-wrap items-center justify-between gap-2">
											<Link prefetch="js" href={`/${loc.params['environment']}/users/${user.u_id_base64url}/`} class="text-primary-accent hover:underline">
												<code class="text-xs break-all">{user.u_id_uuid}</code>
											</Link>
											<div class="flex items-center gap-2">
												{user.do_id ? (
													<button type="button" class="rounded-lg bg-blue-600 px-3 py-1.5 text-xs font-medium text-white hover:bg-blue-700" onClick$={() => handleLinkUser(user.u_id_hex)}>
														Add tenant row
													</button>
												) : (
													<span class="text-body-subtle text-xs dark:text-gray-500">No durable object yet</span>
												)}
												<button type="button" class="inline-flex items-center gap-1.5 rounded-lg bg-red-600 px-3 py-1.5 text-xs font-medium text-white hover:bg-red-700" onClick$={() => handleUnlinkUser(user.u_id_hex, user.u_id_uuid)}>
													<LuTrash2 class="h-3.5 w-3.5" />
													Remove link
												</button>
											</div>
										</li>
									))}
								</ul>
							</div>
						)}
					</>
				)}
			/>
		</div>
	);
});
