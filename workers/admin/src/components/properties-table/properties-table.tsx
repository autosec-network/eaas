import { component$, getLocale } from '@builder.io/qwik';
import * as zm from 'zod/mini';
import { useTimezone } from '~/routes/layout';

interface PropertiesTableProps {
	title: string;
	/** Durable Object properties, already flattened to serializable values */
	properties: Record<string, unknown>;
	/** Keys the page surfaces somewhere else and shouldn't repeat here */
	hiddenKeys?: string[];
	emptyLabel?: string;
}

/** Key/value view of a Durable Object's stored properties, with ISO timestamps rendered in the viewer's timezone */
export const PropertiesTable = component$<PropertiesTableProps>(({ title, properties, hiddenKeys = [], emptyLabel = 'No properties available.' }) => {
	const locale = getLocale();
	const timezone = useTimezone();

	const entries = Object.entries(properties).filter(([key]) => !hiddenKeys.includes(key));

	return (
		<div>
			<h2 class="text-heading mb-3 text-lg font-semibold dark:text-white">{title}</h2>
			{entries.length === 0 ? (
				<p class="text-body-subtle text-sm dark:text-gray-500">{emptyLabel}</p>
			) : (
				<div class="border-default-medium bg-surface-light dark:bg-surface-dark overflow-x-auto border">
					<table class="text-body w-full text-left text-sm dark:text-gray-400">
						<thead class="bg-surface-light text-body-subtle text-xs uppercase dark:bg-gray-700 dark:text-gray-400">
							<tr>
								<th scope="col" class="px-4 py-3">
									Property
								</th>
								<th scope="col" class="px-4 py-3">
									Value
								</th>
							</tr>
						</thead>
						<tbody>
							{entries.map(([key, value]) => (
								<tr key={key} class="border-default-medium border-b dark:border-gray-700">
									<td class="px-4 py-3 font-mono text-xs">{key}</td>
									<td class="px-4 py-3 text-sm">
										{value === null ? (
											<span class="text-body-subtle italic">null</span>
										) : (
											(() => {
												if (zm.validate(zm.iso.datetime(), value)) {
													const dateValue = new Date(value);
													return (
														<time dateTime={dateValue.toISOString()} title={[dateValue.toLocaleString(locale, { hour12: false, timeZone: 'UTC' }), 'UTC'].join(' ')}>
															{[dateValue.toLocaleString(locale, { timeZone: timezone.value.long }), timezone.value.short].join(' ')}
														</time>
													);
												} else if (typeof value === 'string') {
													return value;
												} else if (typeof value === 'number' || typeof value === 'boolean' || typeof value === 'bigint') {
													return String(value);
												} else {
													return <pre>{JSON.stringify(value)}</pre>;
												}
											})()
										)}
									</td>
								</tr>
							))}
						</tbody>
					</table>
				</div>
			)}
		</div>
	);
});
