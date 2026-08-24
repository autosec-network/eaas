import type { Session } from '@auth/qwik';
import { $, Resource, component$, getLocale, useResource$, useSignal } from '@builder.io/qwik';
import { server$ } from '@builder.io/qwik-city';
import { LuChevronLeft, LuChevronRight, LuFileOutput } from '@qwikest/icons/lucide';
import * as tenantSchema from 'db/schemas/tenant/main';
import { and, asc, desc, eq, gt, lt, sql } from 'drizzle-orm/sql';
import type { SqliteRemoteDatabase } from 'drizzle-orm/sqlite-proxy';
import { uuidv7ToDate } from 'helpers';
import { ZodUuidBase64url } from 'helpers/zod/mini';
import { Buffer } from 'node:buffer';
import { Permissions } from 'types';
import { blobToDecimalString } from '~/helpers/blob-bigint';
import { buildCursorPage, cursorFetchLimit, PAGE_SIZE, PAGE_SIZE_OPTIONS, resolveCursorRequest, type CursorPage } from '~/helpers/cursor-pagination';
import { readKeyringPermissions } from '~/helpers/keyring-permissions';
import { useTimezone } from '~/routes/layout';

// eslint-disable-next-line @typescript-eslint/ban-ts-comment
// @ts-ignore this gets generated automatically later in the build process
import * as m from '~/paraglide/messages';

export interface DataKeyRow {
	dk_id_base64url: string;
	/**
	 * Epoch ms, recovered from the datakey's own UUIDv7 rather than stored separately.
	 */
	created: number;
	a_time: number | null;
	/**
	 * Decimal string: the column is a bigint-in-a-blob, and `JSON.stringify` refuses a `BigInt`.
	 */
	generation_count: string;
	/**
	 * 1-based place among the newest keys, or `null` when this key is past that window.
	 */
	generation_position: number | null;
	retrieval_position: number | null;
}

interface DataKeyPage extends CursorPage<DataKeyRow> {
	/**
	 * How many keys the window spans (`generation_versions + 1`), so a chip can read "2 of 3".
	 */
	generation_window: number;
	retrieval_window: number;
}

/**
 * One page of a keyring's datakeys, newest first.
 *
 * Re-checks permissions off the tenant DB rather than trusting anything the caller passes: this is a public RPC endpoint, and the only thing binding it to the page that rendered it is the session.
 */
const loadDataKeys = server$(async function (kr_id_base64url: string, after: string | null, before: string | null, limit: number): Promise<DataKeyPage> {
	const parsedKrId = await ZodUuidBase64url(7).safeParseAsync(kr_id_base64url);
	if (!parsedKrId.success) throw new Error('Unknown keyring');

	const kr_id_hex = Buffer.from(parsedKrId.data, 'base64url').toString('hex');
	const session = this.sharedMap.get('session') as Session;
	const t_db = this.sharedMap.get('t_db') as SqliteRemoteDatabase;

	const permissions = await readKeyringPermissions(t_db, session.user!.u_id.hex, kr_id_hex);
	if (permissions.r_keyring < Permissions.Read || permissions.r_datakey < Permissions.Read) throw new Error('Insufficient permissions');

	const [keyring] = await t_db
		.select({ generation_versions: tenantSchema.keyrings.generation_versions, retreival_versions: tenantSchema.keyrings.retreival_versions })
		.from(tenantSchema.keyrings)
		.where(eq(tenantSchema.keyrings.kr_id, sql`unhex(${kr_id_hex})`))
		.limit(1);
	if (!keyring) throw new Error('Unknown keyring');

	const request = resolveCursorRequest(after, before, limit);
	const cursorHex = request.cursor ? Buffer.from(request.cursor, 'base64url').toString('hex') : null;
	const belongsToKeyring = eq(tenantSchema.datakeys.kr_id, sql`unhex(${kr_id_hex})`);

	const [ranked, fetched] = await Promise.all([
		/**
		 * Only the newest `max(generation_versions, retreival_versions) + 1` keys can be in either window, so ranking them once here gives every row on every page its position - a page-local index would be wrong the moment you paged past the first one.
		 */
		t_db
			.select({ dk_id: tenantSchema.datakeys.dk_id })
			.from(tenantSchema.datakeys)
			.where(belongsToKeyring)
			.orderBy(desc(tenantSchema.datakeys.dk_id))
			.limit(Math.max(keyring.generation_versions, keyring.retreival_versions) + 1),
		t_db
			.select({
				dk_id: tenantSchema.datakeys.dk_id,
				a_time: tenantSchema.datakeys.a_time,
				generation_count: tenantSchema.datakeys.generation_count,
			})
			.from(tenantSchema.datakeys)
			.where(cursorHex ? and(belongsToKeyring, request.direction === 'forward' ? lt(tenantSchema.datakeys.dk_id, sql`unhex(${cursorHex})`) : gt(tenantSchema.datakeys.dk_id, sql`unhex(${cursorHex})`)) : belongsToKeyring)
			// UUIDv7 sorts the same as creation time, and SQLite compares blobs bytewise, so the primary key is its own cursor
			.orderBy(request.direction === 'forward' ? desc(tenantSchema.datakeys.dk_id) : asc(tenantSchema.datakeys.dk_id))
			.limit(cursorFetchLimit(request)),
	]);

	const rankByDataKey = new Map(ranked.map((row, index) => [row.dk_id.toString('base64url'), index]));

	const page = buildCursorPage(
		fetched.map((row) => {
			const dk_id_base64url = row.dk_id.toString('base64url');
			const rank = rankByDataKey.get(dk_id_base64url);

			return {
				dk_id_base64url,
				created: uuidv7ToDate(row.dk_id.toString('hex')).getTime(),
				a_time: row.a_time?.getTime() ?? null,
				generation_count: blobToDecimalString(row.generation_count) ?? '0',
				generation_position: rank !== undefined && rank <= keyring.generation_versions ? rank + 1 : null,
				retrieval_position: rank !== undefined && rank <= keyring.retreival_versions ? rank + 1 : null,
			} satisfies DataKeyRow;
		}),
		request,
		(row) => row.dk_id_base64url,
	);

	return {
		...page,
		generation_window: keyring.generation_versions + 1,
		retrieval_window: keyring.retreival_versions + 1,
	};
});

