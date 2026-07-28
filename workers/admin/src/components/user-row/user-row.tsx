import { component$, useSignal } from '@builder.io/qwik';
import { Link, server$, useLocation } from '@builder.io/qwik-city';
import { LuBuilding2, LuCheck, LuTrash2, LuX } from '@qwikest/icons/lucide';
import { StaticDatabase } from 'db/core';
import type { DOJurisdictions } from 'types';
import { calcInitDaysLeft, calcInitProgress } from '~/routes/[environment]/users/db-helpers';
import { useCfAccountId } from '~/routes/layout';

const loadUserEmail = server$(async function (doIdHex: string, jurisdiction: DOJurisdictions | null): Promise<string> {
	const doNamespace = this.platform.env.USER_D0_PROD;
	const doId = jurisdiction ? doNamespace.jurisdiction(jurisdiction).idFromString(doIdHex) : doNamespace.idFromString(doIdHex);
	const doStub = doNamespace.get(doId);
	const { email } = await doStub.getProperties({ email: true }, true).catch(() => ({ email: undefined }));
	return email ?? 'N/A';
});

export const UserRow = component$<{
	uidHex: string;
	uidBase64Url: string;
	doIdHex: string;
	jurisdiction: DOJurisdictions | null;
	userInit: boolean;
	doInstanceExists: boolean;
	selected: boolean;
	onToggleSelect$: () => void;
	onDelete$: () => void;
	onAssignTenant$: () => void;
}>(({ uidHex, uidBase64Url, doIdHex, jurisdiction, userInit, doInstanceExists, ...props }) => {
	const email = useSignal<string | undefined>(undefined);
	const emailLoading = useSignal(false);

	const dbRefExists = doIdHex.length > 0;

	const progress = !userInit ? calcInitProgress(uidHex) : null;
	const daysLeft = !userInit ? calcInitDaysLeft(uidHex) : null;

	const uidDisplay = [uidHex.slice(0, 8), uidHex.slice(8, 12), uidHex.slice(12, 16), uidHex.slice(16, 20), uidHex.slice(20)].join('-');

	const loc = useLocation();
	const cfAccountId = useCfAccountId();

	return (
		<tr class="border-default-medium hover:bg-surface-light border-b dark:border-gray-700 dark:hover:bg-gray-600">
			{/* Checkbox */}
			<td class="px-4 py-3">
				<input type="checkbox" class="border-default-medium h-4 w-4 rounded bg-gray-100 text-blue-600 focus:ring-2 focus:ring-blue-500 dark:border-gray-600 dark:bg-gray-700 dark:ring-offset-gray-800" checked={props.selected} onChange$={props.onToggleSelect$} />
			</td>

			{/* User ID */}
			<td class="px-4 py-3">
				<Link prefetch="js" href={`/${loc.params['environment']}/users/${uidBase64Url}/`} class="text-primary-accent hover:underline">
					<code class="text-xs break-all">{uidDisplay}</code>
					<div class="mt-0.5 text-xs">
						<code class="text-xs break-all">{uidBase64Url}</code>
					</div>
				</Link>
			</td>

			{/* Database ID */}
			<td class="px-4 py-3">
				<div class="flex items-center gap-1.5">
					{doIdHex ? (
						<a target="_blank" rel="noopener noreferrer" href={`https://dash.cloudflare.com/${cfAccountId.value}/workers/durable-objects/view/${StaticDatabase.User.Main['eaas-api-prod_UserD0']}/studio?objectId=${doIdHex}`} class="text-primary-accent inline-flex flex-wrap items-center gap-1.5 rounded-sm text-sm hover:underline focus:ring-2 focus:ring-blue-500 focus:outline-none">
							<code class="text-xs break-all">{doIdHex}</code>
							{jurisdiction ? <span class="inline-flex items-center rounded-full bg-blue-100 px-2 py-0.5 text-xs font-medium text-blue-800 dark:bg-blue-900/30 dark:text-blue-400">{jurisdiction}</span> : null}
						</a>
					) : (
						<code class="text-xs break-all">N/A</code>
					)}
				</div>
			</td>

			{/* Email */}
			<td class="px-4 py-3">
				{email.value ? (
					<span class="text-sm">{email.value}</span>
				) : (
					<button
						type="button"
						class="text-primary-accent text-sm hover:underline disabled:opacity-50"
						disabled={emailLoading.value || !dbRefExists}
						onClick$={async () => {
							emailLoading.value = true;
							email.value = await loadUserEmail(doIdHex, jurisdiction);
							emailLoading.value = false;
						}}>
						{emailLoading.value ? 'Loading…' : 'Load'}
					</button>
				)}
			</td>

			{/* Root */}
			<td class="px-4 py-3 text-center">
				{dbRefExists ? (
					<LuCheck class="mx-auto h-5 w-5 text-green-500" />
				) : (
					<div class="flex items-center justify-center gap-1">
						<LuX class="h-5 w-5 text-red-500" />
						<button type="button" class="text-xs text-blue-500 hover:underline">
							Fix
						</button>
					</div>
				)}
			</td>

			{/* DO */}
			<td class="px-4 py-3 text-center">{doInstanceExists ? <LuCheck class="mx-auto h-5 w-5 text-green-500" /> : <LuX class="mx-auto h-5 w-5 text-red-500" />}</td>

			{/* Signed In */}
			<td class="px-4 py-3 text-center">
				{userInit ? (
					<LuCheck class="mx-auto h-5 w-5 text-green-500" />
				) : (
					<div class="flex flex-col items-center gap-1">
						<progress class="h-2 w-full min-w-15" value={progress ?? 0} max={100} style={{ accentColor: `hsl(${((progress ?? 0) / 100) * 120}, 80%, 45%)` }} />
						<span class="text-body-subtle text-xs dark:text-gray-500">{daysLeft ?? 0}d left</span>
					</div>
				)}
			</td>

			{/* Actions */}
			<td class="px-4 py-3">
				<div class="flex items-center gap-2">
					<button type="button" class="text-purple-500 hover:text-purple-700" title="Assign to tenant" onClick$={props.onAssignTenant$}>
						<LuBuilding2 class="h-4 w-4" />
					</button>
					<button type="button" class="text-red-500 hover:text-red-700" title="Delete user" onClick$={props.onDelete$}>
						<LuTrash2 class="h-4 w-4" />
					</button>
				</div>
			</td>
		</tr>
	);
});
