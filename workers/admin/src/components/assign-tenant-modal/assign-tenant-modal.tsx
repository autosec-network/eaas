import { component$, type PropFunction, useSignal } from '@builder.io/qwik';
import { LuBuilding2, LuX } from '@qwikest/icons/lucide';

interface AssignTenantModalProps {
	onAssign$: PropFunction<(tenantId: string) => void>;
	onClose$: PropFunction<() => void>;
}

export const AssignTenantModal = component$<AssignTenantModalProps>(({ onAssign$, onClose$ }) => {
	const tenantInput = useSignal('');

	return (
		<div class="bg-opacity-50 fixed inset-0 z-50 flex items-center justify-center bg-black/50">
			<div class="bg-surface-light dark:bg-surface-dark border-default-medium w-full max-w-md rounded-lg border p-6 shadow-xl">
				{/* Header */}
				<div class="mb-4 flex items-center justify-between">
					<h2 class="text-heading flex items-center gap-2 text-lg font-semibold dark:text-white">
						<LuBuilding2 class="h-5 w-5" />
						Assign to Tenant
					</h2>
					<button type="button" class="text-body-subtle hover:text-body dark:text-gray-400 dark:hover:text-white" onClick$={onClose$}>
						<LuX class="h-5 w-5" />
					</button>
				</div>

				{/* Tenant ID Input */}
				<label class="text-body mb-2 block text-sm font-medium dark:text-gray-300">Tenant ID</label>
				<input type="text" placeholder="UUIDv7, hex (32), base64 (24), or base64url (22)" class="border-default-medium bg-deep-light text-body mb-1 block w-full rounded-lg border p-2.5 font-mono text-sm focus:border-blue-500 focus:ring-blue-500 dark:border-gray-600 dark:bg-gray-700 dark:text-white dark:placeholder-gray-400" bind:value={tenantInput} />
				<p class="text-body-subtle mb-4 text-xs dark:text-gray-500">Accepts UUIDv7 (with hyphens), 32-char hex, base64, or base64url.</p>

				{/* Actions */}
				<div class="flex justify-end gap-2">
					<button type="button" class="text-body-subtle rounded-lg px-4 py-2 text-sm hover:underline dark:text-gray-400" onClick$={onClose$}>
						Cancel
					</button>
					<button type="button" class="inline-flex items-center gap-1.5 rounded-lg bg-purple-600 px-4 py-2 text-sm font-medium text-white hover:bg-purple-700 disabled:opacity-50" disabled={!tenantInput.value.trim()} onClick$={() => onAssign$(tenantInput.value.trim())}>
						Assign
					</button>
				</div>
			</div>
		</div>
	);
});
