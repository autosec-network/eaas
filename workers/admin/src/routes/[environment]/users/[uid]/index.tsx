import { $, Resource, component$, useSignal, useStore } from '@builder.io/qwik';
import { routeAction$, routeLoader$, z, zod$, type DocumentHead } from '@builder.io/qwik-city';
import { USER_SYSTEM_ALARMS } from 'db';
import * as rootSchema from 'db/schemas/root';
import * as userSchema from 'db/schemas/user/main';
import type { DrizzleD1Database } from 'drizzle-orm/d1';
import { asc, eq, sql } from 'drizzle-orm/sql';
import type { SqliteRemoteDatabase } from 'drizzle-orm/sqlite-proxy';
import type { UUID } from 'node:crypto';
import type { DOJurisdictions } from 'types';
import { UserAlarms } from '~/components/user-alarms/user-alarms';
import { UserProperties } from '~/components/user-properties/user-properties';
import { UserSessions } from '~/components/user-sessions/user-sessions';
import { hexToUuid } from '~/routes/[environment]/users/db-helpers';

const useUid = routeLoader$(async ({ params }) => {
	return import('node:buffer')
		.then(({ Buffer }) => Buffer.from(params['uid']!, 'base64url'))
		.then((buf) => ({
			utf8: hexToUuid(buf.toString('hex')),
			hex: buf.toString('hex'),
			base64: buf.toString('base64'),
			base64url: buf.toString('base64url'),
		}));
});

