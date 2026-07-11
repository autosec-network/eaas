import { Resource, component$, useSignal, useVisibleTask$ } from '@builder.io/qwik';
import { Link, useNavigate } from '@builder.io/qwik-city';
import { LuPlus } from '@qwikest/icons/lucide';
import TenantRow from '~/components/team/tenant-row/tenant-row';
import { useTenants } from '~/routes/layout';

// eslint-disable-next-line @typescript-eslint/ban-ts-comment
// @ts-ignore this gets generated automatically later in the build process
import * as m from '~/paraglide/messages';

export default component$(() => {
	const tenants = useTenants();
	const nav = useNavigate();
	const redirect = useSignal<string | null>(null);

	// eslint-disable-next-line qwik/no-use-visible-task
	useVisibleTask$(async ({ track }) => {
		track(() => redirect.value);

		if (redirect.value) await nav(redirect.value);
	});

	return (
		<div class="mx-auto max-w-lg px-6 py-10">
			<div class="mb-8 flex items-center justify-between">
				<div>
					<h1 class="text-2xl font-bold tracking-tight text-gray-900 dark:text-white">{m.team_page_title()}</h1>
					<p class="mt-1 text-sm text-gray-500 dark:text-gray-400">{m.team_page_subtitle()}</p>
				</div>
				<Link prefetch="js" href="/onboarding/" class="bg-primary-accent hover:bg-primary-accent/85 hover:shadow-primary-accent/25 inline-flex items-center gap-2 rounded-xl px-5 py-2.5 text-sm font-medium text-white transition-all duration-150 hover:shadow-md active:scale-[0.98]">
					<LuPlus class="h-4 w-4" />
					{m.team_page_new_team()}
				</Link>
			</div>

			<Resource
				value={tenants}
				onPending={() => (
					<div class="space-y-3">
						<div class="h-24 animate-pulse rounded-2xl bg-gray-200 dark:bg-gray-700" />
					</div>
				)}
				onResolved={(tenantList) => {
					if (tenantList.length < 1) {
						redirect.value = '/onboarding';
					} else if (tenantList.length === 1) {
						const { t_id } = tenantList[0]!;
						// go into tenant
						redirect.value = `/${t_id.base64url}`;
					} else {
						// Go to tenant page
						return (
							<ul class="space-y-3">
								{tenantList.map((tenant) => (
									<li key={tenant.t_id.base64}>
										<Link prefetch="js" href={`/${tenant.t_id.base64url}/`} class="border-surface-light/60 shadow-primary-accent/5 dark:border-surface-dark/60 dark:bg-surface-dark/70 group hover:shadow-primary-accent/10 inline-block w-full rounded-2xl border bg-white/70 shadow-sm backdrop-blur-md transition-all duration-150 hover:shadow-md">
											<TenantRow jurisdiction={tenant.jurisdiction} do_id={tenant.do_id} />
										</Link>
									</li>
								))}
							</ul>
						);
					}
					return <p class="text-black dark:text-white">{m.common_redirecting()}</p>;
				}}
			/>
		</div>
	);
});
