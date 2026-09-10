import { $, component$, Resource, useComputed$, useSignal, useStore } from '@builder.io/qwik';
import { routeAction$, routeLoader$, useLocation, z, zod$, type DocumentHead } from '@builder.io/qwik-city';
import { LuArrowDown, LuArrowUp, LuArrowUpDown, LuPlus } from '@qwikest/icons/lucide';
import { Cloudflare } from 'cloudflare';
import { SQLCache } from 'db/cache';
import { DebugLogWriter, drizzleD0, StaticDatabase } from 'db/core';
import * as rootSchema from 'db/schemas/root';
import * as tenantSchema from 'db/schemas/tenant/main';
import type { DrizzleD1Database } from 'drizzle-orm/d1';
import { DefaultLogger } from 'drizzle-orm/logger';
import { asc, count, desc, eq, sql } from 'drizzle-orm/sql';
import { Buffer } from 'node:buffer';
import { createHash, createHmac, type UUID } from 'node:crypto';
import { DOJurisdictions } from 'types';
import { v7 as uuidv7 } from 'uuid';
import * as zm from 'zod/mini';
import { AssignTenantModal } from '~/components/assign-tenant-modal/assign-tenant-modal';
import { Pagination } from '~/components/pagination/pagination';
import { UserRow } from '~/components/user-row/user-row';
import { UsersToolbar } from '~/components/users-toolbar/users-toolbar';
import { purgeUser } from '~/routes/[environment]/users/user-ops';

const PAGE_SIZE = 100;

type SortColumn = 'u_id' | 'do_id';
type SortDir = 'asc' | 'desc';
type UserDoPlacement = 'none' | `jurisdiction:${DOJurisdictions}`;

const getEnumEntries = <TValue extends string>(enumObject: Record<string, TValue>): [string, TValue][] => Object.entries(enumObject);

const DO_JURISDICTION_OPTIONS = getEnumEntries(DOJurisdictions as Record<string, DOJurisdictions>);

const serializeActionError = (err: unknown) => {
	if (err instanceof Error) {
		return {
			name: err.name,
			message: err.message,
			cause: err.cause instanceof Error ? err.cause.message : typeof err.cause === 'string' ? err.cause : undefined,
		};
	}

	return {
		error: typeof err === 'string' ? err : JSON.stringify(err),
	};
};

const parseUserDoPlacement = (placement: string): { kind: 'none' } | { kind: 'jurisdiction'; value: DOJurisdictions } => {
	if (placement === 'none') {
		return { kind: 'none' };
	}

	if (placement.startsWith('jurisdiction:')) {
		const jurisdiction = z.nativeEnum(DOJurisdictions).safeParse(placement.slice('jurisdiction:'.length));
		if (jurisdiction.success) {
			return { kind: 'jurisdiction', value: jurisdiction.data };
		}
	}

	throw new Error('Invalid durable object placement selection.');
};

// eslint-disable-next-line @typescript-eslint/require-await
export const useDurableObjects = routeLoader$(async ({ platform }) => async () => {
	const cf = new Cloudflare({ apiToken: platform.env.CF_API_TOKEN });

	const instances: Record<string, boolean> = {};
	for await (const instance of cf.durableObjects.namespaces.objects.list(StaticDatabase.User.Main['eaas-api-prod_UserD0'], {
		account_id: platform.env.CF_ACCOUNT_ID,
		limit: 10000,
	})) {
		instances[instance.id!] = instance.hasStoredData!;
	}

	return instances;
});

