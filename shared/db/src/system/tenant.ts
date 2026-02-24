import type { UUID } from 'node:crypto';

// eslint-disable-next-line @typescript-eslint/no-explicit-any
export const TENANT_SYSTEM_ALARMS: Record<UUID, { when: number | string[] | Date; callee: string; payload?: any[] }> = {} as const;
