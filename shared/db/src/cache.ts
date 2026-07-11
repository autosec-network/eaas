import { Cache as DrizzleCache, type MutationOption } from 'drizzle-orm/cache/core';
import type { CacheConfig } from 'drizzle-orm/cache/core/types';
import { is } from 'drizzle-orm/entity';
import { getTableName, Table } from 'drizzle-orm/table';
import { createHash } from 'node:crypto';
import type { CacheStorageLike } from 'types';
import * as zm from 'zod/mini';

/**
 * SQLCache is a cache implementation for SQL query results, using Web CacheStorage (supports drop in replacements).
 * It supports caching strategies for explicit or global query caching, and provides mechanisms for cache invalidation based on affected tables or tags.
 *
 * @remarks
 * - Designed for use with Drizzle ORM and compatible with CacheStorage APIs.
 * - Tracks which cache keys are associated with which tables for efficient invalidation.
 * - Supports TTL (time-to-live) configuration and custom caching strategies.
 *
 * @extends DrizzleCache
 */
export class SQLCache<C extends CacheStorageLike> extends DrizzleCache {
	private dbName: zm.output<(typeof SQLCache)['constructorArgs']>['dbName'];
	private dbType: zm.output<(typeof SQLCache)['constructorArgs']>['dbType'];
	private cache: Promise<Cache>;
	private globalTtl: zm.output<(typeof SQLCache)['constructorArgs']>['cacheTTL'];
	private ttlCutoff: zm.output<(typeof SQLCache)['constructorArgs']>['cachePurge'];
	private _strategy: zm.output<(typeof SQLCache)['constructorArgs']>['strategy'];
	private logging: zm.output<(typeof SQLCache)['constructorArgs']>['logging'];
	// This object will be used to store which query keys were used for a specific table, so we can later use it for invalidation.
	private usedTablesPerKey: Record<string, string[]> = {};

	public static constructorArgs = zm.object({
		dbName: zm.pipe(
			zm.string().check(zm.trim(), zm.minLength(1)),
			zm.transform((val) => encodeURIComponent(val)),
		),
		dbType: zm.pipe(
			zm.string().check(zm.trim(), zm.minLength(1)),
			zm.transform((val) => encodeURIComponent(val)),
		),
		cacheTTL: zm._default(zm.int().check(zm.nonnegative()), 5 * 60),
		cachePurge: zm._default(zm.union([zm.boolean(), zm.date()]), false),
		strategy: zm._default(zm.enum(['explicit', 'all']), 'explicit'),
		logging: zm._default(zm.boolean(), false),
	});

	/**
	 * Creates an instance of the class with the specified database name, type, and cache TTL.
	 *
	 * @param dbName - The name of the database to use. Must be globally unique as it is used for cache lookup. Will be url encoded if not already url safe.
	 * @param dbType - The type of the database (e.g., `d1`, `pg` `mysql`). Will be url encoded if not already url safe.
	 * @param cacheTTL - The time-to-live (TTL) value for the cache, in seconds.
	 * @param strategy - The caching strategy to use. Defaults to 'explicit'.
	 * - `explicit`: The cache is used only when .$withCache() is added to a query.
	 * - `all`: All queries are cached globally.
	 * @param cacheStore - The cache store to use. Can be a CacheStorage or CacheStorage-like object that atleast contains the `open()` function
	 */
	constructor(args: zm.input<(typeof SQLCache)['constructorArgs']>, cacheStore?: C) {
		super();
		const { dbName, dbType, cacheTTL, cachePurge, strategy, logging } = SQLCache.constructorArgs.parse(args);

		this.dbName = dbName;
		this.dbType = dbType;

		cacheStore ??= globalThis.caches as unknown as C;
		if ('open' in cacheStore && typeof cacheStore.open === 'function') {
			this.cache = cacheStore.open(`${dbType}:${dbName}`);
		} else {
			throw new Error('Cache store must be a CacheStorage (or subclass/instance of)');
		}
		this.globalTtl = cacheTTL;
		this.ttlCutoff = cachePurge;
		this._strategy = strategy;
		this.logging = logging;
	}

	/**
	 * For the strategy, we have two options:
	 * - `explicit`: The cache is used only when .$withCache() is added to a query.
	 * - `all`: All queries are cached globally.
	 * @default 'explicit'
	 */
	override strategy() {
		return this._strategy;
	}

	/**
	 * Generates a cache key as a `Request` object based on the provided tag or key.
	 *
	 * @param tagOrKey - An object containing either a `tag` or a `key` property to identify the cache entry.
	 * @param init - Optional request initialization parameters, as accepted by the `Request` constructor.
	 * @returns A `Request` object representing the cache key, constructed with a URL based on the tag or key and the database configuration.
	 */
	private getCacheKey(tagOrKey: { tag: string } | { key: string }, init?: ConstructorParameters<typeof Request>[1]) {
		const headers = new Headers(init?.headers);
		if (!headers.get('Date')) headers.set('Date', new Date().toUTCString());

		return new Request(new URL(('tag' in tagOrKey ? ['tag', tagOrKey.tag] : ['key', tagOrKey.key]).join('/'), `https://${this.dbName}.${this.dbType}`), { ...init, headers });
	}