interface Props {
	kr_id_base64url: string;
	/**
	 * `keyrings.plaintext_export`. Without it there's nothing to offer an export of, whatever the viewer's permissions say.
	 */
	plaintextExport: boolean;
	/**
	 * Whether this viewer's effective `r_datakey` reaches {@link Permissions.Write} ("can import/export datakeys").
	 */
	canExport: boolean;
}

const chipClass = 'inline-flex items-center rounded-full px-2 py-0.5 text-2xs font-medium';
const pagerButtonClass = 'inline-flex items-center gap-1 rounded-lg border border-gray-300 px-2 py-1 text-xs font-medium text-gray-700 transition-colors hover:bg-gray-100 disabled:cursor-not-allowed disabled:opacity-40 dark:border-gray-600 dark:text-gray-200 dark:hover:bg-gray-800';

export default component$<Props>(({ kr_id_base64url, plaintextExport, canExport }) => {
	const locale = getLocale();
	const timezone = useTimezone();
	const after = useSignal<string | null>(null);
	const before = useSignal<string | null>(null);
	const limit = useSignal<number>(PAGE_SIZE.default);
	const openExportFor = useSignal<string | null>(null);

	const dataKeys = useResource$<DataKeyPage>(({ track }) => {
		const trackedAfter = track(() => after.value);
		const trackedBefore = track(() => before.value);
		const trackedLimit = track(() => limit.value);

		return loadDataKeys(kr_id_base64url, trackedAfter, trackedBefore, trackedLimit);
	});

	const goForward = $((endCursor: string | null) => {
		after.value = endCursor;
		before.value = null;
	});

	const goBackward = $((startCursor: string | null) => {
		after.value = null;
		before.value = startCursor;
	});

	const showExport = plaintextExport && canExport;

	return (
		<div class="rounded-xl border border-gray-200 dark:border-gray-700">
			<div class="flex flex-wrap items-center justify-between gap-2 border-b border-gray-200 px-3 py-2 dark:border-gray-700">
				<h4 class="text-sm font-semibold text-gray-900 dark:text-white">{m.keyrings_datakeys_title()}</h4>
				<label class="flex items-center gap-1.5 text-xs text-gray-500 dark:text-gray-400">
					{m.keyrings_page_size_label()}
					<select
						class="rounded-lg border border-gray-300 bg-white px-1.5 py-1 text-xs text-gray-900 dark:border-gray-600 dark:bg-gray-900 dark:text-white"
						value={String(limit.value)}
						onChange$={(_, element) => {
							limit.value = parseInt(element.value, 10);
							// A resized page invalidates both cursors - the row they pointed at may not be a page boundary any more
							after.value = null;
							before.value = null;
						}}>
						{PAGE_SIZE_OPTIONS.map((size) => (
							<option key={size} value={String(size)}>
								{String(size)}
							</option>
						))}
					</select>
				</label>
			</div>

			<Resource
				value={dataKeys}
				onPending={() => (
					<div class="space-y-2 p-3">
						<div class="h-9 animate-pulse rounded-lg bg-gray-200 dark:bg-gray-700" />
						<div class="h-9 animate-pulse rounded-lg bg-gray-200 dark:bg-gray-700" />
					</div>
				)}
				onRejected={(error) => (
					<p class="p-3 text-xs text-red-600">
						{m.common_error_label()} {error instanceof Error ? error.message : String(error)}
					</p>
				)}
				onResolved={(page) => (
					<>
						{page.rows.length < 1 ? (
							<p class="p-3 text-xs text-gray-500 dark:text-gray-400">{m.keyrings_datakeys_empty()}</p>
						) : (
							<ul class="divide-y divide-gray-200 dark:divide-gray-700">
								{page.rows.map((row) => {
									const created = new Date(row.created);

									return (
										<li key={row.dk_id_base64url} class="flex flex-wrap items-center gap-3 px-3 py-2">
											<div class="min-w-0 flex-1">
												<code class="block truncate font-mono text-xs text-gray-900 dark:text-white">{row.dk_id_base64url}</code>
												<time class="text-2xs text-gray-500 dark:text-gray-400" dateTime={created.toISOString()} title={`${created.toLocaleString(locale, { hour12: false, timeZone: 'UTC' })} UTC`}>
													{`${created.toLocaleString(locale, { timeZone: timezone.value.long })} ${timezone.value.short}`}
												</time>
											</div>

											<span class="text-2xs text-gray-600 dark:text-gray-300">{m.keyrings_datakey_generations({ count: row.generation_count })}</span>

											<span class="flex flex-wrap items-center gap-1">
												{row.generation_position !== null ? <span class={[chipClass, 'bg-emerald-100 text-emerald-800 dark:bg-emerald-900/40 dark:text-emerald-300']}>{m.keyrings_datakey_chip_generation({ position: row.generation_position, total: page.generation_window })}</span> : null}
												{row.retrieval_position !== null ? <span class={[chipClass, 'bg-blue-100 text-blue-800 dark:bg-blue-900/40 dark:text-blue-300']}>{m.keyrings_datakey_chip_retrieval({ position: row.retrieval_position, total: page.retrieval_window })}</span> : null}
											</span>

											{showExport ? (
												<span class="relative">
													<button
														type="button"
														class="rounded-lg border border-gray-300 p-1.5 text-gray-600 transition-colors hover:bg-gray-100 dark:border-gray-600 dark:text-gray-300 dark:hover:bg-gray-800"
														title={m.keyrings_datakey_export_label()}
														aria-label={m.keyrings_datakey_export_label()}
														aria-expanded={openExportFor.value === row.dk_id_base64url}
														onClick$={() => {
															openExportFor.value = openExportFor.value === row.dk_id_base64url ? null : row.dk_id_base64url;
														}}>
														<LuFileOutput class="h-3.5 w-3.5" aria-hidden="true" />
													</button>

													{openExportFor.value === row.dk_id_base64url ? (
														<span class="absolute right-0 z-10 mt-1 flex w-44 flex-col rounded-lg border border-gray-200 bg-white p-1 shadow-lg dark:border-gray-600 dark:bg-gray-800">
															{(['jwk', 'pem', 'raw'] as const).map((format) => (
																// Deliberately inert: the export pipeline doesn't exist yet, and a button that silently does nothing is worse than one that says so
																<button key={format} type="button" disabled class="cursor-not-allowed rounded px-2 py-1 text-left text-xs text-gray-400 dark:text-gray-500">
																	{format.toUpperCase()}
																</button>
															))}
															<span class="text-2xs px-2 py-1 text-gray-400 dark:text-gray-500">{m.keyrings_export_coming_soon()}</span>
														</span>
													) : null}
												</span>
											) : null}
										</li>
									);
								})}
							</ul>
						)}

						<div class="flex items-center justify-end gap-2 border-t border-gray-200 px-3 py-2 dark:border-gray-700">
							<button type="button" class={pagerButtonClass} disabled={!page.hasPrev} onClick$={() => goBackward(page.startCursor)}>
								<LuChevronLeft class="h-3 w-3" aria-hidden="true" />
								{m.common_previous()}
							</button>
							<button type="button" class={pagerButtonClass} disabled={!page.hasNext} onClick$={() => goForward(page.endCursor)}>
								{m.common_next()}
								<LuChevronRight class="h-3 w-3" aria-hidden="true" />
							</button>
						</div>
					</>
				)}
			/>
		</div>
	);
});
