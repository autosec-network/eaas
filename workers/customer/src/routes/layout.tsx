import type { RequestHandler } from '@builder.io/qwik-city';

interface Accept {
	type: string;
	params: Record<string, string>;
	q: number;
}

/**
 * @link https://github.com/honojs/hono/blob/main/src/middleware/language/language.ts
 */
export const onRequest: RequestHandler = ({ locale, request }) => {
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
		const [primaryLocale] = parseAcceptLanguage(request.headers.get('Accept-Language')!);
		locale(primaryLocale?.lang);
	}
};
