import { $, component$, getLocale, useComputed$, type QRL } from '@builder.io/qwik';
import { LuTrash2 } from '@qwikest/icons/lucide';
import type { SessionPropertiesSchema } from 'db';
import { StaticDatabase } from 'db/core';
import type * as rootSchema from 'db/schemas/root';
import type * as zm from 'zod/mini';
import { useCfAccountId, useTimezone } from '~/routes/layout';

type Session = Omit<typeof rootSchema.users_auth_sessions.$inferSelect, 'session_token' | 'u_id'> & {
	/** Hex-encoded DO ID (serialized from Buffer) */
	session_token: string;
	/** b_time from SessionPropertiesSchema, serialized as ISO string */
	b_time: string | null;
	/** Byte length of lite_binding (64 bytes when present) */
	lite_binding: number | null;
	/** Byte length of normal_binding (64 bytes when present) */
	normal_binding: number | null;
	/** Byte length of sensitive_binding (64 bytes when present) */
	sensitive_binding: number | null;
	generated_registration_options: NonNullable<zm.output<typeof SessionPropertiesSchema>['generated_registration_options']> | null;
};

interface UserSessionsProps {
	sessions: Session[];
	selectedSessions: Record<string, boolean>;
	onEndSessions$: QRL<(tokenHexes: string[]) => void>;
}

function clampProgress(value: number): number {
	if (Number.isNaN(value)) return 0;
	if (value < 0) return 0;
	if (value > 100) return 100;
	return value;
}

function getSessionLifetimeProgress(session: Session): number | null {
	if (!session.b_time) return null;

	const createdAt = Date.parse(session.b_time);
	const expiresAt = session.expires.getTime();

	if (Number.isNaN(createdAt) || Number.isNaN(expiresAt) || expiresAt <= createdAt) {
		return null;
	}

	return clampProgress(((expiresAt - Date.now()) / (expiresAt - createdAt)) * 100);
}

