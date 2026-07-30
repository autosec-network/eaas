import { $, component$, Resource, useSignal, useStore } from '@builder.io/qwik';
import { routeAction$, routeLoader$, z, zod$, type DocumentHead } from '@builder.io/qwik-city';
import * as rootSchema from 'db/schemas/root';
import type { DrizzleD1Database } from 'drizzle-orm/d1';
import { eq, sql } from 'drizzle-orm/sql';
import type { DOJurisdictions } from 'types';
import { UserSessions } from '~/components/user-sessions/user-sessions';
import { actionErrorMessage } from '~/routes/[environment]/tenants/db-helpers';
import { serializeActionError } from '~/routes/[environment]/tenants/tenant-ops';

/**
 * Sessions are listed in root, but everything worth seeing about one (when it was minted, which bindings it holds) lives in the session's own Durable Object — so each row is filled in from both.
 */
export const useUserSessions = routeLoader$(({ sharedMap, platform }) => {
	const r_db = sharedMap.get('r_db') as DrizzleD1Database;
	const u_id_hex = sharedMap.get('u_id_hex') as string;
	const jurisdiction = sharedMap.get('u_jurisdiction') as DOJurisdictions | null;

	return async () => {
		const sessionRows = await r_db
			.select({
				session_token: rootSchema.users_auth_sessions.session_token,
				expires: rootSchema.users_auth_sessions.expires,
			})
			.from(rootSchema.users_auth_sessions)
			.where(eq(rootSchema.users_auth_sessions.u_id, sql`unhex(${u_id_hex})`))
			.then((rows) =>
				rows.map((row) => ({
					session_token: row.session_token.toString('hex'),
					expires: row.expires,
				})),
			);

		const sessionNamespace = platform.env.USER_SESSION_PROD;
		const sessionNamespaceJurisdiction = jurisdiction ? sessionNamespace.jurisdiction(jurisdiction) : sessionNamespace;

		return Promise.all(
			sessionRows.map(async (row) => {
				const sessionStub = sessionNamespace.get(sessionNamespaceJurisdiction.idFromString(row.session_token));
				// Spelled out rather than inferred: resolving the session property schema through the RPC stub is deep enough to trip `TS2589`
				const props = await (sessionStub.getProperties(undefined, true) as Promise<{ b_time?: Date; lite_binding?: ArrayBuffer; normal_binding?: ArrayBuffer; sensitive_binding?: ArrayBuffer; generated_registration_options?: Record<string, unknown> }>).catch(() => null);

				return {
					...row,
					b_time: props?.b_time instanceof Date ? props.b_time.toISOString() : null,
					// The bindings are raw key material, so only their presence (as a byte count) crosses to the client
					lite_binding: props?.lite_binding instanceof ArrayBuffer ? props.lite_binding.byteLength : null,
					normal_binding: props?.normal_binding instanceof ArrayBuffer ? props.normal_binding.byteLength : null,
					sensitive_binding: props?.sensitive_binding instanceof ArrayBuffer ? props.sensitive_binding.byteLength : null,
					generated_registration_options: props?.generated_registration_options ?? null,
				};
			}),
		).then((rows) =>
			rows.sort((left, right) => {
				const leftCreatedAt = left.b_time ? Date.parse(left.b_time) : 0;
				const rightCreatedAt = right.b_time ? Date.parse(right.b_time) : 0;

				if (leftCreatedAt !== rightCreatedAt) {
					return rightCreatedAt - leftCreatedAt;
				}

				return right.expires.getTime() - left.expires.getTime();
			}),
		);
	};
});

/** Nuking the session's Durable Object is what actually ends it — it clears its own KV entry and root row, so the root delete here only cleans up after an object that was already gone */
export const useEndSessions = routeAction$(
	async (data, { platform, sharedMap, fail }) => {
		const sessionNamespace = platform.env.USER_SESSION_PROD;
		const r_db = sharedMap.get('r_db') as DrizzleD1Database;
		const jurisdiction = sharedMap.get('u_jurisdiction') as DOJurisdictions | null;
		const sessionNamespaceJurisdiction = jurisdiction ? sessionNamespace.jurisdiction(jurisdiction) : sessionNamespace;

		let ended = 0;
		for (const tokenHex of data.sessionTokens) {
			const result = await sessionNamespace
				.get(sessionNamespaceJurisdiction.idFromString(tokenHex))
				.nuke('Ended by admin')
				.then(() =>
					r_db
						.delete(rootSchema.users_auth_sessions)
						.where(eq(rootSchema.users_auth_sessions.session_token, sql`unhex(${tokenHex})`))
						.then(() => ended++),
				)
				.catch((err: unknown) => fail(500, serializeActionError(err)));

			if (typeof result === 'object' && 'failed' in result) return result;
		}

		return { ended };
	},
	zod$({ sessionTokens: z.array(z.string().nonempty()) }),
);

export const head: DocumentHead = {
	title: 'User Sessions — EaaS Admin',
};

export default component$(() => {
	const userSessions = useUserSessions();
	const endSessionsAction = useEndSessions();

	const selectedSessions = useStore<Record<string, boolean>>({});
	const actionError = useSignal('');

	const handleEndSessions = $(async (tokenHexes: string[]) => {
		if (tokenHexes.length === 0) return;
		if (!window.confirm(`Are you sure you want to end ${tokenHexes.length} session(s)?`)) return;

		const result = await endSessionsAction.submit({ sessionTokens: tokenHexes });
		if (result.value.failed) {
			actionError.value = actionErrorMessage(result.value, 'Failed to end sessions.');
			return;
		}

		for (const tokenHex of tokenHexes) delete selectedSessions[tokenHex];
	});

	return (
		<div class="space-y-8">
			{/* Error Banner */}
			{actionError.value && (
				<div class="flex items-center justify-between rounded-lg border border-red-300 bg-red-50 p-4 text-sm text-red-800 dark:border-red-800 dark:bg-red-900/20 dark:text-red-400">
					<span>{actionError.value}</span>
					<button type="button" class="ml-4 text-red-800 hover:underline dark:text-red-400" onClick$={() => (actionError.value = '')}>
						Dismiss
					</button>
				</div>
			)}

			<Resource
				value={userSessions}
				onPending={() => (
					<div class="px-4 py-8 text-center">
						<span class="text-body-subtle dark:text-gray-500">Loading user sessions…</span>
					</div>
				)}
				onRejected={(error) => (
					<div class="rounded-lg border border-red-300 bg-red-50 p-4 text-sm text-red-800 dark:border-red-800 dark:bg-red-900/20 dark:text-red-400">
						Failed to load user sessions: {error.name}: {error.message}
					</div>
				)}
				onResolved={(sessions) => <UserSessions sessions={sessions} selectedSessions={selectedSessions} onEndSessions$={handleEndSessions} />}
			/>
		</div>
	);
});
