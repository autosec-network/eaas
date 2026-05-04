import { component$, Slot, useContextProvider, useStore } from '@builder.io/qwik';
import { routeLoader$, type RequestHandler } from '@builder.io/qwik-city';
import { AppBreadcrumbNav } from '~/components/app-breadcrumb-nav/app-breadcrumb-nav';
import { DurableObjectInstancesContent, DurableObjectInstancesContext } from '~/contexts';

interface Accept {
	type: string;
	params: Record<string, string>;
	q: number;
}

/**
 * @link https://github.com/honojs/hono/blob/main/src/middleware/language/language.ts
 */
export const onRequest: RequestHandler = async ({ platform, request, locale, sharedMap }) => {
	// Local
	const isLocal = !('GIT_HASH' in platform.env);
	sharedMap.set('isLocal', isLocal);

	const headers = (platform.request ?? request).headers;

	// Browser cache
	const cacheControl = new Set((headers.get('Cache-Control')?.split(',') ?? []).map((directive) => directive.trim().toLowerCase()));
	// RFC 7234: no-store forbids storing; no-cache/zero max-age require revalidation so we skip reads
	const toCache = cacheControl.has('no-store') || cacheControl.has('no-cache') || cacheControl.has('max-age=0') || cacheControl.has('s-maxage=0');
	sharedMap.set('browserCache', !toCache);

	// Locale
	(() => {
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
			const [primaryLocale] = parseAcceptLanguage(headers.get('Accept-Language')!);
			locale(primaryLocale?.lang);
		}
	})();
};

export const useTimezone = routeLoader$(({ platform, locale }) => {
	const long = ((platform.request ?? platform).cf as IncomingRequestCfProperties).timezone;

	return {
		long,
		short: new Intl.DateTimeFormat(locale(), { timeZoneName: 'short', timeZone: long }).formatToParts(new Date()).find((p) => p.type === 'timeZoneName')?.value,
	} as const;
});

export const useCfAccountId = routeLoader$(({ platform }) => platform.env.CF_ACCOUNT_ID);

export default component$(() => {
	useContextProvider(DurableObjectInstancesContext, useStore(DurableObjectInstancesContent, { deep: true }));

	return (
		<>
			<AppBreadcrumbNav />
			<main>
				<Slot />
			</main>
		</>
	);
});
