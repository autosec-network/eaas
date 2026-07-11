import { component$ } from '@builder.io/qwik';
import { Link } from '@builder.io/qwik-city';
import { LuArrowLeft, LuMailCheck } from '@qwikest/icons/lucide';

// eslint-disable-next-line @typescript-eslint/ban-ts-comment
// @ts-ignore this gets generated automatically later in the build process
import * as m from '~/paraglide/messages';

export default component$(() => {
	return (
		<div class="flex min-h-[60vh] items-center justify-center px-4">
			<div class="w-full max-w-sm">
				<div class="border-surface-light/60 shadow-primary-accent/5 dark:border-surface-dark/60 dark:bg-surface-dark/70 rounded-2xl border bg-white/70 p-8 shadow-xl backdrop-blur-md">
					<div class="mb-5 flex justify-center">
						<div class="rounded-full bg-green-100 p-4 text-green-500 dark:bg-green-900/30 dark:text-green-400">
							<LuMailCheck class="h-8 w-8" />
						</div>
					</div>

					<h1 class="mb-3 text-center text-xl font-semibold text-gray-900 dark:text-white">{m.verify_heading()}</h1>
					<p class="mb-2 text-center text-sm leading-relaxed text-gray-500 dark:text-gray-400">{m.verify_message()}</p>
					<p class="mb-6 text-center text-xs text-gray-400 dark:text-gray-500">{m.verify_hint()}</p>

					<Link prefetch="js" href="/login" class="bg-primary-accent hover:bg-primary-accent/85 hover:shadow-primary-accent/25 flex w-full cursor-pointer items-center justify-center gap-2 rounded-xl px-4 py-3 text-sm font-medium text-white transition-all duration-150 hover:shadow-md active:scale-[0.98]">
						<LuArrowLeft class="h-4 w-4" />
						{m.back_to_login()}
					</Link>
				</div>
			</div>
		</div>
	);
});
