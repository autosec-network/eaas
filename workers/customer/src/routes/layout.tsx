import type { Session } from '@auth/qwik';
import { component$, Slot } from '@builder.io/qwik';
import { routeLoader$, server$, type RequestHandler } from '@builder.io/qwik-city';
import { SQLCache } from 'db/cache';
import { DebugLogWriter, drizzleD0, StaticDatabase } from 'db/core';
import * as rootSchema from 'db/schemas/root';
import * as analyticsSchema from 'db/schemas/wae';
import { drizzleAE } from 'db/wae';
import type { DrizzleD1Database } from 'drizzle-orm/d1';
import { drizzle } from 'drizzle-orm/d1';
import { DefaultLogger } from 'drizzle-orm/logger';
import { desc, eq, sql } from 'drizzle-orm/sql';
import { Buffer } from 'node:buffer';
import { createHash, timingSafeEqual } from 'node:crypto';
import type { DOJurisdictions } from 'types';
import SidebarLayout from '~/components/sidebar/sidebar-layout/sidebar-layout';
import { deleteSession } from '~/helpers/d0-adapter';
import { deriveId, resolveDoStub, type DOLocator } from '~/helpers/do-proxy';
import { getSessionBinding } from '~/routes/plugin@auth';
import { locales as inlangLocales } from '../../project.inlang/settings.json' with { type: 'json' };

// @ts-expect-error this gets generated automatically later in the build process
import { setLocale } from '~/paraglide/runtime';

export interface Accept {
	type: string;
	params: Record<string, string>;
	q: number;
}

/**
 * @link https://github.com/honojs/hono/blob/main/src/middleware/language/language.ts
 */
