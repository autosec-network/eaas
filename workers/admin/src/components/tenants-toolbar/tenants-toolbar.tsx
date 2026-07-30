import { component$, type PropFunction } from '@builder.io/qwik';
import { LuAlertTriangle, LuSearch, LuTrash2 } from '@qwikest/icons/lucide';

interface TenantsToolbarProps {
	/** Current `?q=` value — the input is seeded from the URL so a search stays bookmarkable */
	query: string;
	driftOnly: boolean;
	driftCount: number;
	selectedCount: number;
	onSearch$: PropFunction<(query: string) => void>;
	onToggleDrift$: PropFunction<() => void>;
	onDeleteSelected$: PropFunction<() => void>;
}

export const TenantsToolbar = component$<TenantsToolbarProps>(({ query, driftOnly, driftCount, selectedCount, onSearch$, onToggleDrift$, onDeleteSelected$ }) => {
	return (
		<div class="border-default-medium bg-surface-light dark:bg-surface-dark mb-4 flex flex-col gap-3 border p-4 sm:flex-row sm:items-center sm:justify-between">
			{/* Search */}
			<div class="relative flex-1">
				<div class="pointer-events-none absolute inset-y-0 inset-s-0 flex items-center ps-3">
					<LuSearch class="text-body-subtle h-4 w-4 dark:text-gray-400" />
				</div>
				<input
					type="search"
					placeholder="Search by tenant ID (any form) or database ID…"
					class="border-default-medium bg-deep-light text-body block w-full rounded-lg border p-2.5 ps-10 text-sm focus:border-blue-500 focus:ring-blue-500 dark:border-gray-600 dark:bg-gray-700 dark:text-white dark:placeholder-gray-400"
					value={query}
					onKeyDown$={async (event, element) => {
						if (event.key === 'Enter') await onSearch$(element.value);
					}}
				/>
			</div>

			{/* Filters & bulk actions */}
			<div class="flex items-center gap-2">
				<button type="button" class={['inline-flex items-center gap-1.5 rounded-lg px-3 py-2 text-sm font-medium', driftOnly ? 'bg-amber-600 text-white hover:bg-amber-700' : 'border-default-medium text-body border hover:bg-gray-100 dark:border-gray-600 dark:text-gray-300 dark:hover:bg-gray-700'].join(' ')} aria-pressed={driftOnly} onClick$={onToggleDrift$}>
					<LuAlertTriangle class="h-4 w-4" />
					{driftOnly ? 'Showing drift only' : `Drift (${driftCount})`}
				</button>
				<span class="text-body-subtle text-sm dark:text-gray-400">{selectedCount} selected</span>
				<button type="button" class="inline-flex items-center gap-1.5 rounded-lg bg-red-600 px-3 py-2 text-sm font-medium text-white hover:bg-red-700 disabled:opacity-50" disabled={selectedCount === 0} onClick$={onDeleteSelected$}>
					<LuTrash2 class="h-4 w-4" />
					Delete
				</button>
			</div>
		</div>
	);
});
