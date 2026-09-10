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
import * as zm from 'zod/mini';
import { UserTabs } from '~/components/user-tabs/user-tabs';
import { actionErrorMessage } from '~/routes/[environment]/tenants/db-helpers';
import { lookupDoInstances, serializeActionError } from '~/routes/[environment]/tenants/tenant-ops';
import { calcInitDaysLeft, calcInitProgress, hexToUuid } from '~/routes/[environment]/users/db-helpers';
import { purgeUser, resolveUserDoId, userIdParamSchema, type UserDoStub } from '~/routes/[environment]/users/user-ops';
import { useCfAccountId } from '~/routes/layout';

/**
 * Resolves everything the tabs below need: the root lookup row and the user's Durable Object. A user with no root row still resolves (its DO id is derivable from `u_id`) so drift stays inspectable instead of 404ing.
 */
export const onRequest: RequestHandler = async ({ params, sharedMap, platform, next, redirect }) => {
	if (zm.validate(userIdParamSchema, params['uid'])) {
		const u_id_hex = await import('node:buffer').then(({ Buffer }) => Buffer.from(params['uid']!, 'base64url').toString('hex'));
		const r_db = sharedMap.get('r_db') as DrizzleD1Database;

		const [user] = await r_db
			.select({
				jurisdiction: rootSchema.users.jurisdiction,
				do_id: rootSchema.users.do_id,
				user_init: rootSchema.users.user_init,
			})
			.from(rootSchema.users)
			.where(eq(rootSchema.users.u_id, sql`unhex(${u_id_hex})`))
			.limit(1)
			.then((rows) =>
				rows.map((row) => ({
					...row,
					do_id: row.do_id?.toString('hex') ?? null,
				})),
			);

		const jurisdiction = user?.jurisdiction ?? null;
		sharedMap.set('u_id_hex', u_id_hex);
		sharedMap.set('u_jurisdiction', jurisdiction);
		sharedMap.set('u_root_exists', Boolean(user));
		// What root says the durable object is, as opposed to the id derived below — `null` until the user's first sign in mints one
		sharedMap.set('u_root_do_id_hex', user?.do_id ?? null);
		sharedMap.set('u_user_init', user?.user_init ?? false);

		const doNamespace = platform.env.USER_D0_PROD;
		const doId = resolveUserDoId(doNamespace, jurisdiction, u_id_hex, user?.do_id);
		const doStub = doNamespace.get(doId);
		sharedMap.set('u_do', doStub);
		sharedMap.set('u_do_id_hex', doId.toString());

		const browserCache = sharedMap.get('browserCache') as boolean;
		sharedMap.set(
			'u_db',
			drizzleD0(doStub, {
				...(platform.env.NODE_ENV !== 'production' && { logger: new DefaultLogger({ writer: new DebugLogWriter(doId.toString()) }) }),
				cache: new SQLCache(
					{
						dbName: doId.toString(),
						dbType: 'do',
						strategy: browserCache ? 'all' : 'explicit',
						cacheTTL: parseInt(platform.env.SQL_TTL, 10),
						// eslint-disable-next-line @typescript-eslint/no-unnecessary-condition
						logging: platform.env.NODE_ENV !== 'production',
					},
					// eslint-disable-next-line @typescript-eslint/no-unnecessary-condition
					globalThis.caches ?? platform.caches,
				),
			}),
		);

		await next();
	} else {
		throw redirect(302, `/${params['environment']}/users/`);
	}
};

export const useUserIds = routeLoader$(({ params }) =>
	import('node:buffer')
		.then(({ Buffer }) => Buffer.from(params['uid']!, 'base64url'))
		.then((buf) => ({
			utf8: hexToUuid(buf.toString('hex')),
			hex: buf.toString('hex'),
			base64: buf.toString('base64'),
			base64url: buf.toString('base64url'),
		})),
);

/** Root lookup row vs. the live Durable Object — the header states both, so drift is visible from every tab */
export const useUserOverview = routeLoader$(({ sharedMap, platform }) => {
	const u_do = sharedMap.get('u_do') as UserDoStub;
	const u_id_hex = sharedMap.get('u_id_hex') as string;
	const u_do_id_hex = sharedMap.get('u_do_id_hex') as string;
	const rootDoIdHex = sharedMap.get('u_root_do_id_hex') as string | null;
	const jurisdiction = sharedMap.get('u_jurisdiction') as DOJurisdictions | null;
	const rootExists = sharedMap.get('u_root_exists') as boolean;
	const userInit = sharedMap.get('u_user_init') as boolean;

	return async () => {
		const cf = new Cloudflare({ apiToken: platform.env.CF_API_TOKEN });

		// Reading properties would bring the durable object into existence, so a user who has never signed in is left alone
		const [properties, doInstances] = await Promise.all([rootDoIdHex ? u_do.getProperties({ email: true }, true).catch(() => ({}) as Record<string, never>) : Promise.resolve({} as Record<string, never>), lookupDoInstances(cf, platform.env.CF_ACCOUNT_ID, StaticDatabase.User.Main['eaas-api-prod_UserD0'], [u_do_id_hex])]);

		const email = 'email' in properties && typeof properties.email === 'string' ? properties.email : null;

		return {
			email,
			// Gravatar hashes the email itself, so nothing identifying leaves this worker beyond what the browser then asks for
			gravatarUrl: email ? await import('node:crypto').then(({ createHash }) => `https://gravatar.com/avatar/${createHash('sha256').update(email.trim().toLowerCase()).digest('hex')}?d=robohash`) : null,
			jurisdiction,
			rootExists,
			u_do_id_hex,
			doExists: doInstances[u_do_id_hex] ?? false,
			userInit,
			initProgress: userInit ? null : calcInitProgress(u_id_hex),
			initDaysLeft: userInit ? null : calcInitDaysLeft(u_id_hex),
		};
	};
});

