import type { UUID } from 'node:crypto';

// eslint-disable-next-line @typescript-eslint/no-explicit-any
export const TENANT_SYSTEM_ALARMS: Record<UUID, { when: number | string[] | Date; callee: string; payload?: any[] }> = {
	// Cleanup verification tokens
	'019d5bbc-1f4a-7c63-9d1e-4a8f2b7c0e51': {
		when: ['*/15 * * * *'],
		callee: '_cleanupVerificationTokens',
	},
} as const;
