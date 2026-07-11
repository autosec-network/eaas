/**
 * Interface for CacheStorage-like objects that can be used as drop-in replacements.
 * This interface ensures compatibility with the Web API CacheStorage while allowing for custom implementations that provide the same core functionality.
 */
export interface CacheStorageLike {
	/** [MDN Reference](https://developer.mozilla.org/docs/Web/API/CacheStorage/open) */
	open(cacheName: string): Promise<Cache>;
}

export type MethodNames<T> = {
	[K in keyof T]: T[K] extends (...args: any[]) => any ? K : never;
}[keyof T] &
	string;

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

/**
 * @link https://developers.cloudflare.com/durable-objects/reference/data-location/#restrict-durable-objects-to-a-jurisdiction
 */
export enum DOJurisdictions {
	'The European Union' = 'eu',
	'FedRAMP-compliant data centers' = 'fedramp',
	'FedRAMP High authorization' = 'fedramp-high',
	'The United States' = 'us',
}
/**
 * @link https://developers.cloudflare.com/durable-objects/reference/data-location/#provide-a-location-hint
 */
export enum DOLocations {
	'Western North America' = 'wnam',
	'Eastern North America' = 'enam',
	'South America' = 'sam',
	'Western Europe' = 'weur',
	'Eastern Europe' = 'eeur',
	'Asia-Pacific' = 'apac',
	'Northeast Asia-Pacific' = 'apac-ne',
	'Southeast Asia-Pacific' = 'apac-se',
	Oceania = 'oc',
	Africa = 'afr',
	'Middle East' = 'me',
}