export const useDeleteUser = routeAction$(async (_data, { sharedMap, platform, fail }) => {
	const r_db = sharedMap.get('r_db') as DrizzleD1Database;
	const u_id_hex = sharedMap.get('u_id_hex') as string;

	return purgeUser({
		r_db,
		u_id_hex,
		userNamespace: platform.env.USER_D0_PROD,
		sessionNamespace: platform.env.USER_SESSION_PROD,
	})
		.then(() => ({ deleted: true }))
		.catch((err: unknown) => fail(500, serializeActionError(err)));
});

export default component$(() => {
	const loc = useLocation();
	const nav = useNavigate();
	const ids = useUserIds();
	const overview = useUserOverview();
	const deleteUserAction = useDeleteUser();
	const cfAccountId = useCfAccountId();

	const actionError = useSignal('');

	const handleDelete = $(async () => {
		if (!window.confirm('Are you sure you want to delete this user? This wipes their durable object, every session durable object they hold, and every root reference to them.')) return;

		const result = await deleteUserAction.submit({});
		if (result.value.failed) {
			actionError.value = actionErrorMessage(result.value, 'Failed to delete user.');
			return;
		}

		await nav(`/${loc.params['environment']}/users/`);
	});

	return (
		<section class="px-4 py-6">
			{/* Header */}
			<div class="mb-4 flex flex-col gap-4 sm:flex-row sm:items-start sm:justify-between">
				<div>
					<Resource
						value={overview}
						onPending={() => <h1 class="text-heading text-2xl font-bold dark:text-white">User</h1>}
						onResolved={(data) => (
							<div class="flex items-center gap-3">
								{data.gravatarUrl ? <img src={data.gravatarUrl} alt="User avatar" width={40} height={40} class="rounded-full" /> : null}
								<h1 class="text-heading text-2xl font-bold break-all dark:text-white">{data.email ?? 'User'}</h1>
								{data.jurisdiction ? <span class="inline-flex items-center rounded-full bg-blue-100 px-2 py-0.5 text-xs font-medium text-blue-800 dark:bg-blue-900/30 dark:text-blue-400">{data.jurisdiction}</span> : null}
							</div>
						)}
					/>
					<p class="text-body-subtle mt-1 font-mono text-xs break-all dark:text-gray-400">{ids.value.utf8}</p>
					<p class="text-body-subtle font-mono text-xs break-all dark:text-gray-500">{ids.value.base64url}</p>
				</div>

				<div class="flex flex-col items-start gap-2 sm:items-end">
					<button type="button" class="inline-flex items-center gap-1.5 rounded-lg bg-red-600 px-4 py-2 text-sm font-medium text-white hover:bg-red-700 disabled:opacity-50" disabled={deleteUserAction.isRunning} onClick$={handleDelete}>
						<LuTrash2 class="h-4 w-4" />
						Delete user
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
								<a target="_blank" rel="noopener noreferrer" href={`https://dash.cloudflare.com/${cfAccountId.value}/workers/durable-objects/view/${StaticDatabase.User.Main['eaas-api-prod_UserD0']}/studio?objectId=${data.u_do_id_hex}`} class="text-primary-accent inline-flex items-center gap-1.5 hover:underline">
									{data.doExists ? <LuCheck class="h-3.5 w-3.5 text-green-500" /> : <LuX class="h-3.5 w-3.5 text-red-500" />}
									Durable object
								</a>
								{data.userInit ? (
									<span class="inline-flex items-center gap-1.5">
										<LuCheck class="h-3.5 w-3.5 text-green-500" />
										Signed in
									</span>
								) : (
									<span class="inline-flex items-center gap-1.5" title="A user who never signs in is dropped 30 days after being created">
										<progress class="h-2 w-24" value={data.initProgress ?? 0} max={100} style={{ accentColor: `hsl(${((data.initProgress ?? 0) / 100) * 120}, 80%, 45%)` }} />
										{data.initDaysLeft ?? 0}d left to sign in
									</span>
								)}
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

			<UserTabs />

			<div class="mt-6">
				<Slot />
			</div>
		</section>
	);
});