// eslint-disable-next-line @typescript-eslint/require-await
export const useUsersPage = routeLoader$(async ({ sharedMap, url }) => async () => {
	const r_db = sharedMap.get('r_db') as DrizzleD1Database;

	const page = Math.max(1, parseInt(url.searchParams.get('page') ?? '1', 10) || 1);
	const sortCol: SortColumn = url.searchParams.get('sort') === 'do_id' ? 'do_id' : 'u_id';
	const sortDir: SortDir = url.searchParams.get('dir') === 'asc' ? 'asc' : 'desc';

	const column = sortCol === 'do_id' ? rootSchema.users.do_id : rootSchema.users.u_id;
	const orderFn = sortDir === 'asc' ? asc : desc;

	const [row] = await r_db
		.select({
			count: count(),
		})
		.from(rootSchema.users);

	const totalPages = Math.max(1, Math.ceil(row!.count / PAGE_SIZE));
	const safePage = Math.min(page, totalPages);
	const offset = (safePage - 1) * PAGE_SIZE;

	const users = await r_db
		.select({
			u_id: rootSchema.users.u_id,
			jurisdiction: rootSchema.users.jurisdiction,
			do_id: rootSchema.users.do_id,
			user_init: rootSchema.users.user_init,
		})
		.from(rootSchema.users)
		.orderBy(orderFn(column))
		.limit(PAGE_SIZE)
		.offset(offset)
		.then((rows) =>
			rows.map((row) => ({
				...row,
				u_id: row.u_id.toString('hex'),
				u_id_b64: row.u_id.toString('base64url'),
				do_id: row.do_id?.toString('hex'),
			})),
		);

	return { users, page: safePage, totalPages, totalItems: row!.count, sortCol, sortDir };
});

export const useAddUser = routeAction$(
	async (data, { fail, platform, sharedMap }) => {
		const isProd = sharedMap.get('isProd') as boolean;
		const authSecret = isProd ? platform.env.AUTH_SECRET_PROD : platform.env.AUTH_SECRET_DEV;

		const r_db = sharedMap.get('r_db') as DrizzleD1Database;

		const u_id = uuidv7() as UUID;
		const userNamespace = platform.env.USER_D0_PROD;
		const doPlacement = parseUserDoPlacement(data.placement);
		const doId = doPlacement.kind === 'jurisdiction' ? userNamespace.jurisdiction(doPlacement.value).idFromName(u_id) : null;

		return r_db
			.insert(rootSchema.users)
			.values({
				u_id: sql`unhex(${u_id.replaceAll('-', '')})`,
				...(doPlacement.kind === 'jurisdiction' && { jurisdiction: doPlacement.value }),
				// null, will create D0 on first login
				...(doId && { do_id: sql`unhex(${doId.toString()})` }),
				key_hash: sql`unhex(${createHash('sha256').update(Buffer.from(authSecret, 'base64').toString('hex')).digest('hex')})`,
				email_key: (() => {
					const stableEmail = data.email.trim().toLowerCase();
					const stableParts = stableEmail.split('@');
					const stableDomain = stableParts.pop()!;
					const stableLocal = stableParts.join('@');
					const stableBaseLocal = stableLocal.split('+', 1)[0]!;

					const canonicalizedEmail = `${stableBaseLocal}@${stableDomain}`;
					const hmacHex = createHmac('sha256', Buffer.from(authSecret, 'base64')).update(canonicalizedEmail).digest('hex');
					return sql`unhex(${hmacHex})`;
				})(),
			})
			.then(() => ({ created: true }))
			.catch((err: unknown) => fail(500, serializeActionError(err)));
	},
	zod$({
		email: z.string().email().nonempty(),
		placement: z.union([
			z.literal('none'),
			z.string().refine((value) => {
				if (value.startsWith('jurisdiction:')) return z.nativeEnum(DOJurisdictions).safeParse(value.slice('jurisdiction:'.length)).success;
				return false;
			}, 'Invalid durable object placement selection.'),
		]),
	}),
);

