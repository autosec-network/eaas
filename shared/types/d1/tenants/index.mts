import type { FlagObject } from '../index.js';

export namespace TenantFlags {
	// Dummy value to ensure namespace is never empty
	export const _dummy = undefined;
}
export type TenantFlagsObject = FlagObject<typeof TenantFlags>;
