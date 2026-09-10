import type { RequestHandler } from '@builder.io/qwik-city';
import { SQLCache } from 'db/cache';
import { DebugLogWriter, StaticDatabase } from 'db/core';
import { drizzle } from 'drizzle-orm/d1';
import { DefaultLogger } from 'drizzle-orm/logger';
import * as zm from 'zod/mini';

export const onRequest: RequestHandler = async ({ params, sharedMap, platform, next, redirect }) => {
	if (zm.validate(zm.enum(['production', 'dev']), params['environment'])) {
		// Setup vars
		const isProd = params['environment'] === 'production';
		sharedMap.set('isProd', isProd);

		const dbId = isProd ? StaticDatabase.Root.eaas_root_prod : StaticDatabase.Root.eaas_root_dev;
		const browserCache = sharedMap.get('browserCache') as boolean;
		sharedMap.set(
			'r_db',
			drizzle((isProd ? platform.env.DB_ROOT_PROD : platform.env.DB_ROOT_PREVIEW).withSession('first-unconstrained') as unknown as D1Database, {
				...(platform.env.NODE_ENV !== 'production' && { logger: new DefaultLogger({ writer: new DebugLogWriter(dbId) }) }),
				cache: new SQLCache(
					{
						dbName: dbId,
						dbType: 'd1',
						strategy: browserCache ? 'all' : 'explicit',
						cacheTTL: parseInt(platform.env.SQL_TTL, 10),
						// eslint-disable-next-line @typescript-eslint/no-unnecessary-condition
						logging: platform.env.NODE_ENV !== 'production',
					},
					// eslint-disable-next-line @typescript-eslint/no-unnecessary-condition
					globalThis.caches ?? platform.caches,
				),
			}),
		);

		await next();
	} else {
		throw redirect(302, '/');
	}
};
