import { component$, useSignal, useTask$, type QRL } from '@builder.io/qwik';
import type { Permissions } from 'types';
import { PERMISSION_OPTIONS } from '~/routes/[environment]/tenants/db-helpers';

interface PermissionSelectProps {
	name: string;
	value: Permissions;
	onUpdate$: QRL<(value: Permissions) => Promise<void>>;
}

/** Permission dropdown that applies optimistically and rolls back if the write fails */
export const PermissionSelect = component$<PermissionSelectProps>(({ name, value, onUpdate$ }) => {
	const current = useSignal<Permissions>(value);
	const saving = useSignal(false);

	useTask$(({ track }) => {
		current.value = track(() => value);
	});

	return (
		<select
			name={name}
			value={String(current.value)}
			disabled={saving.value}
			class={['border-default-medium bg-deep-light text-body min-w-24 cursor-pointer rounded-lg border p-1.5 text-xs focus:border-blue-500 focus:ring-blue-500 dark:border-gray-600 dark:bg-gray-700 dark:text-white', saving.value && 'animate-pulse opacity-50'].filter(Boolean).join(' ')}
			onChange$={async (_, element) => {
				const next: Permissions = parseInt(element.value, 10);
				const previous = current.value;

				if (next === previous) return;

				current.value = next;
				saving.value = true;

				await onUpdate$(next)
					.catch(() => {
						current.value = previous;
					})
					.finally(() => {
						saving.value = false;
					});
			}}>
			{PERMISSION_OPTIONS.map(([optionLabel, optionValue]) => (
				<option key={optionValue} value={String(optionValue)} selected={current.value === optionValue}>
					{optionLabel}
				</option>
			))}
		</select>
	);
});
