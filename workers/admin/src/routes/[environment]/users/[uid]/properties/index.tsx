import { component$, Resource } from '@builder.io/qwik';
import { routeLoader$, type DocumentHead } from '@builder.io/qwik-city';
import { StaticDatabase } from 'db/core';
import * as rootSchema from 'db/schemas/root';
import type { DrizzleD1Database } from 'drizzle-orm/d1';
import { eq, sql } from 'drizzle-orm/sql';
import type { DOJurisdictions } from 'types';
import { PropertiesTable } from '~/components/properties-table/properties-table';
import { useUserIds } from '~/routes/[environment]/users/[uid]/layout';
import type { UserDoStub } from '~/routes/[environment]/users/user-ops';
import { useCfAccountId } from '~/routes/layout';

/**
 * Reads the user from both places they live — the root lookup row and their Durable Object — rather than trusting either on its own.
 */
export const useUserProperties = routeLoader$(({ sharedMap }) => {
	const r_db = sharedMap.get('r_db') as DrizzleD1Database;
	const u_do = sharedMap.get('u_do') as UserDoStub;
	const u_id_hex = sharedMap.get('u_id_hex') as string;
	const u_do_id_hex = sharedMap.get('u_do_id_hex') as string;
	const rootDoIdHex = sharedMap.get('u_root_do_id_hex') as string | null;
	const jurisdiction = sharedMap.get('u_jurisdiction') as DOJurisdictions | null;

	return async () => {
		const [rootRow, properties] = await Promise.all([
			r_db
				.select({
					u_id: rootSchema.users.u_id,
					jurisdiction: rootSchema.users.jurisdiction,
					do_id: rootSchema.users.do_id,
					user_init: rootSchema.users.user_init,
				})
				.from(rootSchema.users)
				.where(eq(rootSchema.users.u_id, sql`unhex(${u_id_hex})`))
				.limit(1)
				.then((rows) =>
					rows.map((row) => ({
						...row,
						u_id: row.u_id.toString('hex'),
						do_id: row.do_id?.toString('hex') ?? null,
					})),
				)
				.then(([row]) => row ?? null),
			// Reading properties would bring the durable object into existence, so a user who has never signed in is left alone
			rootDoIdHex ? u_do.getProperties(undefined, true).catch(() => ({})) : Promise.resolve({}),
		]);

		return {
			root: rootRow,
			// Binary properties (e.g. the noise static public key) aren't serializable, so they're reported by size instead
			properties: Object.fromEntries(Object.entries(properties).map(([key, value]) => [key, value instanceof ArrayBuffer ? `${value.byteLength} bytes` : value])),
			jurisdiction,
			u_do_id_hex,
			// A root row whose `do_id` isn't the one we're reading means the lookup table and the durable object have drifted apart
			doIdMatchesRoot: rootRow?.do_id ? rootRow.do_id === u_do_id_hex : null,
			hasDurableObject: rootDoIdHex !== null,
		};
	};
});

export const head: DocumentHead = {
	title: 'User Properties — EaaS Admin',
};

export default component$(() => {
	const ids = useUserIds();
	const userProperties = useUserProperties();
	const cfAccountId = useCfAccountId();

	return (
		<div class="space-y-8">
			{/* Identifiers */}
			<div>
				<h2 class="text-heading mb-3 text-lg font-semibold dark:text-white">Identifiers</h2>
				<div class="border-default-medium bg-surface-light dark:bg-surface-dark overflow-x-auto border">
					<table class="text-body w-full text-left text-sm dark:text-gray-400">
						<tbody>
							{(
								[
									['User ID (utf8)', ids.value.utf8],
									['User ID (hex)', ids.value.hex],
									['User ID (base64)', ids.value.base64],
									['User ID (base64url)', ids.value.base64url],
								] as [string, string][]
							).map(([label, value]) => (
								<tr key={label} class="border-default-medium border-b dark:border-gray-700">
									<td class="px-4 py-3 text-xs uppercase">{label}</td>
									<td class="px-4 py-3">
										<code class="text-xs break-all">{value}</code>
									</td>
								</tr>
							))}
							<Resource
								value={userProperties}
								onPending={() => (
									<tr>
										<td colSpan={2} class="px-4 py-3">
											<span class="text-body-subtle text-sm dark:text-gray-500">Loading durable object references…</span>
										</td>
									</tr>
								)}
								onResolved={(data) => (
									<>
										<tr class="border-default-medium border-b dark:border-gray-700">
											<td class="px-4 py-3 text-xs uppercase">Jurisdiction</td>
											<td class="px-4 py-3 text-sm">{data.jurisdiction ?? <span class="text-body-subtle italic">none</span>}</td>
										</tr>
										<tr class="border-default-medium border-b dark:border-gray-700">
											<td class="px-4 py-3 text-xs uppercase">Durable object</td>
											<td class="px-4 py-3">
												<a target="_blank" rel="noopener noreferrer" href={`https://dash.cloudflare.com/${cfAccountId.value}/workers/durable-objects/view/${StaticDatabase.User.Main['eaas-api-prod_UserD0']}/studio?objectId=${data.u_do_id_hex}`} class="text-primary-accent hover:underline">
													<code class="text-xs break-all">{data.u_do_id_hex}</code>
												</a>
												{data.doIdMatchesRoot === false && <p class="mt-1 text-xs text-red-600 dark:text-red-400">Root lookup row points at {data.root?.do_id} instead.</p>}
												{data.root === null && <p class="mt-1 text-xs text-amber-600 dark:text-amber-400">Derived from the user id — there is no root lookup row.</p>}
												{data.root !== null && !data.hasDurableObject && <p class="mt-1 text-xs text-amber-600 dark:text-amber-400">Derived from the user id — root stores no `do_id` until the first sign in.</p>}
											</td>
										</tr>
									</>
								)}
							/>
						</tbody>
					</table>
				</div>
			</div>

			{/* Durable Object properties */}
			<Resource
				value={userProperties}
				onPending={() => (
					<div class="px-4 py-8 text-center">
						<span class="text-body-subtle dark:text-gray-500">Loading user properties…</span>
					</div>
				)}
				onRejected={(error) => (
					<div class="rounded-lg border border-red-300 bg-red-50 p-4 text-sm text-red-800 dark:border-red-800 dark:bg-red-900/20 dark:text-red-400">
						Failed to load user properties: {error.name}: {error.message}
					</div>
				)}
				/* Email is already stated in the header above, so it isn't repeated here */
				onResolved={(data) => <PropertiesTable title="User Properties" properties={data.properties} hiddenKeys={['email']} emptyLabel={data.hasDurableObject ? 'No properties stored — this durable object is empty.' : 'No durable object yet — properties appear after the first sign in.'} />}
			/>
		</div>
	);
});
