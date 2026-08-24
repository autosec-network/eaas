import { component$ } from '@builder.io/qwik';
import { LuFileOutput, LuHash, LuRefreshCw, LuTimer } from '@qwikest/icons/lucide';

// eslint-disable-next-line @typescript-eslint/ban-ts-comment
// @ts-ignore this gets generated automatically later in the build process
import * as m from '~/paraglide/messages';

interface Props {
	/**
	 * `keyrings.time_rotation` - whether the scheduler DO holding the actual cron is enabled.
	 */
	timeRotation: boolean;
	/**
	 * `keyrings.count_rotation` as a decimal string, or `null` when count-based rotation is off.
	 */
	countRotation: string | null;
	/**
	 * `keyrings.plaintext_export` - write-once at creation.
	 */
	plaintextExport: boolean;
}

const chipClass = 'inline-flex h-6 w-6 items-center justify-center rounded-full border text-gray-600 dark:text-gray-300';

export default component$<Props>(({ timeRotation, countRotation, plaintextExport }) => (
	<span class="inline-flex items-center gap-1.5">
		{timeRotation ? (
			<span class={[chipClass, 'border-sky-300 bg-sky-50 text-sky-700 dark:border-sky-800 dark:bg-sky-950/40 dark:text-sky-300']} title={m.keyrings_chip_time_rotation()} aria-label={m.keyrings_chip_time_rotation()}>
				<LuTimer class="h-3.5 w-3.5" aria-hidden="true" />
			</span>
		) : null}

		{countRotation !== null ? (
			<span class={[chipClass, 'border-violet-300 bg-violet-50 text-violet-700 dark:border-violet-800 dark:bg-violet-950/40 dark:text-violet-300']} title={m.keyrings_chip_count_rotation({ threshold: countRotation })} aria-label={m.keyrings_chip_count_rotation({ threshold: countRotation })}>
				{/* The pound sign sits inside the refresh arrows rather than beside them: one glyph reads as "rotates on a count", two read as two separate states */}
				<span class="relative inline-flex h-3.5 w-3.5 items-center justify-center" aria-hidden="true">
					<LuRefreshCw class="h-3.5 w-3.5" />
					<LuHash class="absolute h-[0.4375rem] w-[0.4375rem]" />
				</span>
			</span>
		) : null}

		{plaintextExport ? (
			<span class={[chipClass, 'border-amber-300 bg-amber-50 text-amber-700 dark:border-amber-800 dark:bg-amber-950/40 dark:text-amber-300']} title={m.keyrings_chip_exportable()} aria-label={m.keyrings_chip_exportable()}>
				<LuFileOutput class="h-3.5 w-3.5" aria-hidden="true" />
			</span>
		) : null}
	</span>
));