	/**
	 * This function accepts query and parameters that cached into key param, allowing you to retrieve response values for this query from the cache.
	 * @param key - A hashed query and parameters.
	 */
	// eslint-disable-next-line @typescript-eslint/no-explicit-any
	override async get(key: string, _tables: string[], isTag: boolean): Promise<any[] | undefined> {
		const cacheKey = this.getCacheKey(isTag ? { tag: key } : { key });
		const response = await this.cache.then(async (cache) => cache.match(cacheKey));

		if (this.logging) console.debug('SQLCache.get', isTag ? 'tag' : 'key', key, response?.ok ? 'HIT' : 'MISS');

		if (response) {
			// Check if cache should be purged
			if (this.ttlCutoff === true) {
				if (this.logging) console.debug('SQLCache.get', 'cache purged', this.ttlCutoff);
				await this.cache.then((cache) => cache.delete(cacheKey));
				return undefined;
			}

			if (this.ttlCutoff instanceof Date) {
				const responseDate = response.headers.get('Date');

				if (responseDate) {
					const cachedDate = new Date(responseDate);

					if (cachedDate < this.ttlCutoff) {
						if (this.logging) console.debug('SQLCache.get', 'cache purged', { cachedDate, cutoff: this.ttlCutoff });
						await this.cache.then((cache) => cache.delete(cacheKey));
						return undefined;
					}
				} else {
					if (this.logging) console.debug('SQLCache.get', 'cache purged', { responseDate });
					await this.cache.then((cache) => cache.delete(cacheKey));
					return undefined;
				}
			}

			return response.json();
		} else {
			return undefined;
		}
	}

	/**
	 * This function accepts several options to define how cached data will be stored:
	 * @param hashedQuery - A hashed query and parameters.
	 * @param response - An array of values returned by Drizzle from the database.
	 * @param tables - An array of tables involved in the select queries. This information is needed for cache invalidation.
	 *
	 * For example, if a query uses the "users" and "posts" tables, you can store this information. Later, when the app executes any mutation statements on these tables, you can remove the corresponding key from the cache.
	 * If you're okay with eventual consistency for your queries, you can skip this option.
	 */
	// eslint-disable-next-line @typescript-eslint/no-explicit-any
	override async put(hashedQuery: string, response: any, tables: string[], isTag: boolean, config?: CacheConfig): Promise<void> {
		let ttl: number = this.globalTtl;
		if (config?.ex) {
			ttl = config.ex;
		} else if (config?.px) {
			ttl = Math.floor(config.px / 1000);
		} else if (config?.exat) {
			ttl = Math.floor((new Date(config.exat * 1000).getTime() - Date.now()) / 1000);
		} else if (config?.pxat) {
			ttl = Math.floor((new Date(config.pxat).getTime() - Date.now()) / 1000);
		}

		const cacheResponse = new Response(JSON.stringify(response), {
			headers: {
				'Content-Type': 'application/json',
				'Cache-Control': `public, max-age=${ttl}, s-maxage=${ttl}`,
			},
		});

		// We don't want to consume the body
		const cacheResponseClonedBody = cacheResponse.clone().body;
		if (cacheResponseClonedBody) {
			cacheResponse.headers.set(
				'ETag',
				await (async () => {
					const hash = createHash('sha512');

					async function* streamAsyncIterable(stream: ReadableStream<Uint8Array>) {
						const reader = stream.getReader();
						try {
							// eslint-disable-next-line @typescript-eslint/no-unnecessary-condition
							while (true) {
								const { done, value } = await reader.read();
								if (done) return;
								yield value;
							}
						} finally {
							reader.releaseLock();
						}
					}

					for await (const chunk of streamAsyncIterable(cacheResponseClonedBody)) {
						hash.update(chunk);
					}
					return `"${hash.digest('hex')}"`;
				})(),
			);
		}

		await this.cache
			.then(async (cache) => cache.put(this.getCacheKey(isTag ? { tag: hashedQuery } : { key: hashedQuery }), cacheResponse))
			.then(() => {
				if (this.logging) console.debug('SQLCache.put', isTag ? 'tag' : 'key', hashedQuery, 'SUCCESS');
			});

		for (const table of tables) {
			const keys = this.usedTablesPerKey[table];
			if (keys === undefined) {
				this.usedTablesPerKey[table] = [hashedQuery];
			} else {
				keys.push(hashedQuery);
			}
		}
	}

	/**
	 * This function is called when insert, update, or delete statements are executed.
	 * You can either skip this step or invalidate queries that used the affected tables.
	 *
	 * @param tags - Used for queries labeled with a specific tag, allowing you to invalidate by that tag.
	 * @param tables - The actual tables affected by the insert, update, or delete statements, helping you track which tables have changed since the last cache update.
	 */
	override async onMutate(params: MutationOption): Promise<void> {
		const tagsArray = params.tags ? (Array.isArray(params.tags) ? params.tags : [params.tags]) : [];
		const tablesArray = params.tables ? (Array.isArray(params.tables) ? params.tables : [params.tables]) : [];
		const keysToDelete = new Set<string>();
		for (const table of tablesArray) {
			const tableName = is(table, Table) ? getTableName(table) : (table as string);
			const keys = this.usedTablesPerKey[tableName] ?? [];
			for (const key of keys) keysToDelete.add(key);
		}
		if (keysToDelete.size > 0 || tagsArray.length > 0) {
			for (const tag of tagsArray) {
				await this.cache
					.then(async (cache) => cache.delete(this.getCacheKey({ tag })))
					.then(() => {
						if (this.logging) console.debug('SQLCache.delete', 'tag', tag, 'SUCCESS');
					});
			}
			for (const key of keysToDelete) {
				await this.cache
					.then(async (cache) => cache.delete(this.getCacheKey({ key })))
					.then(() => {
						if (this.logging) console.debug('SQLCache.delete', 'key', key, 'SUCCESS');
					});

				for (const table of tablesArray) {
					const tableName = is(table, Table) ? getTableName(table) : (table as string);
					this.usedTablesPerKey[tableName] = [];
				}
			}
		}
	}
}
