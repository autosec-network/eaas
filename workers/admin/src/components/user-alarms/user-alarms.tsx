import { component$, getLocale, type QRL } from '@builder.io/qwik';
import { LuAlertTriangle, LuCalendarPlus } from '@qwikest/icons/lucide';
import { USER_SYSTEM_ALARMS } from 'db';
import type * as userSchema from 'db/schemas/user/main';
import type { UUID } from 'node:crypto';
import { useTimezone } from '~/routes/layout';

type Alarm = Omit<typeof userSchema.alarms.$inferSelect, 'id'> & {
	/** UUID-formatted string (hex id serialized from Buffer) */
	id: string;
};

type MissingSystemAlarm = { id: string } & (typeof USER_SYSTEM_ALARMS)[UUID];

interface UserAlarmsProps {
	alarms: Alarm[];
	missingSystemAlarms: MissingSystemAlarm[];
	onScheduleAlarm$: QRL<(alarmId: string) => void>;
}

export const UserAlarms = component$<UserAlarmsProps>(({ alarms, missingSystemAlarms, onScheduleAlarm$ }) => {
	const locale = getLocale();
	const timezone = useTimezone();
	const systemAlarmIds = new Set(Object.keys(USER_SYSTEM_ALARMS));

	return (
		<div>
			<h2 class="text-heading mb-3 text-lg font-semibold dark:text-white">Alarms</h2>

			{/* Missing system alarms warning */}
			{missingSystemAlarms.length > 0 && (
				<div class="mb-3 flex items-start gap-2 rounded-lg border border-yellow-300 bg-yellow-50 p-4 text-sm text-yellow-800 dark:border-yellow-700 dark:bg-yellow-900/20 dark:text-yellow-400" title={`${missingSystemAlarms.length} system alarm(s) not scheduled. These should be automatically created on D0 initialization.`}>
					<LuAlertTriangle class="mt-0.5 h-4 w-4 shrink-0" />
					<div class="flex-1">
						<p class="font-medium">{missingSystemAlarms.length} system alarm(s) not scheduled</p>
						<ul class="mt-2 space-y-1">
							{missingSystemAlarms.map((alarm) => (
								<li key={alarm.id} class="flex items-center justify-between gap-2">
									<span>
										<code class="text-xs">{alarm.id}</code> — <code class="text-xs">{alarm.callee}</code>
									</span>
									<button type="button" class="inline-flex items-center gap-1 rounded bg-yellow-600 px-2 py-1 text-xs font-medium text-white hover:bg-yellow-700" onClick$={() => onScheduleAlarm$(alarm.id)}>
										<LuCalendarPlus class="h-3 w-3" />
										Schedule
									</button>
								</li>
							))}
						</ul>
					</div>
				</div>
			)}

			{alarms.length === 0 ? (
				<p class="text-body-subtle text-sm dark:text-gray-500">No alarms configured.</p>
			) : (
				<div class="border-default-medium bg-surface-light dark:bg-surface-dark overflow-x-auto border">
					<table class="text-body w-full text-left text-sm dark:text-gray-400">
						<thead class="bg-surface-light text-body-subtle text-xs uppercase dark:bg-gray-700 dark:text-gray-400">
							<tr>
								<th scope="col" class="px-4 py-3">
									ID
								</th>
								<th scope="col" class="px-4 py-3">
									Callee
								</th>
								<th scope="col" class="px-4 py-3">
									Type
								</th>
								<th scope="col" class="px-4 py-3">
									Next Time
								</th>
								<th scope="col" class="px-4 py-3">
									Cron
								</th>
								<th scope="col" class="px-4 py-3">
									Delay (s)
								</th>
							</tr>
						</thead>
						<tbody>
							{alarms.map((alarm) => {
								const alarmNextDate = new Date(alarm.next_time);
								const isSystemAlarm = systemAlarmIds.has(alarm.id);

								return (
									<tr key={alarm.id} class="border-default-medium border-b dark:border-gray-700">
										<td class="px-4 py-3">
											<div class="flex flex-wrap items-center gap-1.5">
												<code class="text-xs break-all">{alarm.id}</code>
												{isSystemAlarm ? <span class="inline-flex items-center rounded-full bg-blue-100 px-2 py-0.5 text-xs font-medium text-blue-800 dark:bg-blue-900/30 dark:text-blue-400">system</span> : null}
											</div>
										</td>
										<td class="px-4 py-3 font-mono text-xs">{alarm.callee}</td>
										<td class="px-4 py-3">
											<span class={['inline-flex items-center rounded-full px-2 py-0.5 text-xs font-medium', alarm.type === 'cron' ? 'bg-blue-100 text-blue-800 dark:bg-blue-900/30 dark:text-blue-400' : alarm.type === 'scheduled' ? 'bg-green-100 text-green-800 dark:bg-green-900/30 dark:text-green-400' : 'bg-purple-100 text-purple-800 dark:bg-purple-900/30 dark:text-purple-400'].join(' ')}>{alarm.type}</span>
										</td>
										<td class="px-4 py-3 text-xs">
											<time dateTime={alarm.next_time.toISOString()} title={[alarmNextDate.toLocaleString(locale, { hour12: false, timeZone: 'UTC' }), 'UTC'].join(' ')}>
												{[alarmNextDate.toLocaleString(locale, { timeZone: timezone.value.long }), timezone.value.short].join(' ')}
											</time>
										</td>
										<td class="px-4 py-3 font-mono text-xs">{alarm.cron ? alarm.cron.join(', ') : '—'}</td>
										<td class="px-4 py-3 text-xs">{alarm.delay_in_seconds ?? '—'}</td>
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
