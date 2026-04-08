import { Slot, component$, useSignal } from '@builder.io/qwik';
import { Link, useLocation } from '@builder.io/qwik-city';
import { LuMenu, LuX } from '@qwikest/icons/lucide';
import { Permissions } from 'types';
import * as zm from 'zod/mini';
import TenantSelector from '~/components/sidebar/tenant-selector/tenant-selector';
import UserWidget from '~/components/sidebar/user-widget/user-widget';
import { usePermissions } from '~/routes/(team)/[tenantId]/layout';

// eslint-disable-next-line @typescript-eslint/ban-ts-comment
// @ts-ignore this gets generated automatically later in the build process
import * as m from '~/paraglide/messages';

export default component$(() => {
	const sidebarOpen = useSignal(false);
	const location = useLocation();

	const pathParts = location.url.pathname.split('/').filter(Boolean);
	const isTenantScope = zm.regexes.base64url.test(pathParts[0] ?? '') && (pathParts[0] ?? '').length === 22;
	const tenantId = isTenantScope ? pathParts[0] : null;
	const usersPath = tenantId ? `/${tenantId}/users` : '/';
	const isUsersRoute = location.url.pathname === usersPath || location.url.pathname === `${usersPath}/`;

	return (
		<div class="flex h-dvh min-h-0 overflow-hidden">
			{/* Mobile backdrop */}
			{sidebarOpen.value && (
				<div
					class="fixed inset-0 z-30 bg-black/40 backdrop-blur-sm lg:hidden"
					onClick$={() => {
						sidebarOpen.value = false;
					}}
				/>
			)}

			{/* Sidebar */}
			<aside class={['border-surface-light/60 dark:border-surface-dark/60 dark:bg-surface-dark/70 fixed inset-y-0 left-0 z-40 flex h-dvh w-64 flex-col border-r bg-white/80 backdrop-blur-xl transition-transform duration-200 lg:static lg:h-full lg:translate-x-0', sidebarOpen.value ? 'translate-x-0' : '-translate-x-full']}>
				{/* Tenant selector at top */}
				<TenantSelector />

				{/* Navigation area */}
				<nav class="flex-1 overflow-y-auto px-3 py-2">
					{isTenantScope ? (
						<div class="space-y-2">
							{tenantId ? <TenantNavigation tenantId={tenantId} pathname={location.url.pathname} /> : null}
							<p class="px-2 text-xs font-semibold tracking-wide text-gray-500 uppercase dark:text-gray-400">{m.sidebar_group_settings()}</p>
							<Link prefetch="js" href={usersPath} class={['block rounded-lg px-2.5 py-2 text-sm font-medium transition-colors', isUsersRoute ? 'bg-primary-accent/10 text-primary-accent dark:bg-primary-accent/20' : 'text-gray-600 hover:bg-gray-100 dark:text-gray-300 dark:hover:bg-gray-800/60']}>
								{m.sidebar_group_users()}
							</Link>
						</div>
					) : null}
				</nav>

				{/* User widget at bottom */}
				<UserWidget />
			</aside>

			{/* Main content */}
			<div class="flex min-h-0 min-w-0 flex-1 flex-col overflow-hidden">
				{/* Mobile hamburger bar */}
				<div class="border-surface-light/60 dark:border-surface-dark/60 flex items-center border-b px-4 py-2 lg:hidden">
					<button
						type="button"
						class="rounded-lg p-2 text-gray-500 transition-colors hover:bg-gray-100 dark:text-gray-400 dark:hover:bg-gray-800/60"
						onClick$={() => {
							sidebarOpen.value = !sidebarOpen.value;
						}}>
						{sidebarOpen.value ? <LuX class="h-5 w-5" /> : <LuMenu class="h-5 w-5" />}
					</button>
				</div>

				{/* Page content */}
				<main class="flex-1 overflow-y-auto">
					<Slot />
				</main>
			</div>
		</div>
	);
});

interface TenantNavigationProps {
	tenantId: string;
	pathname: string;
}

const TenantNavigation = component$<TenantNavigationProps>(({ tenantId, pathname }) => {
	const permissions = usePermissions();
	const apiKeysPath = `/${tenantId}/api-keys`;
	const isApiKeysRoute = pathname === apiKeysPath || pathname === `${apiKeysPath}/`;
	const canReadApiKeys = Boolean(permissions.value && permissions.value.r_apikeys >= Permissions.Read);

	if (!canReadApiKeys) return null;

	return (
		<>
			<p class="px-2 text-xs font-semibold tracking-wide text-gray-500 uppercase dark:text-gray-400">{m.users_permission_tenant()}</p>
			<Link prefetch="js" href={apiKeysPath} class={['block rounded-lg px-2.5 py-2 text-sm font-medium transition-colors', isApiKeysRoute ? 'bg-primary-accent/10 text-primary-accent dark:bg-primary-accent/20' : 'text-gray-600 hover:bg-gray-100 dark:text-gray-300 dark:hover:bg-gray-800/60']}>
				{m.users_permission_apikeys()}
			</Link>
		</>
	);
});