export const useAssignTenant = routeAction$(
	async (data, { sharedMap, fail, platform }) => {
		const r_db = sharedMap.get('r_db') as DrizzleD1Database;

		// Look up tenant in root DB to get jurisdiction + DO id
		const [tenant] = await r_db
			.select({
				jurisdiction: rootSchema.tenants.jurisdiction,
				do_id: rootSchema.tenants.do_id,
			})
			.from(rootSchema.tenants)
			.where(eq(rootSchema.tenants.t_id, sql`unhex(${data.tenantId})`))
			.limit(1)
			.then((rows) =>
				rows.map((row) => ({
					...row,
					do_id: row.do_id.toString('hex'),
				})),
			);

		if (!tenant) return fail(404, { message: 'Tenant not found.' });

		// Connect to tenant Durable Object for t_db writes
		const doNamespace = platform.env.TENANT_D0_PROD;
		const doNamespaceJurisdiction = tenant.jurisdiction ? doNamespace.jurisdiction(tenant.jurisdiction) : doNamespace;
		const doId = doNamespaceJurisdiction.idFromString(tenant.do_id);
		const doStub = doNamespace.get(doId);
		const browserCache = sharedMap.get('browserCache') as boolean;

		const t_db = drizzleD0(doStub, {
			logger: new DefaultLogger({ writer: new DebugLogWriter(doId.toString()) }),
			cache: new SQLCache(
				{
					dbName: doId.toString(),
					dbType: 'do',
					strategy: browserCache ? 'all' : 'explicit',
					cacheTTL: parseInt(platform.env.SQL_TTL, 10),
					logging: true,
				},
				globalThis.caches ?? platform.caches,
			),
		});

		let assigned = 0;

		for (const uidHex of data.userIds) {
			// Look up user from root DB for their DO id
			const [user] = await r_db
				.select({ do_id: rootSchema.users.do_id })
				.from(rootSchema.users)
				.where(eq(rootSchema.users.u_id, sql`unhex(${uidHex})`))
				.limit(1)
				.then((rows) => rows.map((row) => ({ do_id: row.do_id?.toString('hex') })));

			if (!user?.do_id) continue;

			// Insert into root users_tenants
			const rootResult = await r_db
				.insert(rootSchema.users_tenants)
				.values({
					u_id: sql`unhex(${uidHex})`,
					t_id: sql`unhex(${data.tenantId})`,
				})
				.onConflictDoNothing()
				.catch((err: unknown) => fail(500, serializeActionError(err)));

			if ('failed' in rootResult) return rootResult;

			// Insert into tenant DB users table
			const now = new Date();
			const tenantResult = await t_db
				.insert(tenantSchema.users)
				.values({
					u_id: sql`unhex(${uidHex})`,
					do_id: sql`unhex(${user.do_id})`,
					b_time: now,
					m_time: now,
				})
				.onConflictDoNothing()
				.catch((err: unknown) => fail(500, serializeActionError(err)));

			if ('failed' in tenantResult) return tenantResult;

			assigned++;
		}

		return { assigned };
	},
	zod$({
		userIds: z.array(z.string()),
		tenantId: z.union([
			z
				.string()
				.trim()
				.uuid()
				.refine((val) => zm.validate(zm.uuidv7(), val), 'Must be a valid UUIDv7')
				.transform((uuid) => uuid.replaceAll('-', '')),
			z
				.string()
				.trim()
				.length(32)
				.refine((val) => zm.validate(zm.hex(), val), 'Must be a valid UUIDv7 without hyphens'),
			z
				.string()
				.trim()
				.length(24)
				.base64()
				.transform((base64) => Buffer.from(base64, 'base64').toString('hex')),
			z
				.string()
				.trim()
				.length(22)
				.base64url()
				.transform((base64url) => Buffer.from(base64url, 'base64url').toString('hex')),
		]),
	}),
);

export const useDeleteUsers = routeAction$(
	async (data, { sharedMap, fail, platform }) => {
		const r_db = sharedMap.get('r_db') as DrizzleD1Database;

		let deleted = 0;
		for (const uidHex of data.userIds) {
			try {
				await purgeUser({
					r_db,
					u_id_hex: uidHex,
					userNamespace: platform.env.USER_D0_PROD,
					sessionNamespace: platform.env.USER_SESSION_PROD,
				});
				deleted++;
			} catch (error) {
				return fail(500, serializeActionError(error));
			}
		}

		return { deleted };
	},
	zod$({ userIds: z.array(z.string()) }),
);

