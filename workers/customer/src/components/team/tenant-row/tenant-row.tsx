import { Resource, component$, getLocale, useResource$ } from '@builder.io/qwik';
import type { DOJurisdictions } from 'types';
import { getTenantPickerProperties, useTimezone } from '~/routes/layout';

interface Props {
	jurisdiction: DOJurisdictions | null;
	do_id: string;
}

export default component$<Props>((props) => {
	const locale = getLocale();
	const timezone = useTimezone();
	const tenantData = useResource$(() => getTenantPickerProperties(props.jurisdiction, props.do_id));

	return (
		<Resource
			value={tenantData}
			onPending={() => (
				<div class="flex items-center gap-4 p-5">
					<div class="h-11 w-11 animate-pulse rounded-full bg-gray-300 dark:bg-gray-600" />
					<div class="min-w-0 flex-1">
						<div class="h-4 w-32 animate-pulse rounded bg-gray-300 dark:bg-gray-600" />
						<div class="mt-2 h-3 w-24 animate-pulse rounded bg-gray-200 dark:bg-gray-700" />
					</div>
				</div>
			)}
			onResolved={(data) => (
				<div class="flex items-center gap-4 p-5">
					{data.avatar ? <img src={data.avatar} alt={data.name} width={44} height={44} class="ring-surface-light dark:ring-surface-dark h-11 w-11 rounded-full object-cover ring-2" /> : <div class="bg-primary-accent/10 text-primary-accent dark:bg-primary-accent/20 flex h-11 w-11 items-center justify-center rounded-full text-sm font-bold">{data.name?.charAt(0)}</div>}

					<div class="min-w-0 flex-1">
						<div class="flex items-center gap-2">
							<span class="truncate font-semibold text-gray-900 dark:text-white">{data.name}</span>
							<span class="border-surface-light/60 dark:border-surface-dark/60 dark:bg-surface-dark/50 inline-flex shrink-0 items-center rounded-lg border bg-white/50 px-2 py-0.5 text-[11px] font-medium text-gray-500 dark:text-gray-400">{props.jurisdiction?.toUpperCase()}</span>
						</div>
						{data.m_time ? (
							<p class="mt-0.5 text-xs text-gray-400 dark:text-gray-500">
								Updated{' '}
								<time dateTime={data.m_time.toISOString()} title={`${data.m_time.toLocaleString(locale, { hour12: false, timeZone: 'UTC' })} UTC`}>
									{`${data.m_time.toLocaleString(locale, { timeZone: timezone.value.long })} ${timezone.value.short}`}
								</time>
							</p>
						) : null}
					</div>
				</div>
			)}
		/>
	);
});
