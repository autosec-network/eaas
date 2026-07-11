import type { UUID } from 'node:crypto';

// eslint-disable-next-line @typescript-eslint/no-explicit-any
export const TENANT_LOGS_SYSTEM_ALARMS: Record<UUID, { when: number | string[] | Date; callee: string; payload?: any[] }> = {
	// Cleanup pending websockets
	'019d27bc-53ba-7a62-b03a-a220d5c2a3cb': {
		when: ['*/5 * * * *'],
		callee: '_cleanupPendingWebsockets',
	},
	// Optimzie db
	'019d27be-24a5-777e-8e4f-2f022ed77ddd': {
		when: ['0 0 * * *'],
		callee: '_optimizeDb',
	},
} as const;
