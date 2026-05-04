import { component$, type Signal } from '@builder.io/qwik';
import { LuArrowDownUp, LuBuilding2, LuLoader2, LuSearch, LuTrash2 } from '@qwikest/icons/lucide';

interface UsersToolbarProps {
	searchQuery: Signal<string>;
	selectedCount: number;
	loadingEmails: boolean;
	onLoadEmails$: () => void;
	onDeleteSelected$: () => void;
	onAssignTenant$: () => void;
}

export const UsersToolbar = component$<UsersToolbarProps>((props) => {
	return (
		<div class="border-default-medium bg-surface-light dark:bg-surface-dark mb-4 flex flex-col gap-3 border p-4 sm:flex-row sm:items-center sm:justify-between">
			{/* Search */}
			<div class="relative flex-1">
				<div class="pointer-events-none absolute inset-y-0 inset-s-0 flex items-center ps-3">
					<LuSearch class="text-body-subtle h-4 w-4 dark:text-gray-400" />
				</div>
				<input type="search" placeholder="Search by User ID, DB ID, or email…" class="border-default-medium bg-deep-light text-body block w-full rounded-lg border p-2.5 ps-10 text-sm focus:border-blue-500 focus:ring-blue-500 dark:border-gray-600 dark:bg-gray-700 dark:text-white dark:placeholder-gray-400" bind:value={props.searchQuery} />
			</div>

			{/* Bulk actions */}
			<div class="flex items-center gap-2">
				<span class="text-body-subtle text-sm dark:text-gray-400">{props.selectedCount} selected</span>
				<button type="button" class="inline-flex items-center gap-1.5 rounded-lg bg-blue-600 px-3 py-2 text-sm font-medium text-white hover:bg-blue-700 disabled:opacity-50" disabled={props.selectedCount === 0 || props.loadingEmails} onClick$={props.onLoadEmails$}>
					{props.loadingEmails ? <LuLoader2 class="h-4 w-4 animate-spin" /> : <LuArrowDownUp class="h-4 w-4" />}
					Load Emails
				</button>
				<button type="button" class="inline-flex items-center gap-1.5 rounded-lg bg-purple-600 px-3 py-2 text-sm font-medium text-white hover:bg-purple-700 disabled:opacity-50" disabled={props.selectedCount === 0} onClick$={props.onAssignTenant$}>
					<LuBuilding2 class="h-4 w-4" />
					Assign to Tenant
				</button>
				<button type="button" class="inline-flex items-center gap-1.5 rounded-lg bg-red-600 px-3 py-2 text-sm font-medium text-white hover:bg-red-700 disabled:opacity-50" disabled={props.selectedCount === 0} onClick$={props.onDeleteSelected$}>
					<LuTrash2 class="h-4 w-4" />
					Delete
				</button>
			</div>
		</div>
	);
});
