import { component$, getLocale } from '@builder.io/qwik';
import * as zm from 'zod/mini';
import { useTimezone } from '~/routes/layout';

interface UserPropertiesProps {
	properties: Record<string, unknown>;
}

export const UserProperties = component$<UserPropertiesProps>(({ properties }) => {
	const locale = getLocale();
	const timezone = useTimezone();

	const entries = Object.entries(properties).filter(([key]) => key !== 'email');

	return (
		<div>
			<h2 class="text-heading mb-3 text-lg font-semibold dark:text-white">User Properties</h2>
			{entries.length === 0 ? (
				<p class="text-body-subtle text-sm dark:text-gray-500">No properties available.</p>
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
												if (zm.iso.datetime().safeParse(value).success) {
													const dateValue = new Date(value as string | Date);
													return (
														<time dateTime={dateValue.toISOString()} title={[dateValue.toLocaleString(locale, { hour12: false, timeZone: 'UTC' }), 'UTC'].join(' ')}>
															{[dateValue.toLocaleString(locale, { timeZone: timezone.value.long }), timezone.value.short].join(' ')}
														</time>
													);
												} else if (Array.isArray(value) || typeof value === 'object') {
													return <pre>{JSON.stringify(value)}</pre>;
												} else {
													return String(value);
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
