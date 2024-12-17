import type { Buffer } from 'node:buffer';
import type { UUID } from 'node:crypto';

export type PrefixedUuid = `${'t_'}${UuidExport['utf8']}${'' | '_p'}`;
export type D1Blob = [number, ...number[]];
export interface UuidExport {
	utf8: UUID;
	hex: string;
	// eslint-disable-next-line @typescript-eslint/no-duplicate-type-constituents
	blob: (typeof Uint8Array)['prototype']['buffer'] | Buffer['buffer'];
	base64: string;
	base64url: string;
}

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
