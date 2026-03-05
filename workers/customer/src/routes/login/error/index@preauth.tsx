import type { ErrorPageParam } from '@auth/core/types';
import { component$ } from '@builder.io/qwik';
import { Link, routeLoader$ } from '@builder.io/qwik-city';
import { LuAlertTriangle, LuArrowLeft, LuServerCrash, LuShieldAlert, LuUserPlus } from '@qwikest/icons/lucide';
import * as zm from 'zod/mini';

type ErrorType = ErrorPageParam | 'default';

const useError = routeLoader$(({ query }) =>
	zm
		.object({
			error: zm.catch(zm.enum(['AccessDenied', 'Configuration', 'Verification', 'default'] satisfies ErrorType[]), 'default'),
		})
		.parseAsync(Object.fromEntries(query.entries()))
		.then(({ error }) => error),
);

const errorConfig: Record<ErrorType, { icon: typeof LuAlertTriangle; heading: () => string; message: () => string; iconColor: string }> = {
	default: {
		icon: LuAlertTriangle,
		heading: () => 'Something went wrong',
		message: () => 'An unexpected error occurred. Please try again.',
		iconColor: 'text-amber-500 dark:text-amber-400',
	},
	Configuration: {
		icon: LuServerCrash,
		heading: () => 'Server Error',
		message: () => 'There is a problem with the server configuration. Please contact support if the issue persists.',
		iconColor: 'text-red-500 dark:text-red-400',
	},
	AccessDenied: {
		icon: LuUserPlus,
		heading: () => 'Invitation Required',
		message: () => 'This service is invite-only. You need an invitation from an existing member to sign in.',
		iconColor: 'text-blue-500 dark:text-blue-400',
	},
	Verification: {
		icon: LuShieldAlert,
		heading: () => 'Unable to sign in',
		message: () => 'The sign-in link is no longer valid. It may have been used already or it may have expired.',
		iconColor: 'text-orange-500 dark:text-orange-400',
	},
};

export default component$(() => {
	const errorParam = useError();
	const config = errorConfig[errorParam.value];
	const Icon = config.icon;

	return (
		<div class="flex min-h-[60vh] items-center justify-center px-4">
			<div class="w-full max-w-sm">
				<div class="border-surface-light/60 shadow-primary-accent/5 dark:border-surface-dark/60 dark:bg-surface-dark/70 rounded-2xl border bg-white/70 p-8 shadow-xl backdrop-blur-md">
					{/* Icon */}
					<div class="mb-5 flex justify-center">
						<div class={`rounded-full bg-gray-100 p-4 dark:bg-gray-800 ${config.iconColor}`}>
							<Icon class="h-8 w-8" />
						</div>
					</div>

					{/* Heading */}
					<h1 class="mb-3 text-center text-xl font-semibold text-gray-900 dark:text-white">{config.heading()}</h1>

					{/* Message */}
					<p class="mb-6 text-center text-sm leading-relaxed text-gray-500 dark:text-gray-400">{config.message()}</p>

					{/* Back to login button */}
					<Link prefetch="js" href="/login" class="bg-primary-accent hover:bg-primary-accent/85 hover:shadow-primary-accent/25 flex w-full cursor-pointer items-center justify-center gap-2 rounded-xl px-4 py-3 text-sm font-medium text-white transition-all duration-150 hover:shadow-md active:scale-[0.98]">
						<LuArrowLeft class="h-4 w-4" />
						Back to login
					</Link>
				</div>
			</div>
		</div>
	);
});
