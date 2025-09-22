import type { Buffer } from 'node:buffer';
import type { UUID } from 'node:crypto';
import { z as z4 } from 'zod/v4';

export type PrefixedUuid = `${'t_'}${UuidExport['utf8']}${'' | '_p'}`;
export interface UuidExport {
	utf8: UUID;
	hex: string;
	// eslint-disable-next-line @typescript-eslint/no-duplicate-type-constituents
	blob: Buffer['buffer'] | (typeof Uint8Array)['prototype']['buffer'];
	base64: string;
	base64url: string;
}
export const ZodUuidExportInput = z4.union([
	z4
		.string()
		.trim()
		.regex(new RegExp(/^(t_)?[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}(_p)?$/i)),
	z4.uuid().trim(),
	z4
		.string()
		.trim()
		.length(32)
		.refine((value) => isHexadecimal(value)),
	z4.base64().trim(),
	z4.base64url().trim(),
]);

// Filter to check and return only enum types, excluding specified properties
type IfEnum<T> = T extends Record<number | string, any> ? T : never;
// Creating a conditional mapped type that only includes enums
export type FlagObject<T> = {
	[K in keyof T as IfEnum<T[K]> extends never ? never : K]?: T[K] extends Record<any, any> ? T[K][keyof T[K]] : never;
};

export enum Permissions {
	None = 0,
	Read = 1,
	Write = 2,
	Admin = 3,
}

export type EmailAddress = `${string}@${string}.${string}`;

/**
 * Represents a cron expression string (in UTC time).
 * Supports any format supported by `cron-parser` library @link https://www.npmjs.com/package/cron-parser#supported-format
 */
export type CronString = `${string | number} ${string | number} ${string | number} ${string | number} ${string | number}` | `${string | number} ${string | number} ${string | number} ${string | number} ${string | number} ${string | number}`;

export type ISODateString = `${number}-${number}-${number}T${number}:${number}:${number}.${number}Z`;
