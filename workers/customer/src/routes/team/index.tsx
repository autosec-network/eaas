import { component$ } from '@builder.io/qwik';
import { Link, routeLoader$ } from '@builder.io/qwik-city';
import { LuPlus } from '@qwikest/icons/lucide';

export const useTenants = routeLoader$(() => {
	return [
		{
			t_id: 'totallynotabase64url',
			jurisdiction: 'The European Union',
			name: 'Acme Corp',
			avatar: 'https://example.com/acme.png',
			m_time: new Date('2025-12-01T00:00:00Z').toISOString(),
		},
		{
			t_id: 'totallynotabase64url',
			jurisdiction: 'FedRAMP-compliant data centers',
			name: 'Globex Industries',
			avatar: null,
			m_time: new Date('2026-01-15T00:00:00Z').toISOString(),
		},
		{
			t_id: 'totallynotabase64url',
			jurisdiction: 'FedRAMP High authorization',
			name: 'Initech LLC',
			avatar: 'https://example.com/initech.png',
			m_time: new Date('2026-03-10T00:00:00Z').toISOString(),
		},
	];
});

export default component$(() => {
	const tenants = useTenants();

	return (
		<div class="mx-auto max-w-3xl px-6 py-10">
			<div class="mb-8 flex items-center justify-between">
				<div>
					<h1 class="text-2xl font-bold tracking-tight text-gray-900 dark:text-white">Your Teams</h1>
					<p class="mt-1 text-sm text-gray-500 dark:text-gray-400">Select a team to manage keys and encryption.</p>
				</div>
				<Link prefetch="js" href="/team/onboarding/" class="bg-primary-accent hover:bg-primary-accent/85 hover:shadow-primary-accent/25 inline-flex items-center gap-2 rounded-xl px-5 py-2.5 text-sm font-medium text-white transition-all duration-150 hover:shadow-md active:scale-[0.98]">
					<LuPlus class="h-4 w-4" />
					New Team
				</Link>
			</div>

			<ul class="space-y-3">
				{tenants.value.map((tenant) => (
					<li key={tenant.t_id}>
						<Link prefetch="js" href={`/team/${tenant.t_id}/`} class="border-surface-light/60 shadow-primary-accent/5 dark:border-surface-dark/60 dark:bg-surface-dark/70 group hover:shadow-primary-accent/10 flex items-center gap-4 rounded-2xl border bg-white/70 p-5 shadow-sm backdrop-blur-md transition-all duration-150 hover:shadow-md">
							{tenant.avatar ? <img src={tenant.avatar} alt={tenant.name} width={44} height={44} class="ring-surface-light dark:ring-surface-dark h-11 w-11 rounded-full object-cover ring-2" /> : <div class="bg-primary-accent/10 text-primary-accent dark:bg-primary-accent/20 flex h-11 w-11 items-center justify-center rounded-full text-sm font-bold">{tenant.name.charAt(0)}</div>}

							<div class="min-w-0 flex-1">
								<div class="flex items-center gap-2">
									<span class="truncate font-semibold text-gray-900 dark:text-white">{tenant.name}</span>
									<span class="border-surface-light/60 dark:border-surface-dark/60 dark:bg-surface-dark/50 inline-flex shrink-0 items-center rounded-lg border bg-white/50 px-2 py-0.5 text-[11px] font-medium text-gray-500 dark:text-gray-400">{tenant.jurisdiction}</span>
								</div>
								<p class="mt-0.5 text-xs text-gray-400 dark:text-gray-500">Updated {new Date(tenant.m_time).toLocaleDateString()}</p>
							</div>
						</Link>
					</li>
				))}
			</ul>
		</div>
	);
});
