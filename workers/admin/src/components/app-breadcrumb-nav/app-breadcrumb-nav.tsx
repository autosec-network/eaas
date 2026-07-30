import { $, component$, useOnDocument, useSignal, useTask$ } from '@builder.io/qwik';
import { Link, useLocation } from '@builder.io/qwik-city';
import { LuChevronDown, LuChevronRight, LuHome } from '@qwikest/icons/lucide';

interface NavNode {
	label: string;
	segment: string;
	children?: NavNode[];
}

/**
 * Navigation tree defining all navigable sections of the admin app.
 * Add new entries here to make them appear in breadcrumb dropdowns.
 */
const NAV_TREE: NavNode[] = [
	{
		label: 'Production',
		segment: 'production',
		children: [
			{
				label: 'Users',
				segment: 'users',
			},
			{
				label: 'Tenant',
				segment: 'tenants',
				children: [
					{
						label: 'Properties',
						segment: 'properties',
					},
					{
						label: 'Users',
						segment: 'users',
					},
					{
						label: 'API Keys',
						segment: 'api-keys',
					},
					{
						label: 'Logs',
						segment: 'logs',
					},
				],
			},
		],
	},
	{
		label: 'Dev',
		segment: 'dev',
		children: [
			{
				label: 'Users',
				segment: 'users',
			},
			{
				label: 'Tenant',
				segment: 'tenants',
				children: [
					{
						label: 'Properties',
						segment: 'properties',
					},
					{
						label: 'Users',
						segment: 'users',
					},
					{
						label: 'API Keys',
						segment: 'api-keys',
					},
					{
						label: 'Logs',
						segment: 'logs',
					},
				],
			},
		],
	},
];

interface BreadcrumbItem {
	label: string;
	href: string;
	isLast: boolean;
	siblings: { label: string; href: string; active: boolean }[];
}

function buildBreadcrumbs(pathname: string, navTree: NavNode[]): BreadcrumbItem[] {
	const segments = pathname.split('/').filter(Boolean);
	const crumbs: BreadcrumbItem[] = [];

	// Home always present; when at root, show next-level navigation options
	const homeNextOptions = segments.length === 0 ? navTree : [];
	crumbs.push({
		label: 'Home',
		href: '/',
		isLast: segments.length === 0,
		siblings: homeNextOptions.map((n) => ({
			label: n.label,
			href: `/${n.segment}/`,
			active: false,
		})),
	});

	let currentChildren = navTree;

	for (let i = 0; i < segments.length; i++) {
		const segment = segments[i]!;
		const prefixParts = segments.slice(0, i);
		const prefix = prefixParts.length > 0 ? `/${prefixParts.join('/')}/` : '/';
		const node = currentChildren.find((n) => n.segment === segment);
		const label = node?.label ?? segment;
		const nextChildren = node?.children ?? [];

		crumbs.push({
			label,
			href: `${prefix}${segment}/`,
			isLast: i === segments.length - 1 && nextChildren.length === 0,
			siblings: currentChildren.map((n) => ({
				label: n.label,
				href: `${prefix}${n.segment}/`,
				active: n.segment === segment,
			})),
		});

		// If this is the last segment and has children, add a "next" crumb for navigating deeper
		if (i === segments.length - 1 && nextChildren.length > 0) {
			crumbs.push({
				label: '',
				href: '',
				isLast: true,
				siblings: nextChildren.map((n) => ({
					label: n.label,
					href: `${prefix}${segment}/${n.segment}/`,
					active: false,
				})),
			});
		}

		currentChildren = nextChildren;
	}

	return crumbs;
}

export const AppBreadcrumbNav = component$(() => {
	const loc = useLocation();
	const openDropdown = useSignal(-1);

	const breadcrumbs = buildBreadcrumbs(loc.url.pathname, NAV_TREE);

	// Close dropdown when URL changes (after SPA navigation completes)
	useTask$(({ track }) => {
		track(() => loc.url.pathname);
		openDropdown.value = -1;
	});

	useOnDocument(
		'click',
		$((e: Event) => {
			if ((e.target as Element).closest('[data-nav-dropdown]')) return;
			openDropdown.value = -1;
		}),
	);

	return (
		<nav class="flex items-center px-4 py-3" aria-label="Breadcrumb">
			<ol class="inline-flex items-center space-x-1 md:space-x-2 rtl:space-x-reverse">
				{breadcrumbs.map((crumb, idx) => (
					<li key={idx} class={idx === 0 ? 'inline-flex items-center' : undefined}>
						<div class="flex items-center space-x-1.5">
							{/* Chevron separator (skip for first item) */}
							{idx > 0 && <LuChevronRight class="text-body h-3.5 w-3.5 rtl:rotate-180 dark:text-gray-400" />}

							{crumb.siblings.length > 0 ? (
								/* Breadcrumb segment with dropdown */
								<div class="relative">
									<button
										type="button"
										onClick$={(e) => {
											e.stopPropagation();
											openDropdown.value = openDropdown.value === idx ? -1 : idx;
										}}
										class={['inline-flex items-center text-sm font-medium', crumb.isLast ? 'text-body-subtle hover:text-heading dark:text-gray-400 dark:hover:text-gray-200' : 'text-body hover:text-fg-brand dark:text-gray-300 dark:hover:text-blue-400'].join(' ')}>
										{idx === 0 && <LuHome class="me-1.5 h-4 w-4" />}
										{crumb.label || '...'}
										<LuChevronDown class="ms-1 h-3.5 w-3.5" />
									</button>

									{openDropdown.value === idx && (
										<div data-nav-dropdown class="border-default-medium bg-surface-light dark:bg-surface-dark absolute top-full left-0 z-10 mt-1 w-44 border py-1" onClick$={(e: PointerEvent) => e.stopPropagation()}>
											<ul class="text-body text-sm dark:text-gray-300">
												{crumb.siblings.map((sibling) => (
													<li key={sibling.href}>
														<Link prefetch="js" href={sibling.href} class={['block w-full px-3 py-1.5', sibling.active ? 'text-fg-brand font-semibold dark:text-blue-400' : 'text-body hover:text-fg-brand hover:underline dark:text-gray-300 dark:hover:text-blue-400'].join(' ')}>
															{sibling.label}
														</Link>
													</li>
												))}
											</ul>
										</div>
									)}
								</div>
							) : idx === 0 ? (
								/* Home link with house icon */
								<Link prefetch="js" href={crumb.href} class="text-body hover:text-fg-brand inline-flex items-center text-sm font-medium dark:text-gray-300 dark:hover:text-blue-400">
									<LuHome class="me-1.5 h-4 w-4" />
									Home
								</Link>
							) : crumb.isLast ? (
								/* Final segment (current page, no link) */
								<span class="text-body-subtle inline-flex items-center text-sm font-medium dark:text-gray-400">{crumb.label}</span>
							) : (
								/* Intermediate link */
								<Link prefetch="js" href={crumb.href} class="text-body hover:text-fg-brand inline-flex items-center text-sm font-medium dark:text-gray-300 dark:hover:text-blue-400">
									{crumb.label}
								</Link>
							)}
						</div>
					</li>
				))}
			</ol>
		</nav>
	);
});