const useUserDetail = routeLoader$(async ({ sharedMap, resolveValue, platform }) => {
	const r_db = sharedMap.get('r_db') as DrizzleD1Database;
	const u_db = sharedMap.get('u_db') as SqliteRemoteDatabase;
	const u_do = sharedMap.get('u_do') as ReturnType<(typeof platform.env.USER_D0_PROD)['get']>;
	const uidHex = await resolveValue(useUid).then(({ hex }) => hex);

	return async () => {
		const [user] = await r_db
			.select({
				u_id: rootSchema.users.u_id,
				jurisdiction: rootSchema.users.jurisdiction,
				do_id: rootSchema.users.do_id,
				user_init: rootSchema.users.user_init,
			})
			.from(rootSchema.users)
			.where(eq(rootSchema.users.u_id, sql`unhex(${uidHex})`))
			.limit(1)
			.then((rows) =>
				rows.map((row) => ({
					...row,
					u_id: row.u_id.toString('hex'),
					do_id: row.do_id?.toString('hex'),
				})),
			);

		if (!user) return null;

		// Load email and properties from the D0
		const doIdHex = user.do_id;
		let email: string | undefined;
		let gravatarUrl: string | undefined;
		let properties: Record<string, unknown> = {};
		let alarms: { id: string; callee: string; payload: unknown[]; type: 'scheduled' | 'delayed' | 'cron'; next_time: Date; delay_in_seconds: number | null; cron: string[] | null }[] = [];

		if (doIdHex) {
			// Load properties from u_do (set by layout)
			const props = await u_do.getProperties(undefined, true).catch(() => ({}));
			if ('email' in props && typeof props.email === 'string') {
				email = props.email;
			}
			if ('email_verified' in props) console.debug('useUserDetail', 'getProperties', props.email_verified);
			properties = JSON.parse(JSON.stringify(props)) as Record<string, unknown>;

			// Compute gravatar from email
			if (email) {
				const { createHash } = await import('node:crypto');
				const emailHash = createHash('sha256').update(email.trim().toLowerCase()).digest('hex');
				gravatarUrl = `https://gravatar.com/avatar/${emailHash}?d=robohash`;
			}

			// Load alarms via Drizzle on u_db (set by layout)
			alarms = await u_db
				.select()
				.from(userSchema.alarms)
				.orderBy(asc(userSchema.alarms.next_time))
				.then((rows) =>
					rows.map((row) => ({
						...row,
						id: hexToUuid(row.id.toString('hex')),
					})),
				);
		}

		// Load sessions from root DB, then fetch each session's properties from the UserSession DO
		const sessionRows = await r_db
			.select({
				session_token: rootSchema.users_auth_sessions.session_token,
				expires: rootSchema.users_auth_sessions.expires,
			})
			.from(rootSchema.users_auth_sessions)
			.where(eq(rootSchema.users_auth_sessions.u_id, sql`unhex(${uidHex})`))
			.then((rows) =>
				rows.map((row) => ({
					session_token: row.session_token.toString('hex'),
					expires: row.expires,
				})),
			);

		const sessionNamespace = platform.env.USER_SESSION_PROD;
		const sessionNamespaceJurisdiction = user.jurisdiction ? sessionNamespace.jurisdiction(user.jurisdiction) : sessionNamespace;
		const sessions = await Promise.all(
			sessionRows.map(async (row) => {
				const sessionDoId = sessionNamespaceJurisdiction.idFromString(row.session_token);
				const sessionStub = sessionNamespace.get(sessionDoId);
				const props = await (sessionStub.getProperties(undefined, true) as Promise<{ b_time?: Date; lite_binding?: ArrayBuffer; normal_binding?: ArrayBuffer; sensitive_binding?: ArrayBuffer; generated_registration_options?: Record<string, unknown> }>).catch(() => null);
				return {
					...row,
					b_time: props?.b_time instanceof Date ? props.b_time.toISOString() : null,
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

		// Determine which system alarms are missing
		const systemAlarmIds = Object.keys(USER_SYSTEM_ALARMS) as UUID[];
		const existingAlarmIds = new Set(alarms.map((a) => a.id));
		const missingSystemAlarms = systemAlarmIds
			.filter((id) => !existingAlarmIds.has(id))
			.map((id) => ({
				id,
				callee: USER_SYSTEM_ALARMS[id]!.callee,
				when: USER_SYSTEM_ALARMS[id]!.when,
			}));

		return {
			...user,
			email,
			gravatarUrl,
			properties,
			alarms,
			sessions,
			missingSystemAlarms,
		};
	};
});

export const useEndSessions = routeAction$(
	async (data, { platform, sharedMap, fail }) => {
		const sessionNamespace = platform.env.USER_SESSION_PROD;
		const r_db = sharedMap.get('r_db') as DrizzleD1Database;
		const jurisdiction = sharedMap.get('u_jurisdiction') as DOJurisdictions | null;
		const sessionNamespaceJurisdiction = jurisdiction ? sessionNamespace.jurisdiction(jurisdiction) : sessionNamespace;

		let ended = 0;
		for (const tokenHex of data.sessionTokens) {
			// Nuke the session DO (handles KV cleanup + its own root DB delete), but may fail if already evicted
			await sessionNamespace
				.get(sessionNamespaceJurisdiction.idFromString(tokenHex))
				.nuke('Ended by admin')
				.then(() =>
					r_db
						.delete(rootSchema.users_auth_sessions)
						.where(eq(rootSchema.users_auth_sessions.session_token, sql`unhex(${tokenHex})`))
						.then(() => ended++),
				)
				.catch((err: unknown) => fail(500, { message: err instanceof Error ? err.message : String(err) }));
		}

		return { ended };
	},
	zod$({ sessionTokens: z.array(z.string().nonempty()) }),
);

export const useScheduleAlarm = routeAction$(
	async (data, { sharedMap, fail }) => {
		const u_db = sharedMap.get('u_db') as SqliteRemoteDatabase;

		const alarmDef = USER_SYSTEM_ALARMS[data.alarmId as UUID];
		if (!alarmDef) return fail(400, { message: 'Unknown system alarm ID' });

		const alarmIdHex = data.alarmId.replaceAll('-', '');
		const now = new Date();
		let nextTime: Date;
		let type: 'scheduled' | 'delayed' | 'cron';
		let delayInSeconds: number | null = null;
		let cronArr: string[] | null = null;

		if (alarmDef.when instanceof Date) {
			type = 'scheduled';
			nextTime = alarmDef.when;
		} else if (typeof alarmDef.when === 'number') {
			type = 'delayed';
			delayInSeconds = alarmDef.when;
			nextTime = new Date(Date.now() + alarmDef.when * 1000);
		} else {
			type = 'cron';
			cronArr = alarmDef.when;
			// Use a simple next-minute approximation; the D0 will recalculate on next alarm
			nextTime = new Date(now.getTime() + 60 * 1000);
		}

		await u_db
			.insert(userSchema.alarms)
			.values({
				id: sql`unhex(${alarmIdHex})`,
				callee: alarmDef.callee,
				payload: alarmDef.payload ?? [],
				type,
				next_time: nextTime,
				delay_in_seconds: delayInSeconds,
				cron: cronArr,
			})
			.catch((err: unknown) => fail(500, { message: err instanceof Error ? err.message : String(err) }));

		return { scheduled: true };
	},
	zod$({ alarmId: z.string().nonempty() }),
);

export const head: DocumentHead = {
	title: 'User Detail — EaaS Admin',
};

export default component$(() => {
	const uid = useUid();
	const userData = useUserDetail();
	const endSessionsAction = useEndSessions();
	const scheduleAlarmAction = useScheduleAlarm();

	const selectedSessions = useStore<Record<string, boolean>>({});
	const actionError = useSignal('');

	const handleEndSessions = $(async (tokenHexes: string[]) => {
		if (tokenHexes.length === 0) return;
		if (!window.confirm(`Are you sure you want to end ${tokenHexes.length} session(s)?`)) return;
		const result = await endSessionsAction.submit({ sessionTokens: tokenHexes });
		if (result.value.failed) {
			actionError.value = result.value.formErrors[0] ?? 'Failed to end sessions.';
		} else {
			for (const t of tokenHexes) delete selectedSessions[t];
		}
	});

	const handleScheduleAlarm = $(async (alarmId: string) => {
		const result = await scheduleAlarmAction.submit({ alarmId });
		if (result.value.failed) {
			actionError.value = result.value.message ?? 'Failed to schedule alarm.';
		}
	});

	return (
		<section class="mx-auto max-w-7xl px-4 py-6">
			{/* Header */}
			<div class="mb-6">
				<h1 class="text-heading text-2xl font-bold dark:text-white">User Detail</h1>
				<p class="text-body-subtle mt-1 font-mono text-sm dark:text-gray-400">{JSON.stringify(uid.value)}</p>
			</div>

			{/* Error Banner */}
			{actionError.value && (
				<div class="mb-4 flex items-center justify-between rounded-lg border border-red-300 bg-red-50 p-4 text-sm text-red-800 dark:border-red-800 dark:bg-red-900/20 dark:text-red-400">
					<span>{actionError.value}</span>
					<button type="button" class="ml-4 text-red-800 hover:underline dark:text-red-400" onClick$={() => (actionError.value = '')}>
						Dismiss
					</button>
				</div>
			)}

			<Resource
				value={userData}
				onPending={() => (
					<div class="px-4 py-8 text-center">
						<span class="text-body-subtle dark:text-gray-500">Loading user detail…</span>
					</div>
				)}
				onResolved={(data) => {
					if (!data) {
						return (
							<div class="px-4 py-8 text-center">
								<span class="text-body-subtle dark:text-gray-500">User not found.</span>
							</div>
						);
					}

					return (
						<div class="space-y-8">
							{/* Email & Gravatar */}
							<div class="border-default-medium bg-surface-light dark:bg-surface-dark flex items-center gap-6 border p-6">
								{data.gravatarUrl && <img src={data.gravatarUrl} alt="User avatar" width={80} height={80} class="rounded-full" />}
								<div>
									<dt class="text-body-subtle text-sm font-medium dark:text-gray-400">Email</dt>
									<dd class="text-heading text-lg dark:text-white">{data.email ?? 'N/A'}</dd>
								</div>
							</div>

							{/* User Properties */}
							<UserProperties properties={data.properties} />

							{/* Alarms */}
							<UserAlarms alarms={data.alarms} missingSystemAlarms={data.missingSystemAlarms} onScheduleAlarm$={handleScheduleAlarm} />

							{/* Sessions */}
							<UserSessions sessions={data.sessions} selectedSessions={selectedSessions} onEndSessions$={handleEndSessions} />
						</div>
					);
				}}
			/>
		</section>
	);
});
