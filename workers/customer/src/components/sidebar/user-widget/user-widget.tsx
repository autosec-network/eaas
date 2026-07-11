import { component$ } from '@builder.io/qwik';
import { Form, Link } from '@builder.io/qwik-city';
import { LuBookOpen, LuBug, LuLogOut, LuRadioTower, LuSettings, LuShieldAlert } from '@qwikest/icons/lucide';
import { useSession, useSignOut } from '~/routes/plugin@auth';

// eslint-disable-next-line @typescript-eslint/ban-ts-comment
// @ts-ignore this gets generated automatically later in the build process
import * as m from '~/paraglide/messages';

export default component$(() => {
	const session = useSession();
	const user = session.value!.user!;
	const signOut = useSignOut();
	const triggerId = 'user-widget-trigger';
	const dropdownId = 'user-widget-dropdown';

	return (
		<div class="relative border-t border-gray-200 px-3 pt-2 pb-3 dark:border-gray-700/60">
			<button id={triggerId} type="button" data-dropdown-toggle={dropdownId} data-dropdown-placement="top-start" data-dropdown-offset-distance="4" class="flex w-full items-center gap-2.5 rounded-xl px-2 py-2 text-left transition-colors hover:bg-gray-100 dark:hover:bg-gray-800/60">
				{user.image ? <img src={user.image} alt={user.email ?? ''} width={32} height={32} class="h-8 w-8 shrink-0 rounded-full object-cover" /> : <div class="bg-primary-accent/10 text-primary-accent dark:bg-primary-accent/20 flex h-8 w-8 shrink-0 items-center justify-center rounded-full text-xs font-bold">{user.email?.charAt(0).toUpperCase() ?? '?'}</div>}
				<span class="min-w-0 flex-1 truncate text-sm text-gray-700 dark:text-gray-300">{user.email ?? m.sidebar_user_unknown()}</span>
			</button>

			<div id={dropdownId} class="border-surface-light/60 dark:border-surface-dark/60 dark:bg-surface-dark absolute right-3 bottom-full left-3 z-50 mb-1 hidden w-58 overflow-hidden rounded-xl border bg-white shadow-lg" aria-labelledby={triggerId}>
				<ul class="py-1">
					{/* Status page - no-op */}
					<li>
						<span class="flex cursor-not-allowed items-center gap-2.5 px-3 py-2 text-sm text-gray-400 dark:text-gray-500">
							<LuRadioTower class="h-4 w-4" />
							{m.sidebar_menu_status()}
						</span>
					</li>
					{/* API docs */}
					<li>
						<a href="https://api.eaas.autosec.network" target="_blank" rel="noopener noreferrer" class="flex items-center gap-2.5 px-3 py-2 text-sm text-gray-700 transition-colors hover:bg-gray-50 dark:text-gray-300 dark:hover:bg-gray-800/60">
							<LuBookOpen class="h-4 w-4" />
							{m.sidebar_menu_api_docs()}
						</a>
					</li>
					{/* Vulnerability - no-op */}
					<li>
						<span class="flex cursor-not-allowed items-center gap-2.5 px-3 py-2 text-sm text-gray-400 dark:text-gray-500">
							<LuShieldAlert class="h-4 w-4" />
							{m.sidebar_menu_vulnerability()}
						</span>
					</li>
					{/* Support */}
					<li>
						<a href="https://github.com/autosec-network/eaas/issues" target="_blank" rel="noopener noreferrer" class="flex items-center gap-2.5 px-3 py-2 text-sm text-gray-700 transition-colors hover:bg-gray-50 dark:text-gray-300 dark:hover:bg-gray-800/60">
							<LuBug class="h-4 w-4" />
							{m.sidebar_menu_support()}
						</a>
					</li>
					{/* User settings */}
					<li>
						<Link prefetch="js" href="/settings" class="flex items-center gap-2.5 px-3 py-2 text-sm text-gray-700 transition-colors hover:bg-gray-50 dark:text-gray-300 dark:hover:bg-gray-800/60">
							<LuSettings class="h-4 w-4" />
							{m.sidebar_menu_settings()}
						</Link>
					</li>
				</ul>

				{/* Sign out */}
				<div class="border-t border-gray-200 dark:border-gray-700/60">
					<Form action={signOut}>
						<input type="hidden" name="redirectTo" value="/login" />
						<button type="submit" class="flex w-full items-center gap-2.5 px-3 py-2 text-sm text-red-600 transition-colors hover:bg-red-50 dark:text-red-400 dark:hover:bg-red-900/20">
							<LuLogOut class="h-4 w-4" />
							{m.sidebar_menu_sign_out()}
						</button>
					</Form>
				</div>

				{/* Debug info */}
				<div class="border-t border-gray-200 px-3 py-2 dark:border-gray-700/60">
					<p class="text-2xs truncate text-gray-400 dark:text-gray-500">
						{m.sidebar_debug_user_id()}: {user.u_id.base64url}
					</p>
					{session.value?.do_id && (
						<p class="text-2xs truncate text-gray-400 dark:text-gray-500">
							{m.sidebar_debug_session_id()}: {session.value.do_id}
						</p>
					)}
				</div>
			</div>
		</div>
	);
});