export const useLoadEmails = routeAction$(
	async (data, { platform }) => {
		const doNamespace = platform.env.USER_D0_PROD;
		const results: Record<string, string> = {};
		for (const entry of data.users) {
			if (!entry.doIdHex) {
				results[entry.uidHex] = 'N/A';
				continue;
			}
			const doId = entry.jurisdiction ? doNamespace.jurisdiction(entry.jurisdiction).idFromString(entry.doIdHex) : doNamespace.idFromString(entry.doIdHex);
			const doStub = doNamespace.get(doId);
			const { email } = await doStub.getProperties({ email: true }, true).catch(() => ({ email: undefined }));
			results[entry.uidHex] = email ?? 'N/A';
		}

		return { emails: results };
	},
	zod$({
		users: z.array(
			z.object({
				uidHex: z.string(),
				doIdHex: z.string(),
				jurisdiction: z.nativeEnum(DOJurisdictions).nullable(),
			}),
		),
	}),
);

export const head: DocumentHead = {
	title: 'Users — EaaS Admin',
};

export default component$(() => {
	const loc = useLocation();
	const pageData = useUsersPage();
	const doInstancesData = useDurableObjects();
	const deleteUsersAction = useDeleteUsers();
	const loadEmailsAction = useLoadEmails();
	const addUserAction = useAddUser();
	const assignTenantAction = useAssignTenant();

	const searchQuery = useSignal('');
	const selectedIds = useStore<Record<string, boolean>>({});
	const loadingEmails = useSignal(false);
	const showAddUser = useSignal(false);
	const newUserEmail = useSignal('');
	const newUserPlacement = useSignal<UserDoPlacement>('none');
	const showAssignModal = useSignal(false);
	const assignTargetIds = useSignal<string[]>([]);
	const actionError = useSignal('');
	const resolvedUsers = useSignal<{ u_id: string; do_id?: string; jurisdiction: DOJurisdictions | null }[]>([]);

	const selectedCount = useComputed$(() => Object.values(selectedIds).filter(Boolean).length);

	const getSelectedIds = $(() =>
		Object.entries(selectedIds)
			.filter(([, v]) => v)
			.map(([k]) => k),
	);

	const toggleSelectAll = $((userIds: string[]) => {
		const allSelected = userIds.every((id) => selectedIds[id]);
		for (const id of userIds) {
			selectedIds[id] = !allSelected;
		}
	});

	const handleDeleteSelected = $(async () => {
		const ids = await getSelectedIds();
		if (ids.length === 0) return;
		if (!window.confirm(`Are you sure you want to delete ${ids.length} user(s)?`)) return;
		const result = await deleteUsersAction.submit({ userIds: ids });
		if (result.value.failed) {
			actionError.value = result.value.message ?? '';
			return;
		}
		for (const id of ids) {
			delete selectedIds[id];
		}
	});

	const handleLoadEmails = $(async () => {
		const ids = await getSelectedIds();
		if (ids.length === 0) return;
		const users = resolvedUsers.value.filter((u) => ids.includes(u.u_id) && u.do_id).map((u) => ({ uidHex: u.u_id, doIdHex: u.do_id!, jurisdiction: u.jurisdiction }));
		if (users.length === 0) return;
		loadingEmails.value = true;
		const result = await loadEmailsAction.submit({ users });
		loadingEmails.value = false;
		if (result.value.failed) {
			actionError.value = result.value.formErrors[0] ?? 'Failed to load emails.';
			return;
		}
	});

	const handleAddUser = $(async () => {
		const email = newUserEmail.value.trim();
		if (!email) return;
		const result = await addUserAction.submit({ email, placement: newUserPlacement.value });
		if (result.value.failed) {
			actionError.value = result.value.message ?? '';
			return;
		}
		newUserEmail.value = '';
		newUserPlacement.value = 'none';
		showAddUser.value = false;
	});

	const handleAssignSelectedTenant = $(async () => {
		const ids = await getSelectedIds();
		if (ids.length === 0) return;
		assignTargetIds.value = ids;
		showAssignModal.value = true;
	});

	const handleAssignTenant = $(async (tenantId: string) => {
		const ids = assignTargetIds.value;
		if (ids.length === 0 || !tenantId) return;
		const result = await assignTenantAction.submit({ userIds: ids, tenantId });
		if (result.value.failed) {
			actionError.value = result.value.message ?? '';
			return;
		}
		showAssignModal.value = false;
		assignTargetIds.value = [];
	});

	/** Build a sort URL — toggles direction if same column, otherwise defaults to desc */
	const sortUrl = (col: SortColumn, sortCol: SortColumn, sortDir: SortDir) => {
		const params = new URLSearchParams(loc.url.search);
		params.set('sort', col);
		const currentDir = sortCol === col ? sortDir : null;
		params.set('dir', currentDir === 'desc' ? 'asc' : 'desc');
		params.set('page', '1');
		return `?${params.toString()}`;
	};

	const SortIcon = (col: SortColumn, sortCol: SortColumn, sortDir: SortDir) => {
		if (sortCol !== col) return <LuArrowUpDown class="ml-1 inline h-3 w-3 opacity-40" />;
		return sortDir === 'asc' ? <LuArrowUp class="ml-1 inline h-3 w-3" /> : <LuArrowDown class="ml-1 inline h-3 w-3" />;
	};

	return (
		<section class="px-4 py-6">
			{/* Header */}
			<div class="mb-6 flex flex-col gap-4 sm:flex-row sm:items-center sm:justify-between">
				<h1 class="text-heading text-2xl font-bold dark:text-white">Users</h1>
				<button type="button" class="inline-flex items-center gap-1.5 rounded-lg bg-green-600 px-4 py-2 text-sm font-medium text-white hover:bg-green-700" onClick$={() => (showAddUser.value = !showAddUser.value)}>
					<LuPlus class="h-4 w-4" />
					Add User
				</button>
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

			{/* Add User Form */}
			{showAddUser.value && (
				<div class="border-default-medium bg-surface-light dark:bg-surface-dark mb-4 flex flex-col gap-3 border p-4 lg:flex-row lg:items-center">
					<input type="email" placeholder="Enter user email…" class="border-default-medium bg-deep-light text-body block flex-1 rounded-lg border p-2.5 text-sm focus:border-blue-500 focus:ring-blue-500 dark:border-gray-600 dark:bg-gray-700 dark:text-white dark:placeholder-gray-400" bind:value={newUserEmail} />
					<label class="flex min-w-0 flex-col gap-1 text-sm lg:w-80">
						<span class="text-body-subtle dark:text-gray-400">Durable Object jurisdiction</span>
						<select class="border-default-medium bg-deep-light text-body block rounded-lg border p-2.5 text-sm focus:border-blue-500 focus:ring-blue-500 dark:border-gray-600 dark:bg-gray-700 dark:text-white" bind:value={newUserPlacement}>
							<optgroup label="Automatic">
								<option value="none">None</option>
							</optgroup>
							<optgroup label="Jurisdictions">
								{DO_JURISDICTION_OPTIONS.map(([label, value]) => (
									<option key={`jurisdiction:${value}`} value={`jurisdiction:${value}`}>
										{label}
									</option>
								))}
							</optgroup>
						</select>
					</label>
					<button type="button" class="inline-flex items-center gap-1.5 rounded-lg bg-green-600 px-4 py-2 text-sm font-medium text-white hover:bg-green-700 disabled:opacity-50" disabled={!newUserEmail.value.trim()} onClick$={handleAddUser}>
						Create
					</button>
					<button type="button" class="text-body-subtle text-sm hover:underline dark:text-gray-400" onClick$={() => (showAddUser.value = false)}>
						Cancel
					</button>
				</div>
			)}

			<UsersToolbar searchQuery={searchQuery} selectedCount={selectedCount.value} loadingEmails={loadingEmails.value} onLoadEmails$={handleLoadEmails} onDeleteSelected$={handleDeleteSelected} onAssignTenant$={handleAssignSelectedTenant} />

			{/* Assign Tenant Modal */}
			{showAssignModal.value && <AssignTenantModal onAssign$={handleAssignTenant} onClose$={() => (showAssignModal.value = false)} />}

			{/* Table */}
			<Resource
				value={pageData}
				onPending={() => (
					<div class="px-4 py-8 text-center">
						<span class="text-body-subtle dark:text-gray-500">Loading users…</span>
					</div>
				)}
				onResolved={(data) => {
					resolvedUsers.value = data.users;
					return (
						<>
							<div class="overflow-x-auto">
								<table class="text-body w-full text-left text-sm dark:text-gray-400">
									<thead class="bg-surface-light text-body-subtle text-xs uppercase dark:bg-gray-700 dark:text-gray-400">
										<tr>
											<th scope="col" class="px-4 py-3">
												<input type="checkbox" class="border-default-medium h-4 w-4 rounded bg-gray-100 text-blue-600 focus:ring-2 focus:ring-blue-500 dark:border-gray-600 dark:bg-gray-700 dark:ring-offset-gray-800" checked={data.users.length > 0 && data.users.every((u) => selectedIds[u.u_id])} onChange$={() => toggleSelectAll(data.users.map((u) => u.u_id))} />
											</th>
											<th scope="col" class="px-4 py-3">
												<a href={sortUrl('u_id', data.sortCol, data.sortDir)} class="inline-flex items-center hover:underline">
													User ID
													{SortIcon('u_id', data.sortCol, data.sortDir)}
												</a>
											</th>
											<th scope="col" class="px-4 py-3">
												<a href={sortUrl('do_id', data.sortCol, data.sortDir)} class="inline-flex items-center hover:underline">
													Database ID
													{SortIcon('do_id', data.sortCol, data.sortDir)}
												</a>
											</th>
											<th scope="col" class="px-4 py-3">
												Email
											</th>
											<th scope="col" class="px-4 py-3">
												Root
											</th>
											<th scope="col" class="px-4 py-3">
												DO
											</th>
											<th scope="col" class="px-4 py-3">
												Signed In
											</th>
											<th scope="col" class="px-4 py-3">
												Actions
											</th>
										</tr>
									</thead>
									<tbody>
										<Resource
											value={doInstancesData}
											onPending={() =>
												data.users.map((user) => {
													const doIdHex = user.do_id ?? '';

													return (
														<UserRow
															key={String(user.u_id)}
															uidHex={String(user.u_id)}
															uidBase64Url={String(user.u_id_b64)}
															doIdHex={String(doIdHex)}
															jurisdiction={user.jurisdiction}
															userInit={user.user_init}
															doInstanceExists={false}
															selected={!!selectedIds[user.u_id]}
															onToggleSelect$={() => {
																selectedIds[user.u_id] = !selectedIds[user.u_id];
															}}
															onDelete$={async () => {
																if (!window.confirm('Are you sure you want to delete this user?')) return;
																await deleteUsersAction.submit({ userIds: [user.u_id] });
																delete selectedIds[user.u_id];
															}}
															onAssignTenant$={() => {
																assignTargetIds.value = [user.u_id];
																showAssignModal.value = true;
															}}
														/>
													);
												})
											}
											onResolved={(doInstances) =>
												data.users.map((user) => {
													const doIdHex = user.do_id ?? '';

													return (
														<UserRow
															key={String(user.u_id)}
															uidHex={String(user.u_id)}
															uidBase64Url={String(user.u_id_b64)}
															doIdHex={String(doIdHex)}
															jurisdiction={user.jurisdiction}
															userInit={user.user_init}
															doInstanceExists={doIdHex ? (doInstances[doIdHex] ?? false) : false}
															selected={!!selectedIds[user.u_id]}
															onToggleSelect$={() => {
																selectedIds[user.u_id] = !selectedIds[user.u_id];
															}}
															onDelete$={async () => {
																if (!window.confirm('Are you sure you want to delete this user?')) return;
																await deleteUsersAction.submit({ userIds: [user.u_id] });
																delete selectedIds[user.u_id];
															}}
															onAssignTenant$={() => {
																assignTargetIds.value = [user.u_id];
																showAssignModal.value = true;
															}}
														/>
													);
												})
											}
										/>
										{data.users.length === 0 && (
											<tr>
												<td colSpan={8} class="px-4 py-8 text-center">
													<span class="text-body-subtle dark:text-gray-500">No users found.</span>
												</td>
											</tr>
										)}
									</tbody>
								</table>
							</div>

							{/* Pagination */}
							<Pagination page={data.page} totalPages={data.totalPages} totalItems={data.totalItems} pageSize={PAGE_SIZE} />
						</>
					);
				}}
			/>
		</section>
	);
});
