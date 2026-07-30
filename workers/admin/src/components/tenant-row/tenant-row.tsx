import { component$, useSignal } from '@builder.io/qwik';
import { Link, server$, useLocation } from '@builder.io/qwik-city';
import { LuCheck, LuHelpCircle, LuTrash2, LuX } from '@qwikest/icons/lucide';
import { StaticDatabase } from 'db/core';
import type { DOJurisdictions } from 'types';
import { useCfAccountId } from '~/routes/layout';

const loadTenantName = server$(async function (doIdHex: string, jurisdiction: DOJurisdictions | null): Promise<string> {
	const doNamespace = this.platform.env.TENANT_D0_PROD;
	const doId = jurisdiction ? doNamespace.jurisdiction(jurisdiction).idFromString(doIdHex) : doNamespace.idFromString(doIdHex);
	const doStub = doNamespace.get(doId);
	const { name } = await doStub.getProperties({ name: true }, true).catch(() => ({ name: undefined }));
	return name ?? 'N/A';
});

export const TenantRow = component$<{
	tidUuid: string;
	tidBase64Url: string;
	doIdHex: string;
	logsDoIdHex: string | null;
	jurisdiction: DOJurisdictions | null;
	doExists: boolean;
	logsDoExists: boolean;
	selected: boolean;
	onToggleSelect$: () => void;
	onDelete$: () => void;
}>(({ tidUuid, tidBase64Url, doIdHex, logsDoIdHex, jurisdiction, doExists, logsDoExists, ...props }) => {
	const name = useSignal<string | undefined>(undefined);
	const nameLoading = useSignal(false);

	const loc = useLocation();
	const cfAccountId = useCfAccountId();

	return (
		<tr class="border-default-medium hover:bg-surface-light border-b dark:border-gray-700 dark:hover:bg-gray-600">
			{/* Checkbox */}
			<td class="px-4 py-3">
				<input type="checkbox" class="border-default-medium h-4 w-4 rounded bg-gray-100 text-blue-600 focus:ring-2 focus:ring-blue-500 dark:border-gray-600 dark:bg-gray-700 dark:ring-offset-gray-800" checked={props.selected} onChange$={props.onToggleSelect$} />
			</td>

			{/* Tenant ID */}
			<td class="px-4 py-3">
				<Link prefetch="js" href={`/${loc.params['environment']}/tenants/${tidBase64Url}/properties/`} class="text-primary-accent hover:underline">
					<code class="text-xs break-all">{tidUuid}</code>
					<div class="mt-0.5 text-xs">
						<code class="text-xs break-all">{tidBase64Url}</code>
					</div>
				</Link>
			</td>

			{/* Database ID */}
			<td class="px-4 py-3">
				<div class="flex flex-col gap-1">
					<a target="_blank" rel="noopener noreferrer" href={`https://dash.cloudflare.com/${cfAccountId.value}/workers/durable-objects/view/${StaticDatabase.Tenant.Main['eaas-api-prod_TenantD0']}/studio?objectId=${doIdHex}`} class="text-primary-accent inline-flex flex-wrap items-center gap-1.5 rounded-sm text-sm hover:underline focus:ring-2 focus:ring-blue-500 focus:outline-none">
						<code class="text-xs break-all">{doIdHex}</code>
						{jurisdiction ? <span class="inline-flex items-center rounded-full bg-blue-100 px-2 py-0.5 text-xs font-medium text-blue-800 dark:bg-blue-900/30 dark:text-blue-400">{jurisdiction}</span> : null}
					</a>
					{logsDoIdHex ? (
						<a target="_blank" rel="noopener noreferrer" href={`https://dash.cloudflare.com/${cfAccountId.value}/workers/durable-objects/view/${StaticDatabase.Tenant.Logs['eaas-api-prod_TenantD0Logs']}/studio?objectId=${logsDoIdHex}`} class="text-body-subtle inline-flex flex-wrap items-center gap-1.5 rounded-sm text-xs hover:underline focus:ring-2 focus:ring-blue-500 focus:outline-none dark:text-gray-400">
							<code class="text-xs break-all">logs: {logsDoIdHex}</code>
						</a>
					) : (
						<span class="text-body-subtle text-xs dark:text-gray-500">logs: unresolvable</span>
					)}
				</div>
			</td>

			{/* Name */}
			<td class="px-4 py-3">
				{name.value ? (
					<span class="text-sm">{name.value}</span>
				) : (
					<button
						type="button"
						class="text-primary-accent text-sm hover:underline disabled:opacity-50"
						disabled={nameLoading.value || !doExists}
						onClick$={async () => {
							nameLoading.value = true;
							name.value = await loadTenantName(doIdHex, jurisdiction);
							nameLoading.value = false;
						}}>
						{nameLoading.value ? 'Loading…' : 'Load'}
					</button>
				)}
			</td>

			{/* DO */}
			<td class="px-4 py-3 text-center">
				{doExists ? (
					<LuCheck class="mx-auto h-5 w-5 text-green-500" />
				) : (
					<span title="Root lookup row points at a durable object that holds no data">
						<LuX class="mx-auto h-5 w-5 text-red-500" />
					</span>
				)}
			</td>

			{/* Logs DO */}
			<td class="px-4 py-3 text-center">
				{logsDoIdHex === null ? (
					<span title="Logs durable object id could not be derived in this runtime">
						<LuHelpCircle class="text-body-subtle mx-auto h-5 w-5 dark:text-gray-500" />
					</span>
				) : logsDoExists ? (
					<LuCheck class="mx-auto h-5 w-5 text-green-500" />
				) : (
					<span title="No logs durable object holds data for this tenant">
						<LuX class="mx-auto h-5 w-5 text-amber-500" />
					</span>
				)}
			</td>

			{/* Actions */}
			<td class="px-4 py-3">
				<div class="flex items-center gap-2">
					<button type="button" class="text-red-500 hover:text-red-700" title="Delete tenant" onClick$={props.onDelete$}>
						<LuTrash2 class="h-4 w-4" />
					</button>
				</div>
			</td>
		</tr>
	);
});
