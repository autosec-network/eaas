/**
 * Interface for CacheStorage-like objects that can be used as drop-in replacements.
 * This interface ensures compatibility with the Web API CacheStorage while allowing for custom implementations that provide the same core functionality.
 */
export interface CacheStorageLike {
	/** [MDN Reference](https://developer.mozilla.org/docs/Web/API/CacheStorage/open) */
	open(cacheName: string): Promise<Cache>;
}

/**
 * It is used to carry over the types when using the `Object.values()` method.
 */
export type ObjectValues<T> =
	{
		[K in keyof T]: T[K];
	} extends Record<string, infer U>
		? U[]
		: never;

export enum Permissions {
	None = 0,
	Read = 1,
	Write = 2,
	Admin = 3,
}
