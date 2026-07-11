import { Resource, component$, useResource$, useSignal, useVisibleTask$ } from '@builder.io/qwik';
import { Link } from '@builder.io/qwik-city';
import { LuChevronsUpDown, LuPlus } from '@qwikest/icons/lucide';
import type { DOJurisdictions } from 'types';
import { getTenantPickerProperties, useTenants } from '~/routes/layout';

// eslint-disable-next-line @typescript-eslint/ban-ts-comment
// @ts-ignore this gets generated automatically later in the build process
import * as m from '~/paraglide/messages';

/** Mini tenant avatar + name for a single row in the selector dropdown */
const TenantMiniRow = component$<{ jurisdiction: DOJurisdictions | null; do_id: string }>(({ jurisdiction, do_id }) => {
	const rowRef = useSignal<HTMLElement>();
	const isVisible = useSignal(false);

	// eslint-disable-next-line qwik/no-use-visible-task, @typescript-eslint/unbound-method
	useVisibleTask$(({ track, cleanup }) => {
		if (isVisible.value) {
			return;
		}

		track(() => rowRef.value);
		const element = rowRef.value;
		if (!element) {
			return;
		}

		const observer = new IntersectionObserver(
			(entries) => {
				for (const entry of entries) {
					if (entry.isIntersecting) {
						isVisible.value = true;
						observer.disconnect();
						break;
					}
				}
			},
			{ rootMargin: '96px 0px' },
		);

		observer.observe(element);
		cleanup(() => observer.disconnect());
	});

	const data = useResource$(({ track }) => {
		track(() => isVisible.value);

		if (!isVisible.value) {
			return null;
		}

		return getTenantPickerProperties(jurisdiction, do_id);
	});

	return (
		<div ref={rowRef} class="ml-0.5 w-52">
			<Resource
				value={data}
				onPending={() => (
					<div class="flex w-full items-center gap-2.5">
						<div class="h-7 w-7 animate-pulse rounded-full bg-gray-300 dark:bg-gray-600" />
						<div class="w-full flex-1">
							<div class="h-3.5 w-20 max-w-full animate-pulse rounded bg-gray-300 dark:bg-gray-600" />
						</div>
					</div>
				)}
				onResolved={(tenant) => (
					<div class="flex w-full items-center gap-2.5">
						{tenant?.avatar ? <img src={tenant.avatar} alt={tenant.name ?? ''} width={28} height={28} class="h-7 w-7 rounded-full object-cover" /> : <div class="bg-primary-accent/10 text-primary-accent dark:bg-primary-accent/20 flex h-7 w-7 items-center justify-center rounded-full text-xs font-bold">{tenant?.name?.charAt(0)}</div>}
						<span class="w-full flex-1 truncate text-sm font-medium text-gray-900 dark:text-white">{tenant?.name}</span>
					</div>
				)}
			/>
		</div>
	);
});

export default component$(() => {
	const tenants = useTenants();
	const triggerId = 'tenant-selector-trigger';
	const dropdownId = 'tenant-selector-dropdown';

	return (
		<div class="relative px-3 pt-4 pb-2">
			<Resource
				value={tenants}
				onPending={() => <div class="border-surface-light/60 dark:border-surface-dark/60 h-10 w-full animate-pulse rounded-xl border bg-gray-200 dark:bg-gray-700" />}
				onResolved={(tenantList) => (
					<>
						<button id={triggerId} type="button" data-dropdown-toggle={dropdownId} data-dropdown-placement="bottom-start" data-dropdown-offset-distance="4" class="border-surface-light/60 dark:border-surface-dark/60 dark:bg-surface-dark/50 flex w-full items-center gap-2 rounded-xl border bg-white/70 px-2.5 py-2 text-left transition-colors hover:bg-gray-50 dark:hover:bg-gray-800/60">
							<div class="min-w-0 flex-1">{tenantList.length > 0 ? <TenantMiniRow jurisdiction={tenantList[0]!.jurisdiction} do_id={tenantList[0]!.do_id} /> : <span class="block truncate text-sm text-gray-500 dark:text-gray-400">{m.sidebar_no_teams()}</span>}</div>
							<LuChevronsUpDown class="h-4 w-4 shrink-0 text-gray-400" />
						</button>

						<div id={dropdownId} class="border-surface-light/60 dark:border-surface-dark/60 dark:bg-surface-dark absolute top-full right-0 left-0 z-50 mx-3 mt-1 hidden max-h-[min(22rem,calc(100dvh-12rem))] flex-col overflow-hidden rounded-xl border bg-white shadow-lg" aria-labelledby={triggerId}>
							<ul class="min-h-0 flex-1 overflow-y-auto py-1">
								{tenantList.map((tenant) => (
									<li key={tenant.t_id.base64}>
										<Link prefetch="js" href={`/${tenant.t_id.base64url}/`} class="block px-2.5 py-2 transition-colors hover:bg-gray-50 dark:hover:bg-gray-800/60">
											<TenantMiniRow jurisdiction={tenant.jurisdiction} do_id={tenant.do_id} />
										</Link>
									</li>
								))}
							</ul>
							<div class="border-surface-light/60 dark:border-surface-dark/60 border-t py-1">
								<Link prefetch="js" href="/onboarding/" class="flex items-center gap-2 px-3 py-2 text-sm text-gray-500 transition-colors hover:bg-gray-50 hover:text-gray-700 dark:text-gray-400 dark:hover:bg-gray-800/60 dark:hover:text-gray-300">
									<LuPlus class="h-4 w-4" />
									{m.team_page_new_team()}
								</Link>
								{tenantList.length > 1 && (
									<Link prefetch="js" href="/" class="flex items-center gap-2 px-3 py-2 text-sm text-gray-500 transition-colors hover:bg-gray-50 hover:text-gray-700 dark:text-gray-400 dark:hover:bg-gray-800/60 dark:hover:text-gray-300">
										{m.sidebar_all_teams()}
									</Link>
								)}
							</div>
						</div>
					</>
				)}
			/>
		</div>
	);
});
