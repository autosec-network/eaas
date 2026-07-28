import type { RequestHandler } from '@builder.io/qwik-city';
import { SQLCache } from 'db/cache';
import { DebugLogWriter, drizzleD0 } from 'db/core';
import * as rootSchema from 'db/schemas/root';
import type { DrizzleD1Database } from 'drizzle-orm/d1';
import { DefaultLogger } from 'drizzle-orm/logger';
import { eq, sql } from 'drizzle-orm/sql';
import * as zm from 'zod/mini';
import { hexToUuid } from '~/routes/[environment]/users/db-helpers';

export const onRequest: RequestHandler = async ({ params, sharedMap, platform, next, redirect }) => {
	const { success } = await zm.hex().check(zm.length(32)).safeParseAsync(params['uid']);

	if (success) {
		const r_db = sharedMap.get('r_db') as DrizzleD1Database;

		const [user] = await r_db
			.select({
				jurisdiction: rootSchema.users.jurisdiction,
				do_id: rootSchema.users.do_id,
			})
			.from(rootSchema.users)
			.where(eq(rootSchema.users.u_id, sql`unhex(${params['uid']})`))
			.limit(1)
			.then((rows) =>
				rows.map((row) => ({
					...row,
					do_id: row.do_id?.toString('hex'),
				})),
			);

		const doNamespace = platform.env.USER_D0_PROD;
		const doNamespaceJurisdiction = user?.jurisdiction ? doNamespace.jurisdiction(user.jurisdiction) : doNamespace;
		const doId = user?.do_id ? doNamespaceJurisdiction.idFromString(user.do_id) : doNamespaceJurisdiction.idFromName(hexToUuid(params['uid']!));
		const doStub = doNamespace.get(doId);
		sharedMap.set('u_do', doStub);
		sharedMap.set('u_jurisdiction', user?.jurisdiction ?? null);

		const browserCache = sharedMap.get('browserCache') as boolean;
		sharedMap.set(
			'u_db',
			drizzleD0(doStub, {
				...(platform.env.NODE_ENV !== 'production' && { logger: new DefaultLogger({ writer: new DebugLogWriter(doId.toString()) }) }),
				cache: new SQLCache(
					{
						dbName: doId.toString(),
						dbType: 'do',
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
		throw redirect(302, `/${params['environment']}/users/`);
	}
};