export const UserSessions = component$<UserSessionsProps>(({ sessions, selectedSessions, onEndSessions$ }) => {
	const locale = getLocale();
	const timezone = useTimezone();
	const cfAccountId = useCfAccountId();

	const selectedCount = useComputed$(() => Object.values(selectedSessions).filter(Boolean).length);

	const getSelectedTokens = $(() =>
		Object.entries(selectedSessions)
			.filter(([, v]) => v)
			.map(([k]) => k),
	);

	const toggleSelectAll = $(() => {
		const allSelected = sessions.every((s) => selectedSessions[s.session_token]);
		for (const s of sessions) {
			selectedSessions[s.session_token] = !allSelected;
		}
	});

	const handleBulkEnd = $(async () => {
		const tokens = await getSelectedTokens();
		if (tokens.length > 0) await onEndSessions$(tokens);
	});

	return (
		<div>
			<div class="mb-3 flex items-center justify-between">
				<h2 class="text-heading text-lg font-semibold dark:text-white">Sessions</h2>
				{selectedCount.value > 0 && (
					<button type="button" class="inline-flex items-center gap-1.5 rounded-lg bg-red-600 px-3 py-1.5 text-sm font-medium text-white hover:bg-red-700" onClick$={handleBulkEnd}>
						<LuTrash2 class="h-3.5 w-3.5" />
						End {selectedCount.value} session(s)
					</button>
				)}
			</div>

			{sessions.length === 0 ? (
				<p class="text-body-subtle text-sm dark:text-gray-500">No active sessions.</p>
			) : (
				<div class="border-default-medium bg-surface-light dark:bg-surface-dark overflow-x-auto border">
					<table class="text-body w-full text-left text-sm dark:text-gray-400">
						<thead class="bg-surface-light text-body-subtle text-xs uppercase dark:bg-gray-700 dark:text-gray-400">
							<tr>
								<th scope="col" class="px-4 py-3">
									<input type="checkbox" class="border-default-medium h-4 w-4 rounded bg-gray-100 text-blue-600 focus:ring-2 focus:ring-blue-500 dark:border-gray-600 dark:bg-gray-700 dark:ring-offset-gray-800" checked={sessions.length > 0 && sessions.every((s) => selectedSessions[s.session_token])} onChange$={toggleSelectAll} />
								</th>
								<th scope="col" class="px-4 py-3">
									Session Token
								</th>
								<th scope="col" class="px-4 py-3">
									Expires
								</th>
								<th scope="col" class="px-4 py-3">
									Status
								</th>
								<th scope="col" class="px-4 py-3">
									Actions
								</th>
							</tr>
						</thead>
						<tbody>
							{sessions.map((session) => {
								const expiresDate = new Date(session.expires);
								const createDate = session.b_time ? new Date(session.b_time) : undefined;
								const isExpired = expiresDate < new Date();
								const lifetimeProgress = getSessionLifetimeProgress(session);
								return (
									<tr key={session.session_token} class="border-default-medium hover:bg-surface-light border-b dark:border-gray-700 dark:hover:bg-gray-600">
										<td class="px-4 py-3">
											<input
												type="checkbox"
												class="border-default-medium h-4 w-4 rounded bg-gray-100 text-blue-600 focus:ring-2 focus:ring-blue-500 dark:border-gray-600 dark:bg-gray-700 dark:ring-offset-gray-800"
												checked={!!selectedSessions[session.session_token]}
												onChange$={() => {
													selectedSessions[session.session_token] = !selectedSessions[session.session_token];
												}}
											/>
										</td>
										<td class="px-4 py-3">
											<a target="_blank" rel="noopener noreferrer" href={`https://dash.cloudflare.com/${cfAccountId.value}/workers/durable-objects/view/${StaticDatabase.User.Sessions['eaas-customer-prod_UserSession']}/studio?objectId=${session.session_token}`} class="text-primary-accent inline-flex flex-wrap items-center gap-1.5 rounded-sm text-sm hover:underline focus:ring-2 focus:ring-blue-500 focus:outline-none">
												<code class="text-xs break-all">{session.session_token}</code>
											</a>
										</td>
										<td class="px-4 py-3 text-xs">
											<div class="flex min-w-52 flex-col gap-1">
												<span>
													{createDate ? (
														<time dateTime={createDate.toISOString()} title={[createDate.toLocaleString(locale, { hour12: false, timeZone: 'UTC' }), 'UTC'].join(' ')}>
															{[createDate.toLocaleString(locale, { timeZone: timezone.value.long }), timezone.value.short].join(' ')} -{' '}
														</time>
													) : null}
													<time dateTime={expiresDate.toISOString()} title={[expiresDate.toLocaleString(locale, { hour12: false, timeZone: 'UTC' }), 'UTC'].join(' ')}>
														{[expiresDate.toLocaleString(locale, { timeZone: timezone.value.long }), timezone.value.short].join(' ')}
													</time>
												</span>
												{lifetimeProgress === null ? (
													<span class="text-body-subtle dark:text-gray-500">Unknown session lifetime</span>
												) : (
													<>
														<div class="h-2 overflow-hidden rounded-full bg-gray-200 dark:bg-gray-700">
															<div class={['h-full rounded-full transition-[width]', lifetimeProgress > 50 ? 'bg-green-500 dark:bg-green-400' : lifetimeProgress > 20 ? 'bg-amber-500 dark:bg-amber-400' : 'bg-red-500 dark:bg-red-400'].join(' ')} style={{ width: `${lifetimeProgress}%` }} />
														</div>
													</>
												)}
											</div>
										</td>
										<td class="px-4 py-3">
											<span class={['inline-flex items-center rounded-full px-2 py-0.5 text-xs font-medium', isExpired ? 'bg-red-100 text-red-800 dark:bg-red-900/30 dark:text-red-400' : 'bg-green-100 text-green-800 dark:bg-green-900/30 dark:text-green-400'].join(' ')}>{isExpired ? 'Expired' : 'Active'}</span>
										</td>
										<td class="px-4 py-3">
											<button type="button" class="text-red-500 hover:text-red-700" title="End session" onClick$={() => onEndSessions$([session.session_token])}>
												<LuTrash2 class="h-4 w-4" />
											</button>
										</td>
									</tr>
								);
							})}
						</tbody>
					</table>
				</div>
			)}
		</div>
	);
});
