import { component$ } from '@builder.io/qwik';
import { Link, useLocation } from '@builder.io/qwik-city';
import { TENANT_TABS } from '~/routes/[environment]/tenants/db-helpers';

/** Each tab is its own route segment, so the active tab (and whatever filters it holds in its query string) is always in the URL */
export const TenantTabs = component$(() => {
	const loc = useLocation();
	const base = `/${loc.params['environment']}/tenants/${loc.params['tid']}`;

	return (
		<nav class="border-default-medium flex flex-wrap gap-1 border-b dark:border-gray-700" aria-label="Tenant sections">
			{TENANT_TABS.map((tab) => {
				const href = `${base}/${tab.segment}/`;
				const active = loc.url.pathname === href || loc.url.pathname.startsWith(href);

				return (
					<Link key={tab.segment} prefetch="js" href={href} aria-current={active ? 'page' : undefined} class={['-mb-px border-b-2 px-4 py-2 text-sm font-medium', active ? 'border-primary-accent text-primary-accent' : 'text-body-subtle hover:text-heading border-transparent dark:text-gray-400 dark:hover:text-gray-200'].join(' ')}>
						{tab.label}
					</Link>
				);
			})}
		</nav>
	);
});
