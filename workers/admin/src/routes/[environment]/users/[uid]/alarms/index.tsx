import { $, component$, Resource, useSignal } from '@builder.io/qwik';
import { routeAction$, routeLoader$, z, zod$, type DocumentHead } from '@builder.io/qwik-city';
import { USER_SYSTEM_ALARMS } from 'db';
import * as userSchema from 'db/schemas/user/main';
import { asc, sql } from 'drizzle-orm/sql';
import type { SqliteRemoteDatabase } from 'drizzle-orm/sqlite-proxy';
import type { UUID } from 'node:crypto';
import { UserAlarms } from '~/components/user-alarms/user-alarms';
import { actionErrorMessage } from '~/routes/[environment]/tenants/db-helpers';
import { serializeActionError } from '~/routes/[environment]/tenants/tenant-ops';
import { hexToUuid } from '~/routes/[environment]/users/db-helpers';

/**
 * Alarms live inside the user's Durable Object, so the system alarms that should have been scheduled on its initialization are reported alongside them — a missing one means the object never got set up properly.
 */
export const useUserAlarms = routeLoader$(({ sharedMap }) => {
	const u_db = sharedMap.get('u_db') as SqliteRemoteDatabase;
	const rootDoIdHex = sharedMap.get('u_root_do_id_hex') as string | null;

	return async () => {
		// Querying would bring the durable object into existence, so a user who has never signed in is left alone
		if (!rootDoIdHex) return { hasDurableObject: false, alarms: [], missingSystemAlarms: [] };

		const alarms = await u_db
			.select()
			.from(userSchema.alarms)
			.orderBy(asc(userSchema.alarms.next_time))
			.then((rows) =>
				rows.map((row) => ({
					...row,
					id: hexToUuid(row.id.toString('hex')),
				})),
			);

		const existingAlarmIds = new Set(alarms.map((alarm) => alarm.id));

		return {
			hasDurableObject: true,
			alarms,
			missingSystemAlarms: (Object.keys(USER_SYSTEM_ALARMS) as UUID[])
				.filter((id) => !existingAlarmIds.has(id))
				.map((id) => ({
					id,
					callee: USER_SYSTEM_ALARMS[id]!.callee,
					when: USER_SYSTEM_ALARMS[id]!.when,
				})),
		};
	};
});

export const useScheduleAlarm = routeAction$(
	async (data, { sharedMap, fail }) => {
		const u_db = sharedMap.get('u_db') as SqliteRemoteDatabase;

		const alarmDef = USER_SYSTEM_ALARMS[data.alarmId as UUID];
		if (!alarmDef) return fail(400, serializeActionError(new Error('Unknown system alarm ID')));

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

		return u_db
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
			.then(() => ({ scheduled: true }))
			.catch((err: unknown) => fail(500, serializeActionError(err)));
	},
	zod$({ alarmId: z.string().nonempty() }),
);

export const head: DocumentHead = {
	title: 'User Alarms — EaaS Admin',
};

export default component$(() => {
	const userAlarms = useUserAlarms();
	const scheduleAlarmAction = useScheduleAlarm();

	const actionError = useSignal('');

	const handleScheduleAlarm = $(async (alarmId: string) => {
		const result = await scheduleAlarmAction.submit({ alarmId });
		if (result.value.failed) actionError.value = actionErrorMessage(result.value, 'Failed to schedule alarm.');
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
				value={userAlarms}
				onPending={() => (
					<div class="px-4 py-8 text-center">
						<span class="text-body-subtle dark:text-gray-500">Loading user alarms…</span>
					</div>
				)}
				onRejected={(error) => (
					<div class="rounded-lg border border-red-300 bg-red-50 p-4 text-sm text-red-800 dark:border-red-800 dark:bg-red-900/20 dark:text-red-400">
						Failed to load user alarms: {error.name}: {error.message}
					</div>
				)}
				onResolved={(data) =>
					data.hasDurableObject ? (
						<UserAlarms alarms={data.alarms} missingSystemAlarms={data.missingSystemAlarms} onScheduleAlarm$={handleScheduleAlarm} />
					) : (
						<div>
							<h2 class="text-heading mb-3 text-lg font-semibold dark:text-white">Alarms</h2>
							<p class="text-body-subtle text-sm dark:text-gray-500">No durable object yet — alarms are scheduled when it is created on the first sign in.</p>
						</div>
					)
				}
			/>
		</div>
	);
});
