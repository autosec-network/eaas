import type { UUID } from 'node:crypto';

// eslint-disable-next-line @typescript-eslint/no-explicit-any
export const USER_SYSTEM_ALARMS: Record<UUID, { when: number | string[] | Date; callee: string; payload?: any[] }> = {
	// Cleanup verification tokens
	'019cd651-d616-7441-a7f5-b5a9ed2023e2': {
		when: ['*/5 * * * *'],
		callee: '_cleanupVerificationTokens',
	},
} as const;
