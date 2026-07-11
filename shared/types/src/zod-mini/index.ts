import type * as zm from 'zod/mini';

export type ZodPick<O extends zm.ZodMiniObject> = Partial<Record<keyof zm.output<O>, boolean>>;
export type ZodPickedKeys<P extends ZodPick<O>, O extends zm.ZodMiniObject> = Extract<{ [K in keyof P]: P[K] extends true ? K : never }[keyof P], keyof zm.output<O>>;

export type ZodPartial<T extends zm.ZodMiniObject> = zm.ZodMiniObject<
	{
		[k in keyof T['shape']]: zm.ZodMiniOptional<T['shape'][k]>;
	},
	T['_zod']['config']
>;

// Same as `zm.regexes.uuid()` but without hyphens
export const hexUuidRegex = /^[0-9a-f]{8}[0-9a-f]{4}[0-9a-f]{4}[0-9a-f]{4}[0-9a-f]{12}$/i;
// Same as `zm.regexes.uuid4` but without hyphens
export const hexUuid4Regex = /^[0-9a-f]{8}[0-9a-f]{4}4[0-9a-f]{3}[0-9a-f]{4}[0-9a-f]{12}$/i;
// Same as `zm.regexes.uuid7` but without hyphens
export const hexUuid7Regex = /^[0-9a-f]{8}[0-9a-f]{4}7[0-9a-f]{3}[0-9a-f]{4}[0-9a-f]{12}$/i;
