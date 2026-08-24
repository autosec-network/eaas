import * as zm from 'zod/mini';

/**
 * Page size bounds every cursor-paginated table on the dashboard shares.
 */
export const PAGE_SIZE = {
	min: 10,
	default: 10,
	max: 1000,
} as const;

/**
 * Which way a page was asked for. `forward` walks towards older rows (the default first page is a `forward` with no cursor), `backward` walks back towards newer ones.
 */
export type CursorDirection = 'forward' | 'backward';

/**
 * A resolved paging request - what the caller asked for, already clamped.
 */
export interface CursorRequest {
	/**
	 * The row this page starts after (`forward`) or before (`backward`), as the id's base64url. `null` only on a first page.
	 */
	cursor: string | null;
	direction: CursorDirection;
	limit: number;
}

export interface CursorPage<T> {
	rows: T[];
	/**
	 * Cursor for the `backward` request that walks off the top of this page.
	 */
	startCursor: string | null;
	/**
	 * Cursor for the `forward` request that walks off the bottom of this page.
	 */
	endCursor: string | null;
	hasPrev: boolean;
	hasNext: boolean;
	limit: number;
}

const CursorSchema = zm.nullish(zm.base64url().check(zm.trim(), zm.length(22)));
const LimitSchema = zm.catch(zm.coerce.number().check(zm.int(), zm.gte(PAGE_SIZE.min), zm.lte(PAGE_SIZE.max)), PAGE_SIZE.default);

/**
 * Turn a raw `after`/`before`/`limit` triple into a clamped {@link CursorRequest}.
 *
 * `before` wins when both cursors are present - a caller that sends both is asking for two different pages, and the one it navigated *to* is the backward one.
 * A cursor that isn't a 22-character base64url uuid is dropped rather than rejected: cursors only ever come from a link this page rendered, so a malformed one is a stale/hand-edited URL, and falling back to the first page beats a 500.
 */
export function resolveCursorRequest(after: string | null | undefined, before: string | null | undefined, limit: string | number | null | undefined): CursorRequest {
	const parsedBefore = CursorSchema.safeParse(before);
	const parsedAfter = CursorSchema.safeParse(after);
	const backward = parsedBefore.success && parsedBefore.data;

	return {
		cursor: backward ? parsedBefore.data! : ((parsedAfter.success ? parsedAfter.data : null) ?? null),
		direction: backward ? 'backward' : 'forward',
		limit: LimitSchema.parse(limit ?? PAGE_SIZE.default),
	};
}

/**
 * {@link resolveCursorRequest} against a URL's query string. `prefix` namespaces the params so two tables can paginate independently on one page (`kr_after`, `dk_after`, ...).
 */
export function resolveCursorRequestFromUrl(searchParams: URLSearchParams, prefix = ''): CursorRequest {
	return resolveCursorRequest(searchParams.get(`${prefix}after`), searchParams.get(`${prefix}before`), searchParams.get(`${prefix}limit`));
}

/**
 * How many rows to actually `LIMIT` by: one more than asked for, so the extra row's presence answers "is there another page?" without a second `COUNT` query.
 */
export function cursorFetchLimit(request: CursorRequest): number {
	return request.limit + 1;
}

/**
 * Fold a `limit + 1` result set into the page the UI renders.
 *
 * Callers must have queried **descending** for a `forward` request and **ascending** for a `backward` one, both starting from `request.cursor`; this flips a backward result back into the newest-first order every page displays in.
 */
export function buildCursorPage<T>(fetched: T[], request: CursorRequest, toCursor: (row: T) => string): CursorPage<T> {
	const overflowed = fetched.length > request.limit;
	const window = overflowed ? fetched.slice(0, request.limit) : fetched;
	const rows = request.direction === 'backward' ? window.toReversed() : window;

	return {
		rows,
		startCursor: rows.at(0) ? toCursor(rows[0]!) : null,
		endCursor: rows.at(-1) ? toCursor(rows.at(-1)!) : null,
		// Walking backward, the overflow row is the proof there's still something above this page. Walking forward, having been given a cursor at all means we came from somewhere.
		hasPrev: request.direction === 'backward' ? overflowed : request.cursor !== null,
		// The mirror image: a backward page can only exist because a forward page came before it.
		hasNext: request.direction === 'forward' ? overflowed : true,
		limit: request.limit,
	};
}

/**
 * The query string that navigates to a neighbouring page, preserving every unrelated param already on the URL.
 */
export function cursorPageHref(url: URL | string, prefix: string, page: Pick<CursorPage<unknown>, 'startCursor' | 'endCursor' | 'limit'>, direction: CursorDirection): string {
	const cursor = direction === 'forward' ? page.endCursor : page.startCursor;

	return rewriteCursorParams(url, prefix, {
		[direction === 'forward' ? 'after' : 'before']: cursor,
		limit: page.limit,
	});
}

/**
 * The query string that resizes the page.
 *
 * Both cursors are dropped rather than carried over: the row they named was a boundary of the old page size and almost certainly isn't one of the new size, so keeping them would silently skip or repeat rows.
 */
export function cursorPageSizeHref(url: URL | string, prefix: string, limit: number): string {
	return rewriteCursorParams(url, prefix, { limit });
}

/**
 * Rebuild a URL's query string with this table's paging params replaced and every unrelated one carried over.
 *
 * Written as a filter-and-rebuild rather than `searchParams.delete()` because `eslint-plugin-drizzle` reads any bare `.delete()` as an unguarded table delete.
 */
function rewriteCursorParams(url: URL | string, prefix: string, next: { after?: string | null; before?: string | null; limit: number }): string {
	const source = new URL(typeof url === 'string' ? url : url.href);
	const owned = new Set([`${prefix}after`, `${prefix}before`, `${prefix}limit`]);
	const params = new URLSearchParams(Array.from(source.searchParams.entries()).filter(([key]) => !owned.has(key)));

	if (next.after) params.set(`${prefix}after`, next.after);
	if (next.before) params.set(`${prefix}before`, next.before);
	// The default size is the absence of the param, so paging at 10 leaves no trace on the URL
	if (next.limit !== PAGE_SIZE.default) params.set(`${prefix}limit`, String(next.limit));

	const query = params.toString();
	return query ? `${source.pathname}?${query}` : source.pathname;
}

/**
 * The sizes offered in a page-size picker, clamped to {@link PAGE_SIZE}.
 */
export const PAGE_SIZE_OPTIONS = [10, 25, 50, 100, 250, 500, 1000].filter((size) => size >= PAGE_SIZE.min && size <= PAGE_SIZE.max);
