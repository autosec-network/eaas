import type * as zm from 'zod/mini';

export type ZodPick<O extends zm.ZodMiniObject> = Partial<Record<keyof zm.output<O>, boolean>>;
export type ZodPickedKeys<P extends ZodPick<O>, O extends zm.ZodMiniObject> = Extract<{ [K in keyof P]: P[K] extends true ? K : never }[keyof P], keyof zm.output<O>>;

export type ZodPartial<T extends zm.ZodMiniObject> = zm.ZodMiniObject<
	{
		[k in keyof T['shape']]: zm.ZodMiniOptional<T['shape'][k]>;
	},
	T['_zod']['config']
>;