export const onRequest: RequestHandler = async ({ sharedMap, redirect, url, platform, request, locale }) => {
	// Setup vars
	const isProd = platform.env.ENVIRONMENT === 'production';
	sharedMap.set('isProd', isProd);

	// Local
	const isLocal = !('GIT_HASH' in platform.env);
	sharedMap.set('isLocal', isLocal);

	const headers = (platform.request ?? request).headers;

	// Browser cache
	const cacheControl = new Set((headers.get('Cache-Control')?.split(',') ?? []).map((directive) => directive.trim().toLowerCase()));
	// RFC 7234: no-store forbids storing; no-cache/zero max-age require revalidation so we skip reads
	const toCache = cacheControl.has('no-store') || cacheControl.has('no-cache') || cacheControl.has('max-age=0') || cacheControl.has('s-maxage=0');
	const browserCache = !toCache;
	sharedMap.set('browserCache', browserCache);

	// Analytics
	const a_db = drizzleAE(
		{
			write: {
				...(platform.env.LANG_ANALYTICS && { EAAS_LANG_ANALYTICS: platform.env.LANG_ANALYTICS }),
			},
		},
		{
			...(platform.env.NODE_ENV !== 'production' && { logger: new DefaultLogger({ writer: new DebugLogWriter('wae') }) }),
			cache: new SQLCache(
				{
					dbName: 'workers',
					dbType: 'ae',
					strategy: browserCache ? 'all' : 'explicit',
					cacheTTL: parseInt(platform.env.SQL_TTL, 10),
					logging: platform.env.NODE_ENV !== 'production',
				},
				// eslint-disable-next-line @typescript-eslint/no-unnecessary-condition
				globalThis.caches ?? platform.caches,
			),
		},
	);
	sharedMap.set('a_db', a_db);

	// Database
	const r_d1_id = isProd ? StaticDatabase.Root.eaas_root_prod : StaticDatabase.Root.eaas_root_dev;
	const r_db = drizzle(platform.env.DB_ROOT.withSession('first-unconstrained') as unknown as D1Database, {
		// ...(platform.env.NODE_ENV !== 'production' && { logger: new DefaultLogger({ writer: new DebugLogWriter(r_d1_id) }) }),
		logger: new DefaultLogger({ writer: new DebugLogWriter(r_d1_id) }),
		cache: new SQLCache(
			{
				dbName: r_d1_id,
				dbType: 'd1',
				strategy: browserCache ? 'all' : 'explicit',
				cacheTTL: parseInt(platform.env.SQL_TTL, 10),
				logging: platform.env.NODE_ENV !== 'production',
			},
			// eslint-disable-next-line @typescript-eslint/no-unnecessary-condition
			globalThis.caches ?? platform.caches,
		),
	});
	sharedMap.set('r_db', r_db);

	// Session
	const session = sharedMap.get('session') as Session | null;
	// If there's no session, we can't do any binding checks, so we redirect to sign in immediately. This also avoids running the binding check code for unauthenticated users, which would be a waste of resources.
	if (!session) throw redirect(307, `/login?callbackUrl=${url.pathname}`);

	// Detailed session check
	await (async () => {
		const forceSignIn = async () => {
			if (session.do_id) await deleteSession(platform, r_db, session.do_id, false);
			throw redirect(307, `/login?callbackUrl=${url.pathname}`);
		};

		// If session is expired
		if (new Date(session.expires) < new Date()) await forceSignIn();

		/**
		 * Calculate new
		 */
		const { lite, normal, sensitive, debug } = await getSessionBinding((platform.request ?? platform).cf as IncomingRequestCfProperties, (platform.request ?? request).headers);

		const lite_stored = Buffer.from(session.lite_binding, 'base64');
		const lite_computed = Buffer.from(lite);
		const normal_stored = Buffer.from(session.normal_binding, 'base64');
		const normal_computed = Buffer.from(normal);
		const sensitive_stored = Buffer.from(session.sensitive_binding, 'base64');
		const sensitive_computed = Buffer.from(sensitive);

		if (!(timingSafeEqual(lite_stored, lite_computed) && lite_stored.byteLength === lite_computed.byteLength)) {
			console.error('lite binding value check failed', {
				stored: {
					hash: lite_stored.toString('base64'),
					raw: debug.lite,
				},
				computed: {
					hash: lite_computed.toString('base64'),
					raw: session.binding_debug.lite,
				},
			});

			// platform.ctx.waitUntil(sessionEmail(session.sessionToken));

			// await forceSignIn();
		}

		if (!(timingSafeEqual(normal_stored, normal_computed) && normal_stored.byteLength === normal_computed.byteLength)) {
			console.error('normal binding value check failed', {
				stored: {
					hash: normal_stored.toString('base64'),
					raw: debug.normal,
				},
				computed: {
					hash: normal_computed.toString('base64'),
					raw: session.binding_debug.normal,
				},
			});
		}

		if (!(timingSafeEqual(sensitive_stored, sensitive_computed) && sensitive_stored.byteLength === sensitive_computed.byteLength)) {
			console.error('sensitive binding value check failed', {
				stored: {
					hash: sensitive_stored.toString('base64'),
					raw: debug.sensitive,
				},
				computed: {
					hash: sensitive_computed.toString('base64'),
					raw: session.binding_debug.sensitive,
				},
			});
		}
	})();

	// Locally we can't derive a jurisdictional id (workerd throws), so defer that to the proxy and leave the derivation-carrying locator raw.
	const useProxy = isLocal && !!platform.env.USER_D0_PROXY;
	const locator: DOLocator = session.user?.do_id ? { id: session.user.do_id, jurisdiction: session.user.do_jurisdiction ?? undefined } : { name: session.user!.id, jurisdiction: session.user?.do_jurisdiction ?? undefined };
	// Stable cache key: the resolved id hex when deployed, else whatever identifies the locator locally.
	const doDbName = useProxy ? (locator.id ?? locator.name!) : deriveId(platform.env.USER_D0, locator).toString();
	const doStub = resolveDoStub(platform, platform.env.USER_D0, platform.env.USER_D0_PROXY, locator);
	sharedMap.set('u_do', doStub);
	sharedMap.set(
		'u_db',
		drizzleD0(doStub, {
			...(platform.env.NODE_ENV !== 'production' && { logger: new DefaultLogger({ writer: new DebugLogWriter(doDbName) }) }),
			cache: new SQLCache(
				{
					dbName: doDbName,
					dbType: 'do',
					strategy: browserCache ? 'all' : 'explicit',
					cacheTTL: parseInt(platform.env.SQL_TTL, 10),
					logging: platform.env.NODE_ENV !== 'production',
				},
				// eslint-disable-next-line @typescript-eslint/no-unnecessary-condition
				globalThis.caches ?? platform.caches,
			),
		}),
	);

	// Locale
	await (async () => {
		const parseParams = (paramParts: string[]): Record<string, string> => {
			return paramParts.reduce<Record<string, string>>((acc, param) => {
				const [key, val] = param.split('=').map((s) => s.trim());
				if (key && val) {
					acc[key] = val;
				}
				return acc;
			}, {});
		};
		const parseQuality = (qVal?: string): number => {
			if (qVal === undefined) {
				return 1;
			}
			if (qVal === '') {
				return 1;
			}
			if (qVal === 'NaN') {
				return 0;
			}

			const num = Number(qVal);
			if (num === Infinity) {
				return 1;
			}
			if (num === -Infinity) {
				return 0;
			}
			if (Number.isNaN(num)) {
				return 1;
			}
			if (num < 0 || num > 1) {
				return 1;
			}

			return num;
		};

		const parseAcceptValue = ({ value, index }: { value: string; index: number }) => {
			const parseAcceptValueRegex = /;(?=(?:(?:[^"]*"){2})*[^"]*$)/;
			const parts = value
				.trim()
				.split(parseAcceptValueRegex)
				.map((s) => s.trim());
			const type = parts[0];
			if (!type) {
				return null;
			}

			const params = parseParams(parts.slice(1));
			const q = parseQuality(params['q']);

			return { type, params, q, index };
		};
		const sortByQualityAndIndex = (a: Accept & { index: number }, b: Accept & { index: number }) => {
			const qDiff = b.q - a.q;
			if (qDiff !== 0) {
				return qDiff;
			}
			return a.index - b.index;
		};

		const parseAccept = (acceptHeader: string): Accept[] => {
			if (!acceptHeader) {
				return [];
			}

			const acceptValues = acceptHeader.split(',').map((value, index) => ({ value, index }));

			return acceptValues
				.map(parseAcceptValue)
				.filter((item): item is Accept & { index: number } => Boolean(item))
				.sort(sortByQualityAndIndex)
				.map(({ type, params, q }) => ({ type, params, q }));
		};

		function parseAcceptLanguage(header: string): { lang: string; q: number }[] {
			return parseAccept(header).map(({ type, q }) => ({ lang: type, q }));
		}

		if (headers.has('Accept-Language')) {
			const parsedLocales = parseAcceptLanguage(headers.get('Accept-Language')!);
			locale(parsedLocales[0]?.lang);

			// Strip out language subtags
			const parsedSingleLocales = Array.from(new Set(parsedLocales.map(({ lang }) => lang.split('-')[0]).filter((lang) => lang !== undefined)));
			// Track most common languages to prioritize adding in future builds.
			if (parsedSingleLocales.length > 0) {
				platform.ctx.waitUntil(
					a_db.insert(analyticsSchema.EAAS_LANG_ANALYTICS).values({
						// To be able to sample by session to unskew results by remove duplicates but anonymize
						hashed_session_id: createHash('sha512').update(session.do_id!).digest('base64'),
						// Top languages in order of priority
						...parsedSingleLocales
							// 20 cap due to Analytics Engine limits
							.slice(0, 20)
							.reduce<Record<string, string>>((acc, lang, index) => {
								acc[`lang${index + 1}`] = lang;
								return acc;
							}, {}),
					}),
				);
			}
			// Make `Set` to avoid O(n²)
			const paraglideLocalesSet = new Set(inlangLocales);
			// Runtime check (since JSON isn't strongly typed)
			const paraglideLocale = parsedSingleLocales.find((lang) => paraglideLocalesSet.has(lang)) as Parameters<typeof setLocale>[0] | undefined;
			await setLocale(paraglideLocale ?? 'en');
		}
	})();
};

export function rawTimezone(platform: QwikCityPlatform, locale: Intl.LocalesArgument) {
	const long = ((platform.request ?? platform).cf as IncomingRequestCfProperties).timezone;

	return {
		long,
		short: new Intl.DateTimeFormat(locale, { timeZoneName: 'short', timeZone: long }).formatToParts(new Date()).find((p) => p.type === 'timeZoneName')?.value,
	} as const;
}
export const useTimezone = routeLoader$(({ platform, locale }) => {
	return rawTimezone(platform, locale());
});

export const useLocale = routeLoader$(({ locale }) => locale());

// eslint-disable-next-line @typescript-eslint/require-await
export const useTenants = routeLoader$(async ({ sharedMap }) => async () => {
	const session = sharedMap.get('session') as Session;

	const r_db = sharedMap.get('r_db') as DrizzleD1Database;

	return (
		r_db
			.select({
				t_id: rootSchema.tenants.t_id,
				jurisdiction: rootSchema.tenants.jurisdiction,
				do_id: rootSchema.tenants.do_id,
			})
			.from(rootSchema.tenants)
			.innerJoin(rootSchema.users_tenants, eq(rootSchema.tenants.t_id, rootSchema.users_tenants.t_id))
			.where(eq(rootSchema.users_tenants.u_id, sql`unhex(${session.user?.u_id.hex})`))
			// Sort so newest is i[0]
			.orderBy(desc(rootSchema.tenants.t_id))
			.then((rows) =>
				rows.map((row) => ({
					...row,
					t_id: {
						base64: row.t_id.toString('base64'),
						base64url: row.t_id.toString('base64url'),
					},
					do_id: row.do_id.toString('hex'),
				})),
			)
	);
});

export const getTenantPickerProperties = server$(function (jurisdiction: DOJurisdictions | null, do_id: string) {
	const doStub = resolveDoStub(this.platform, this.platform.env.TENANT_D0, this.platform.env.TENANT_D0_PROXY, { id: do_id, jurisdiction: jurisdiction ?? undefined });

	return doStub.getProperties(
		{
			name: true,
			avatar: true,
			m_time: true,
		},
		true,
	);
});

export default component$(() => {
	return (
		<SidebarLayout>
			<Slot />
		</SidebarLayout>
	);
});
