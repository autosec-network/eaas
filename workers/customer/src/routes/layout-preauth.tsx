import { routeLoader$, type RequestHandler } from '@builder.io/qwik-city';
import { locales as inlangLocales } from '../../project.inlang/settings.json' with { type: 'json' };

export const useTurnstileKey = routeLoader$(({ platform }) =>
	!('GIT_HASH' in platform.env)
		? /**
			 * Test successful form submissions
			 * @link https://developers.cloudflare.com/turnstile/troubleshooting/testing/#test-sitekeys
			 */
			'1x00000000000000000000AA'
		: platform.env.TURNSTILE_SITE_KEY,
);

// @ts-expect-error this gets generated automatically later in the build process
import { setLocale } from '~/paraglide/runtime';

interface Accept {
	type: string;
	params: Record<string, string>;
	q: number;
}

/**
 * @link https://github.com/honojs/hono/blob/main/src/middleware/language/language.ts
 */
export const onRequest: RequestHandler = async ({ platform, request, locale, sharedMap }) => {
	const headers = (platform.request ?? request).headers;

	await Promise.allSettled([
		// Locale

		(async () => {
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

			if (request.headers.has('Accept-Language')) {
				const parsedLocales = parseAcceptLanguage(request.headers.get('Accept-Language')!);
				locale(parsedLocales[0]?.lang);

				// Make `Set` to avoid O(n²)
				const paraglideLocalesSet = new Set(inlangLocales);
				// Runtime check (since JSON isn't strongly typed)
				const paraglideLocale = Array.from(new Set(parsedLocales.map(({ lang }) => lang.split('-')[0]).filter((lang) => lang !== undefined))).find((lang) => paraglideLocalesSet.has(lang)) as Parameters<typeof setLocale>[0] | undefined;
				await setLocale(paraglideLocale ?? 'en');
			}
		})(),
		// Browser cache
		// eslint-disable-next-line @typescript-eslint/require-await
		(async () => {
			const cacheControl = new Set((headers.get('Cache-Control')?.split(',') ?? []).map((directive) => directive.trim().toLowerCase()));
			// RFC 7234: no-store forbids storing; no-cache/zero max-age require revalidation so we skip reads
			const toCache = cacheControl.has('no-store') || cacheControl.has('no-cache') || cacheControl.has('max-age=0') || cacheControl.has('s-maxage=0');
			sharedMap.set('browserCache', !toCache);
		})(),
		// Local
		// eslint-disable-next-line @typescript-eslint/require-await
		(async () => {
			const isLocal = !('GIT_HASH' in platform.env);
			sharedMap.set('isLocal', isLocal);
		})(),
	]);
};

export const useLocale = routeLoader$(({ locale }) => locale());
