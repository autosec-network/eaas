import type { Session } from '@auth/qwik';
import { component$, getLocale, Resource, useComputed$, useSignal, useStore, useVisibleTask$, type QRL } from '@builder.io/qwik';
import { Form, Link, routeAction$, routeLoader$, useLocation, useNavigate, z, zod$ } from '@builder.io/qwik-city';
import { LuChevronDown, LuChevronLeft, LuChevronRight, LuRefreshCw, LuTrash2 } from '@qwikest/icons/lucide';
import cron from 'cron-validate';
import * as tenantSchema from 'db/schemas/tenant/main';
import type { DrizzleD1Database } from 'drizzle-orm/d1';
import { and, asc, desc, eq, gt, lt, or, sql } from 'drizzle-orm/sql';
import type { SqliteRemoteDatabase } from 'drizzle-orm/sqlite-proxy';
import { hexToUuid, workflowInstanceId } from 'helpers';
import { Buffer } from 'node:buffer';
import type { UUID } from 'node:crypto';
import { Permissions } from 'types';
import { KeyAlgorithms } from 'types/crypto';
import { workersCryptoCatalog } from 'types/crypto/catalog';
import { TenantLogEventType } from 'types/tenants/logging';
import { v7 as uuidv7 } from 'uuid';
import DataKeyTable from '~/components/team/datakey-table/datakey-table';
import KeyringChips from '~/components/team/keyring-chips/keyring-chips';
import { bigIntToHex, blobToDecimalString } from '~/helpers/blob-bigint';
import { buildCursorPage, cursorFetchLimit, cursorPageHref, cursorPageSizeHref, PAGE_SIZE, PAGE_SIZE_OPTIONS, resolveCursorRequestFromUrl, type CursorPage } from '~/helpers/cursor-pagination';
import { DEFAULT_KEYRING_HASH, describeKey, KEY_ALGORITHM_ENTRIES, KEY_ALGORITHM_VALUES, keyAlgorithmLabel, keySizeRule, normalizeKeySize } from '~/helpers/keyring-algorithms';
import { mergeKeyringPermissions, readKeyringPermissions, readTenantPermissions, toPermission } from '~/helpers/keyring-permissions';
import { logTenantEvent } from '~/helpers/tenant-log';
import { usePermissions } from '~/routes/(team)/[tenantId]/layout';
import { useTimezone } from '~/routes/layout';
import type { EnvVars } from '~/types';

// eslint-disable-next-line @typescript-eslint/ban-ts-comment
// @ts-ignore this gets generated automatically later in the build process
import * as m from '~/paraglide/messages';

/**
 * Namespaces this table's paging params so the datakey tables nested inside it never collide with it.
 */
const KEYRING_CURSOR_PREFIX = 'kr_';

/**
 * Matches `keyrings.time_rotation`'s doc comment ("DO is created with cron of 1 year") and `timeEditable.cron`'s own default in `workers/api/src/v0/keyrings/shared.ts`.
 */
const DEFAULT_CRON_EXPRESSION = '0 0 1 1 *';

/**
 * Upper bound on `generation_versions`/`retreival_versions`.
 *
 * The column itself is an unbounded integer, but every one of these versions is a live key the datakey table has to rank on load, so the form refuses to write a number that would turn that into a table scan.
 */
const MAX_VERSIONS = 1000;

interface KeyringListRow {
	kr_id_base64url: string;
	name: string;
	plaintext_export: boolean;
	key_type: string;
	key_size: number | null;
	hash: string;
	time_rotation: boolean;
	/**
	 * The keyring's own `TenantD0.schedule()` row (`cron`-typed, keyed on the keyring's id) - present regardless of whether `time_rotation` is currently on, so re-enabling it shows the last schedule instead of resetting to the default.
	 */
	time_rotation_cron: string[];
	/**
	 * Decimal string, or `null` when count-based rotation is off. A `BigInt` can't cross to the browser - `JSON.stringify` throws on one.
	 */
	count_rotation: string | null;
	generation_versions: number;
	retreival_versions: number;
	/**
	 * Epoch ms. `b_time` created, `c_time` settings last changed, `m_time` last rotated.
	 */
	b_time: number;
	c_time: number;
	m_time: number;
	can_edit: boolean;
	can_rotate: boolean;
	can_prune: boolean;
	can_export: boolean;
}

/**
 * Built fresh per call rather than shared as a module constant - a loader's return value belongs to one request, and handing every request the same `rows` array is a cross-request alias waiting to happen.
 */
const emptyPage = (limit: number = PAGE_SIZE.default): CursorPage<KeyringListRow> => ({ rows: [], startCursor: null, endCursor: null, hasPrev: false, hasNext: false, limit });

// eslint-disable-next-line qwik/loader-location
const useKeyrings = routeLoader$(async ({ url, sharedMap, resolveValue }) => {
	const request = resolveCursorRequestFromUrl(url.searchParams, KEYRING_CURSOR_PREFIX);
	const t_db = sharedMap.get('t_db') as SqliteRemoteDatabase;
	const permissions = await resolveValue(usePermissions);

	if (!permissions) return () => Promise.resolve(emptyPage(request.limit));

	const base = { r_keyring: permissions.r_keyring, r_datakey: permissions.r_datakey };
	const overrides = permissions.overrides;
	const seesEveryKeyring = base.r_keyring >= Permissions.Read;
	// The keyrings a `users_keyrings` row hands over one at a time - the only ones visible to someone whose tenant-wide `r_keyring` is `None`
	const grantedKeyringHexes = Object.entries(overrides)
		.filter(([, override]) => toPermission(override['r_keyring']) >= Permissions.Read)
		.map(([kr_id_base64]) => Buffer.from(kr_id_base64, 'base64').toString('hex'));

	return async () => {
		if (!seesEveryKeyring && grantedKeyringHexes.length === 0) return emptyPage(request.limit);

		const visibility = seesEveryKeyring ? undefined : or(...grantedKeyringHexes.map((hex) => eq(tenantSchema.keyrings.kr_id, sql`unhex(${hex})`)));
		const cursorHex = request.cursor ? Buffer.from(request.cursor, 'base64url').toString('hex') : null;
		const paging = cursorHex ? (request.direction === 'forward' ? lt(tenantSchema.keyrings.kr_id, sql`unhex(${cursorHex})`) : gt(tenantSchema.keyrings.kr_id, sql`unhex(${cursorHex})`)) : undefined;

		const fetched = await t_db
			.select()
			.from(tenantSchema.keyrings)
			.where(visibility && paging ? and(visibility, paging) : (visibility ?? paging))
			// UUIDv7 sorts the same as creation time, and SQLite compares blobs bytewise, so the primary key is its own cursor
			.orderBy(request.direction === 'forward' ? desc(tenantSchema.keyrings.kr_id) : asc(tenantSchema.keyrings.kr_id))
			.limit(cursorFetchLimit(request));

		// One RPC for the whole page rather than one per row - `schedule()` keys every keyring's alarm on the keyring's own id, so a single lookup by type covers all of them
		const t_do = sharedMap.get('t_do') as ReturnType<EnvVars['TENANT_D0']['get']>;
		const cronByScheduleId = new Map<string, string[]>();
		if (fetched.length > 0) {
			const scheduleRows = await t_do.getSchedules({ type: 'cron' });
			for (const row of scheduleRows) cronByScheduleId.set(row.id, row.cron ?? [DEFAULT_CRON_EXPRESSION]);
		}

		return buildCursorPage(
			fetched.map((row) => {
				const effective = mergeKeyringPermissions(base, overrides[row.kr_id.toString('base64')]);

				return {
					kr_id_base64url: row.kr_id.toString('base64url'),
					name: row.name,
					plaintext_export: row.plaintext_export,
					key_type: row.key_type,
					key_size: row.key_size,
					hash: row.hash,
					time_rotation: row.time_rotation,
					time_rotation_cron: cronByScheduleId.get(hexToUuid(row.kr_id.toString('hex'))) ?? [DEFAULT_CRON_EXPRESSION],
					count_rotation: blobToDecimalString(row.count_rotation),
					generation_versions: row.generation_versions,
					retreival_versions: row.retreival_versions,
					b_time: row.b_time.getTime(),
					c_time: row.c_time.getTime(),
					m_time: row.m_time.getTime(),
					can_edit: effective.r_keyring >= Permissions.Write,
					// `api_keys_keyrings.r_datakeys` documents these same levels as "2. Can rotate / 3. Can prune datakeys"
					can_rotate: effective.r_datakey >= Permissions.Write,
					can_prune: effective.r_datakey >= Permissions.Admin,
					can_export: effective.r_datakey >= Permissions.Write,
				} satisfies KeyringListRow;
			}),
			request,
			(row) => row.kr_id_base64url,
		);
	};
});

const keyringIdSchema = z.string().trim().length(22).base64url();
const versionsSchema = z.coerce.number().int().min(0).max(MAX_VERSIONS);
/**
 * Left as a string all the way to the handler: these are bigints, and `z.coerce.number()` would quietly round anything past 2^53.
 */
const countRotationSchema = z.string().trim().optional();

/**
 * One cron expression, validated the same way as `timeEditable.cron` in `workers/api/src/v0/keyrings/shared.ts` - same package, same `npm-cron-schedule` preset, so a schedule this form accepts is one `TenantD0.schedule()`'s own `parseCronExpression` (from `cron-schedule`) can actually parse.
 */
const cronExpressionSchema = z
	.string()
	.trim()
	.nonempty()
	.refine((value) => cron(value, { preset: 'npm-cron-schedule' }).isValid(), 'Invalid cron expression');

/**
 * Parses and validates the JSON array of cron strings the create/edit forms submit as one hidden field (mirroring `keyring_policies` in `../api-keys/index.tsx`). Throws on anything malformed - callers only need to call this when `time_rotation` is actually enabled.
 */
function parseCronList(rawJson: string): string[] {
	return z
		.array(cronExpressionSchema)
		.min(1)
		.parse(JSON.parse(rawJson) as unknown);
}

const keyringSettingsSchema = {
	name: z.string().trim().min(2).max(120),
	time_rotation: z.coerce.boolean().optional().default(false),
	/**
	 * Only parsed via {@link parseCronList} when `time_rotation` is enabled - left as an opaque string here so a malformed value from a disabled/hidden editor can't fail validation for a setting that isn't even active.
	 */
	time_rotation_cron: z
		.string()
		.trim()
		.default(JSON.stringify([DEFAULT_CRON_EXPRESSION])),
	count_rotation_enabled: z.coerce.boolean().optional().default(false),
	count_rotation: countRotationSchema,
	generation_versions: versionsSchema,
	retreival_versions: versionsSchema,
	/**
	 * One-way, not write-once: submitting `true` always takes effect, but a submitted `false` is ignored wherever this is written - see `useUpdateKeyring`.
	 */
	plaintext_export: z.coerce.boolean().optional().default(false),
};

/**
 * `null` when count-based rotation is off, `undefined` when the caller asked for it but gave something that isn't a positive integer.
 */
function parseCountRotation(enabled: boolean, raw: string | undefined): bigint | null | undefined {
	if (!enabled) return null;
	if (!raw || !/^\d+$/.test(raw)) return undefined;

	const parsed = BigInt(raw);
	return parsed > BigInt(0) ? parsed : undefined;
}

/**
 * The tenant DB enforces `case_insensitive_keyring_name`; this is how that surfaces on the way back out.
 */
function isDuplicateName(error: unknown): boolean {
	return error instanceof Error && /unique constraint failed/i.test(error.message);
}

/**
 * Hand a keyring to the `DataKeyRotation` workflow in the `api` worker, which is what actually mints a datakey.
 *
 * Resolves to whether it started. A failure here is worth reporting but never worth unwinding the caller: a keyring with no datakey yet is exactly the state the rotate button already exists to fix.
 */
function startRotation(platform: QwikCityPlatform, t_id_hex: string, kr_id_hex: string, u_id_hex: string): Promise<boolean> {
	return platform.env.DATA_KEY_ROTATION.create({
		id: workflowInstanceId(t_id_hex, uuidv7() as UUID),
		params: { t_id: t_id_hex, kr_id: kr_id_hex, u_id: u_id_hex, ak_id: null },
	})
		.then(() => true)
		.catch((error: unknown) => {
			console.error('Failed to start data key rotation', error);
			return false;
		});
}

/**
 * Replaces whatever cron schedule this keyring has with `cronList`, or removes it entirely when `timeRotationEnabled` is false - `TenantD0.rotateKeyringOnSchedule` is the callee it fires, matching `startRotation`'s own params shape (system-triggered: no `u_id`/`ak_id`).
 *
 * Keyed on the keyring's own id (not a fresh one) precisely so saving again *replaces* the schedule instead of piling up a second alarm row - `schedule()` inserts, it doesn't upsert, hence the unconditional `cancelSchedule` first.
 */
function syncRotationSchedule(t_do: ReturnType<EnvVars['TENANT_D0']['get']>, t_id_hex: string, kr_id_hex: string, timeRotationEnabled: boolean, cronList: string[] | null): Promise<void> {
	const scheduleId = hexToUuid(kr_id_hex);

	return t_do.cancelSchedule(scheduleId).then(() => {
		if (timeRotationEnabled && cronList) {
			return t_do.schedule(cronList, 'rotateKeyringOnSchedule', [t_id_hex, kr_id_hex], scheduleId).then(() => undefined);
		}

		return undefined;
	});
}

// eslint-disable-next-line qwik/loader-location
const useCreateKeyring = routeAction$(
	async (data, { sharedMap, platform, request, fail }) => {
		const session = sharedMap.get('session') as Session;
		const t_db = sharedMap.get('t_db') as SqliteRemoteDatabase;
		const r_db = sharedMap.get('r_db') as DrizzleD1Database;
		const t_id_hex = sharedMap.get('t_id_hex') as string;
		const u_id_hex = session.user!.u_id.hex;

		const permissions = await readTenantPermissions(t_db, u_id_hex);
		if (permissions.r_keyring < Permissions.Write) return fail(403, { message: 'Insufficient permissions' });

		const count_rotation = parseCountRotation(data.count_rotation_enabled, data.count_rotation);
		if (count_rotation === undefined) return fail(400, { message: 'Rotation count must be a whole number above zero' });

		let cronList: string[] | null = null;
		if (data.time_rotation) {
			try {
				cronList = parseCronList(data.time_rotation_cron);
			} catch {
				return fail(400, { message: 'Rotation schedule must be at least one valid cron expression' });
			}
		}

		const now = new Date();
		const kr_id_hex = (uuidv7() as UUID).replaceAll('-', '');
		// Whatever the form sent is clamped onto what this algorithm actually accepts, so a stale form can't persist a size `dataKeyRotation` would ignore
		const key_size = normalizeKeySize(data.key_type, data.key_size ? parseInt(data.key_size, 10) : null);

		const inserted = await t_db
			.insert(tenantSchema.keyrings)
			.values({
				kr_id: sql`unhex(${kr_id_hex})`,
				name: data.name,
				plaintext_export: data.plaintext_export,
				key_type: data.key_type,
				key_size,
				hash: data.hash,
				time_rotation: data.time_rotation,
				count_rotation: count_rotation === null ? null : sql`unhex(${bigIntToHex(count_rotation)})`,
				generation_versions: data.generation_versions,
				retreival_versions: data.retreival_versions,
				b_time: now,
				c_time: now,
				m_time: now,
			})
			.then(() => true)
			.catch((error: unknown) => {
				if (isDuplicateName(error)) return false;
				throw error;
			});

		if (!inserted) return fail(409, { message: 'A keyring with that name already exists' });

		const t_do = sharedMap.get('t_do') as ReturnType<EnvVars['TENANT_D0']['get']>;
		await syncRotationSchedule(t_do, t_id_hex, kr_id_hex, data.time_rotation, cronList);

		// A keyring with no datakey can't serve a single operation, so creating one always kicks off its first rotation
		const rotation_started = await startRotation(platform, t_id_hex, kr_id_hex, u_id_hex);

		await logTenantEvent(platform, request, r_db, t_id_hex, session, TenantLogEventType['created keyring'], {
			kr_id: kr_id_hex,
			name: data.name,
			key: { algorithm: data.key_type, size: key_size, hash: data.hash },
			plaintext_export: data.plaintext_export,
			time_rotation: data.time_rotation,
			time_rotation_cron: cronList,
			count_rotation: count_rotation?.toString() ?? null,
			generation_versions: data.generation_versions,
			retreival_versions: data.retreival_versions,
			rotation_started,
		});

		return {
			success: true,
			name: data.name,
			rotation_started,
		};
	},
	zod$(
		z.object({
			...keyringSettingsSchema,
			key_type: z.enum(KEY_ALGORITHM_VALUES),
			/**
			 * A string because the field is hidden entirely for algorithms that take no size, and an absent/empty input has to survive the parse.
			 */
			key_size: z.string().trim().optional(),
			hash: z.enum(workersCryptoCatalog.hashes),
		}),
	),
);

// eslint-disable-next-line qwik/loader-location
const useUpdateKeyring = routeAction$(
	async (data, { sharedMap, platform, request, fail }) => {
		const session = sharedMap.get('session') as Session;
		const t_db = sharedMap.get('t_db') as SqliteRemoteDatabase;
		const r_db = sharedMap.get('r_db') as DrizzleD1Database;
		const t_id_hex = sharedMap.get('t_id_hex') as string;
		const kr_id_hex = Buffer.from(data.kr_id_base64url, 'base64url').toString('hex');

		const permissions = await readKeyringPermissions(t_db, session.user!.u_id.hex, kr_id_hex);
		if (permissions.r_keyring < Permissions.Write) return fail(403, { message: 'Insufficient permissions' });

		const count_rotation = parseCountRotation(data.count_rotation_enabled, data.count_rotation);
		if (count_rotation === undefined) return fail(400, { message: 'Rotation count must be a whole number above zero' });

		let cronList: string[] | null = null;
		if (data.time_rotation) {
			try {
				cronList = parseCronList(data.time_rotation_cron);
			} catch {
				return fail(400, { message: 'Rotation schedule must be at least one valid cron expression' });
			}
		}

		/**
		 * `key_type`, `key_size` and `hash` are deliberately absent: they describe key material that already exists in the vault, and changing them here would only mean the next rotation silently generates a key of a different shape than every key before it.
		 */
		const updated = await t_db
			.update(tenantSchema.keyrings)
			.set({
				name: data.name,
				time_rotation: data.time_rotation,
				count_rotation: count_rotation === null ? null : sql`unhex(${bigIntToHex(count_rotation)})`,
				generation_versions: data.generation_versions,
				retreival_versions: data.retreival_versions,
				c_time: new Date(),
				/**
				 * One-way, not write-once: `plaintext_export` can be turned on at any time, but a submitted `false` is dropped entirely rather than written - omitting the key from `.set()` leaves whatever's already there (on or off) untouched, so there's no path back to `false` once it's on.
				 */
				...(data.plaintext_export && { plaintext_export: true }),
			})
			.where(eq(tenantSchema.keyrings.kr_id, sql`unhex(${kr_id_hex})`))
			.then(() => true)
			.catch((error: unknown) => {
				if (isDuplicateName(error)) return false;
				throw error;
			});

		if (!updated) return fail(409, { message: 'A keyring with that name already exists' });

		const t_do = sharedMap.get('t_do') as ReturnType<EnvVars['TENANT_D0']['get']>;
		await syncRotationSchedule(t_do, t_id_hex, kr_id_hex, data.time_rotation, cronList);

		await logTenantEvent(platform, request, r_db, t_id_hex, session, TenantLogEventType['changed keyring'], {
			kr_id: kr_id_hex,
			name: data.name,
			time_rotation: data.time_rotation,
			time_rotation_cron: cronList,
			count_rotation: count_rotation?.toString() ?? null,
			generation_versions: data.generation_versions,
			retreival_versions: data.retreival_versions,
		});

		return { success: true, name: data.name };
	},
	zod$(
		z.object({
			...keyringSettingsSchema,
			kr_id_base64url: keyringIdSchema,
		}),
	),
);

// eslint-disable-next-line qwik/loader-location
const useRotateKeyring = routeAction$(
	async (data, { sharedMap, platform, fail }) => {
		const session = sharedMap.get('session') as Session;
		const t_db = sharedMap.get('t_db') as SqliteRemoteDatabase;
		const t_id_hex = sharedMap.get('t_id_hex') as string;
		const u_id_hex = session.user!.u_id.hex;
		const kr_id_hex = Buffer.from(data.kr_id_base64url, 'base64url').toString('hex');

		const permissions = await readKeyringPermissions(t_db, u_id_hex, kr_id_hex);
		if (permissions.r_datakey < Permissions.Write) return fail(403, { message: 'Insufficient permissions' });

		const [keyring] = await t_db
			.select({ name: tenantSchema.keyrings.name })
			.from(tenantSchema.keyrings)
			.where(eq(tenantSchema.keyrings.kr_id, sql`unhex(${kr_id_hex})`))
			.limit(1);
		if (!keyring) return fail(404, { message: 'Keyring not found' });

		if (!(await startRotation(platform, t_id_hex, kr_id_hex, u_id_hex))) return fail(500, { message: 'Could not start the rotation' });

		return { success: true, name: keyring.name };
	},
	zod$(
		z.object({
			kr_id_base64url: keyringIdSchema,
		}),
	),
);

const fieldClass = 'w-full rounded-lg border border-gray-300 bg-white px-2 py-1.5 text-xs text-gray-900 outline-none dark:border-gray-600 dark:bg-gray-900 dark:text-white';
const buttonClass = 'rounded-lg px-3 py-1.5 text-xs font-medium transition-all duration-150 active:scale-[0.98]';
const outlineButtonClass = [buttonClass, 'border border-gray-300 text-gray-700 hover:bg-gray-100 dark:border-gray-600 dark:text-gray-200 dark:hover:bg-gray-800'];
const pagerButtonClass = 'inline-flex items-center gap-1 rounded-lg border border-gray-300 px-2.5 py-1.5 text-xs font-medium text-gray-700 transition-colors hover:bg-gray-100 dark:border-gray-600 dark:text-gray-200 dark:hover:bg-gray-800';
const detailLabelClass = 'text-2xs font-semibold tracking-wide text-gray-500 uppercase dark:text-gray-400';
const detailValueClass = 'text-xs text-gray-900 dark:text-white';

interface CronScheduleEditorProps {
	value: string[];
	onChange$: QRL<(next: string[]) => void>;
}

/**
 * A plain list of cron-expression text inputs, not a cron builder - `cron-validate` (`npm-cron-schedule` preset, same as `workers/api/src/v0/keyrings/shared.ts`) is what actually tells the submitter whether an entry is valid, server-side.
 *
 * Always replaces the whole array rather than mutating in place - simpler to reason about than tracking per-row identity for a list whose rows have no identity of their own beyond their (freely-editable) text.
 */
const CronScheduleEditor = component$<CronScheduleEditorProps>(({ value, onChange$ }) => (
	<div class="flex flex-col gap-1.5">
		{value.map((expression, index) => (
			<div key={index} class="flex items-center gap-1.5">
				<input class={[fieldClass, 'font-mono']} required value={expression} placeholder={DEFAULT_CRON_EXPRESSION} onInput$={(_, element) => onChange$(value.map((v, i) => (i === index ? element.value : v)))} />
				<button type="button" class="rounded-lg border border-gray-300 px-2 py-1.5 text-xs text-gray-500 hover:bg-gray-100 disabled:cursor-not-allowed disabled:opacity-40 dark:border-gray-600 dark:text-gray-400 dark:hover:bg-gray-800" disabled={value.length <= 1} onClick$={() => onChange$(value.filter((_, i) => i !== index))}>
					{m.keyrings_cron_remove()}
				</button>
			</div>
		))}
		<button type="button" class="self-start rounded-lg border border-gray-300 px-2 py-1 text-xs text-gray-600 hover:bg-gray-100 dark:border-gray-600 dark:text-gray-300 dark:hover:bg-gray-800" onClick$={() => onChange$([...value, DEFAULT_CRON_EXPRESSION])}>
			{m.keyrings_cron_add()}
		</button>
		<p class="text-2xs text-gray-500 dark:text-gray-400">{m.keyrings_cron_hint()}</p>
	</div>
));

export default component$(() => {
	const locale = getLocale();
	const timezone = useTimezone();
	const location = useLocation();
	const navigate = useNavigate();
	const userPermissions = usePermissions();
	const keyrings = useKeyrings();
	const createKeyring = useCreateKeyring();
	const updateKeyring = useUpdateKeyring();
	const rotateKeyring = useRotateKeyring();

	const expanded = useStore<Record<string, boolean>>({});
	const createKeyType = useSignal<KeyAlgorithms>(KeyAlgorithms['AES-GCM']);
	const createCountRotation = useSignal(true);
	const createTimeRotation = useSignal(Boolean(tenantSchema.keyrings.time_rotation.default ?? true));
	const createCronList = useSignal<string[]>([DEFAULT_CRON_EXPRESSION]);
	const editCountRotation = useStore<Record<string, boolean>>({});
	const editTimeRotation = useStore<Record<string, boolean>>({});
	const editCronList = useStore<Record<string, string[]>>({});
	const createKeySizeRule = useComputed$(() => keySizeRule(createKeyType.value));
	/**
	 * Read once into a plain local rather than re-accessed as `createKeySizeRule.value` at each use below - narrowing on `.kind` doesn't survive a second, separately-evaluated property access, least of all across the `.map()` closure that needs `.fallback`.
	 */
	const sizeRule = createKeySizeRule.value;

	const canCreate = useComputed$(() => Boolean(userPermissions.value && userPermissions.value.r_keyring >= Permissions.Write));

	// eslint-disable-next-line qwik/no-use-visible-task
	useVisibleTask$(() => {
		void import('flowbite').then(({ initModals }) => initModals());
	});

	// eslint-disable-next-line qwik/no-use-visible-task
	useVisibleTask$(({ track }) => {
		if (track(() => createKeyring.value)?.success) document.getElementById('hide-create-keyring-modal')?.click();
	});

	const renderTime = (epochMs: number) => {
		const value = new Date(epochMs);

		return (
			<time dateTime={value.toISOString()} title={`${value.toLocaleString(locale, { hour12: false, timeZone: 'UTC' })} UTC`}>
				{`${value.toLocaleString(locale, { timeZone: timezone.value.long })} ${timezone.value.short}`}
			</time>
		);
	};

	return (
		<div class="mx-auto w-full max-w-7xl px-6 py-10">
			<div class="mb-8 flex items-start justify-between gap-4">
				<div>
					<h1 class="text-2xl font-bold tracking-tight text-gray-900 dark:text-white">{m.keyrings_page_title()}</h1>
					<p class="mt-1 text-sm text-gray-500 dark:text-gray-400">{m.keyrings_page_subtitle()}</p>
				</div>
				{canCreate.value ? (
					<button type="button" data-modal-target="create-keyring-modal" data-modal-toggle="create-keyring-modal" class={[buttonClass, 'bg-primary-accent hover:bg-primary-accent/85 text-white']}>
						{m.keyrings_create_btn()}
					</button>
				) : null}
			</div>

			{createKeyring.value?.success ? (
				<div class="mb-6 rounded-xl border border-emerald-300 bg-emerald-50 p-4 text-sm text-emerald-900 dark:border-emerald-800 dark:bg-emerald-950/40 dark:text-emerald-200">
					<p class="font-semibold">{m.keyrings_banner_created({ name: createKeyring.value.name })}</p>
					<p class="mt-1 text-xs">{createKeyring.value.rotation_started ? m.keyrings_banner_first_key_started() : m.keyrings_banner_first_key_failed()}</p>
				</div>
			) : null}

			{rotateKeyring.value?.success ? <div class="mb-6 rounded-xl border border-sky-300 bg-sky-50 p-4 text-sm text-sky-900 dark:border-sky-800 dark:bg-sky-950/40 dark:text-sky-200">{m.keyrings_banner_rotating({ name: rotateKeyring.value.name })}</div> : null}

			{updateKeyring.value?.success ? <div class="mb-6 rounded-xl border border-emerald-300 bg-emerald-50 p-4 text-sm text-emerald-900 dark:border-emerald-800 dark:bg-emerald-950/40 dark:text-emerald-200">{m.keyrings_banner_saved({ name: updateKeyring.value.name })}</div> : null}

			{[createKeyring.value, updateKeyring.value, rotateKeyring.value].map((result, index) =>
				result && 'message' in result && typeof result.message === 'string' ? (
					<div key={index} class="mb-6 rounded-xl border border-red-300 bg-red-50 p-4 text-sm text-red-800 dark:border-red-800 dark:bg-red-950/40 dark:text-red-300">
						{result.message}
					</div>
				) : null,
			)}

			<div class="border-surface-light/60 dark:border-surface-dark/60 dark:bg-surface-dark/70 rounded-2xl border bg-white/70 shadow-sm backdrop-blur-md">
				<Resource
					value={keyrings}
					onPending={() => (
						<div class="space-y-3 p-4">
							<div class="h-14 animate-pulse rounded-xl bg-gray-200 dark:bg-gray-700" />
							<div class="h-14 animate-pulse rounded-xl bg-gray-200 dark:bg-gray-700" />
						</div>
					)}
					onRejected={(error) => (
						<p class="p-4 text-sm text-red-600">
							{m.common_error_label()} {error instanceof Error ? error.message : String(error)}
						</p>
					)}
					onResolved={(page) => (
						<>
							{page.rows.length < 1 ? (
								<div class="p-4 text-sm text-gray-500 dark:text-gray-400">{m.keyrings_empty()}</div>
							) : (
								<ul class="divide-surface-light/60 dark:divide-surface-dark/60 divide-y">
									{page.rows.map((row) => {
										const isOpen = Boolean(expanded[row.kr_id_base64url]);
										const countEnabled = editCountRotation[row.kr_id_base64url] ?? row.count_rotation !== null;
										const timeRotationEnabled = editTimeRotation[row.kr_id_base64url] ?? row.time_rotation;
										const cronListForRow = editCronList[row.kr_id_base64url] ?? row.time_rotation_cron;

										return (
											<li key={row.kr_id_base64url} class="p-4">
												<div class="flex flex-wrap items-center gap-3">
													<button
														type="button"
														class="flex min-w-0 flex-1 items-center gap-2 text-left"
														aria-expanded={isOpen}
														onClick$={() => {
															expanded[row.kr_id_base64url] = !isOpen;
														}}>
														<LuChevronDown class={['h-4 w-4 shrink-0 text-gray-400 transition-transform', isOpen ? 'rotate-180' : '']} aria-hidden="true" />
														<span class="min-w-0">
															<span class="block truncate text-sm font-semibold text-gray-900 dark:text-white">{row.name}</span>
															<span class="text-2xs block text-gray-500 dark:text-gray-400">
																{m.keyrings_label_settings_changed()} {renderTime(row.c_time)}
															</span>
														</span>
													</button>

													<span class="text-xs text-gray-700 dark:text-gray-200">{describeKey(row.key_type, row.key_size)}</span>
													<code class="text-2xs rounded bg-gray-100 px-1.5 py-0.5 font-mono text-gray-600 dark:bg-gray-800 dark:text-gray-300">{row.hash}</code>

													<KeyringChips timeRotation={row.time_rotation} countRotation={row.count_rotation} plaintextExport={row.plaintext_export} />
												</div>

												{isOpen ? (
													<div class="mt-4 space-y-4">
														<div class="flex flex-wrap gap-x-8 gap-y-3 rounded-xl border border-gray-200 p-3 dark:border-gray-700">
															<span>
																<span class={['block', detailLabelClass]}>{m.keyrings_detail_id()}</span>
																<code class={['font-mono', detailValueClass]}>{row.kr_id_base64url}</code>
															</span>
															<span>
																<span class={['block', detailLabelClass]}>{m.keyrings_detail_algorithm()}</span>
																<span class={detailValueClass}>{keyAlgorithmLabel(row.key_type)}</span>
															</span>
															<span>
																<span class={['block', detailLabelClass]}>{m.keyrings_detail_size()}</span>
																<span class={detailValueClass}>{row.key_size ?? m.keyrings_detail_not_applicable()}</span>
															</span>
															<span>
																<span class={['block', detailLabelClass]}>{m.keyrings_detail_hash()}</span>
																<span class={detailValueClass}>{row.hash}</span>
															</span>
															<span>
																<span class={['block', detailLabelClass]}>{m.keyrings_detail_exportable()}</span>
																<span class={detailValueClass}>{row.plaintext_export ? m.keyrings_value_yes() : m.keyrings_value_no()}</span>
															</span>
															<span>
																<span class={['block', detailLabelClass]}>{m.keyrings_detail_created()}</span>
																<span class={detailValueClass}>{renderTime(row.b_time)}</span>
															</span>
															<span>
																<span class={['block', detailLabelClass]}>{m.keyrings_detail_rotated()}</span>
																<span class={detailValueClass}>{renderTime(row.m_time)}</span>
															</span>
														</div>

														<p class="text-2xs text-gray-500 dark:text-gray-400">{m.keyrings_structural_locked_hint()}</p>

														{row.can_edit ? (
															<Form action={updateKeyring} class="flex flex-wrap items-end gap-3 rounded-xl border border-gray-200 p-3 dark:border-gray-700">
																<input type="hidden" name="kr_id_base64url" value={row.kr_id_base64url} />

																<label class="min-w-48 flex-1 text-xs text-gray-600 dark:text-gray-300">
																	{m.keyrings_field_name()}
																	<input name="name" class={fieldClass} required minLength={2} maxLength={120} value={row.name} />
																</label>

																<label class="w-28 text-xs text-gray-600 dark:text-gray-300">
																	{m.keyrings_field_generation_versions()}
																	<input name="generation_versions" type="number" class={fieldClass} required min={0} max={MAX_VERSIONS} step={1} value={row.generation_versions} />
																</label>

																<label class="w-28 text-xs text-gray-600 dark:text-gray-300">
																	{m.keyrings_field_retrieval_versions()}
																	<input name="retreival_versions" type="number" class={fieldClass} required min={0} max={MAX_VERSIONS} step={1} value={row.retreival_versions} />
																</label>

																<label class="inline-flex items-center gap-2 pb-1.5 text-xs text-gray-600 dark:text-gray-300">
																	<input
																		type="checkbox"
																		name="time_rotation"
																		checked={timeRotationEnabled}
																		onChange$={(_, element) => {
																			editTimeRotation[row.kr_id_base64url] = element.checked;
																		}}
																	/>
																	{m.keyrings_field_time_rotation()}
																</label>

																<label class="inline-flex items-center gap-2 pb-1.5 text-xs text-gray-600 dark:text-gray-300">
																	<input
																		type="checkbox"
																		name="count_rotation_enabled"
																		checked={countEnabled}
																		onChange$={(_, element) => {
																			editCountRotation[row.kr_id_base64url] = element.checked;
																		}}
																	/>
																	{m.keyrings_field_count_rotation()}
																</label>

																{countEnabled ? (
																	<label class="w-44 text-xs text-gray-600 dark:text-gray-300">
																		{m.keyrings_field_count_rotation_threshold()}
																		<input name="count_rotation" class={fieldClass} inputMode="numeric" pattern="[0-9]*" value={row.count_rotation ?? ''} />
																	</label>
																) : null}

																{timeRotationEnabled ? (
																	<label class="w-full text-xs text-gray-600 dark:text-gray-300">
																		{m.keyrings_field_time_rotation_cron()}
																		<div class="mt-1">
																			<CronScheduleEditor value={cronListForRow} onChange$={(next) => (editCronList[row.kr_id_base64url] = next)} />
																		</div>
																	</label>
																) : null}
																<input type="hidden" name="time_rotation_cron" value={JSON.stringify(cronListForRow)} />

																{/* Disabled once already on: a disabled checkbox never lands in the submitted FormData at all, so the server never sees a `false` to (correctly) ignore - the true value just stays whatever it already was */}
																<label class={['inline-flex items-center gap-2 pb-1.5 text-xs', row.plaintext_export ? 'cursor-not-allowed text-gray-400 dark:text-gray-500' : 'text-gray-600 dark:text-gray-300']}>
																	<input type="checkbox" name="plaintext_export" checked={row.plaintext_export} disabled={row.plaintext_export} />
																	{m.keyrings_field_plaintext_export()}
																</label>

																<button type="submit" class={outlineButtonClass}>
																	{m.common_save()}
																</button>
															</Form>
														) : null}

														<div class="flex flex-wrap items-center gap-2">
															{row.can_rotate ? (
																<Form action={rotateKeyring}>
																	<input type="hidden" name="kr_id_base64url" value={row.kr_id_base64url} />
																	<button type="submit" class={[buttonClass, 'inline-flex items-center gap-1.5 border border-sky-300 text-sky-700 hover:bg-sky-100 dark:border-sky-800 dark:text-sky-300 dark:hover:bg-sky-900/40']}>
																		<LuRefreshCw class="h-3.5 w-3.5" aria-hidden="true" />
																		{m.keyrings_rotate_btn()}
																	</button>
																</Form>
															) : null}

															{row.can_prune ? (
																// Inert on purpose: nothing prunes datakeys yet - `wf/dataKeyRotation.ts` still carries the "delete older versions" todo - and a button that quietly does nothing would read as a successful prune
																<button type="button" disabled class={[buttonClass, 'inline-flex cursor-not-allowed items-center gap-1.5 border border-gray-300 text-gray-400 dark:border-gray-600 dark:text-gray-500']} title={m.keyrings_prune_unavailable()}>
																	<LuTrash2 class="h-3.5 w-3.5" aria-hidden="true" />
																	{m.keyrings_prune_btn()}
																</button>
															) : null}

															{row.can_prune ? <span class="text-2xs text-gray-400 dark:text-gray-500">{m.keyrings_prune_unavailable()}</span> : null}
														</div>

														<DataKeyTable kr_id_base64url={row.kr_id_base64url} plaintextExport={row.plaintext_export} canExport={row.can_export} />
													</div>
												) : null}
											</li>
										);
									})}
								</ul>
							)}

							<div class="border-surface-light/60 dark:border-surface-dark/60 flex flex-wrap items-center justify-between gap-2 border-t px-4 py-3">
								<label class="flex items-center gap-1.5 text-xs text-gray-500 dark:text-gray-400">
									{m.keyrings_page_size_label()}
									<select class="rounded-lg border border-gray-300 bg-white px-1.5 py-1 text-xs text-gray-900 dark:border-gray-600 dark:bg-gray-900 dark:text-white" value={String(page.limit)} onChange$={(_, element) => navigate(cursorPageSizeHref(location.url, KEYRING_CURSOR_PREFIX, parseInt(element.value, 10)))}>
										{PAGE_SIZE_OPTIONS.map((size) => (
											<option key={size} value={String(size)}>
												{String(size)}
											</option>
										))}
									</select>
								</label>

								<div class="flex items-center gap-2">
									{page.hasPrev ? (
										<Link prefetch="js" href={cursorPageHref(location.url, KEYRING_CURSOR_PREFIX, page, 'backward')} class={pagerButtonClass}>
											<LuChevronLeft class="h-3 w-3" aria-hidden="true" />
											{m.common_previous()}
										</Link>
									) : (
										<span class={[pagerButtonClass, 'cursor-not-allowed opacity-40']}>
											<LuChevronLeft class="h-3 w-3" aria-hidden="true" />
											{m.common_previous()}
										</span>
									)}

									{page.hasNext ? (
										<Link prefetch="js" href={cursorPageHref(location.url, KEYRING_CURSOR_PREFIX, page, 'forward')} class={pagerButtonClass}>
											{m.common_next()}
											<LuChevronRight class="h-3 w-3" aria-hidden="true" />
										</Link>
									) : (
										<span class={[pagerButtonClass, 'cursor-not-allowed opacity-40']}>
											{m.common_next()}
											<LuChevronRight class="h-3 w-3" aria-hidden="true" />
										</span>
									)}
								</div>
							</div>
						</>
					)}
				/>
			</div>

			<button id="hide-create-keyring-modal" type="button" data-modal-hide="create-keyring-modal" class="hidden" />

			<div id="create-keyring-modal" tabIndex={-1} aria-hidden="true" class="fixed top-0 right-0 left-0 z-50 hidden h-[calc(100%-1rem)] max-h-full w-full items-center justify-center overflow-x-hidden overflow-y-auto md:inset-0">
				<div class="relative max-h-full w-full max-w-3xl p-4">
					<div class="relative rounded-lg bg-white shadow-sm dark:bg-gray-700">
						<div class="rounded-t border-b border-gray-200 p-4 md:p-5 dark:border-gray-600">
							<h3 class="text-lg font-semibold text-gray-900 dark:text-white">{m.keyrings_create_title()}</h3>
							<p class="text-sm text-gray-500 dark:text-gray-400">{m.keyrings_create_subtitle()}</p>
						</div>

						<Form action={createKeyring}>
							<div class="space-y-4 p-4 md:p-5">
								<label class="block text-sm text-gray-600 dark:text-gray-300">
									{m.keyrings_field_name()}
									<input name="name" class={fieldClass} required minLength={2} maxLength={120} />
								</label>

								<div class="flex flex-wrap gap-3">
									<label class="min-w-48 flex-1 text-sm text-gray-600 dark:text-gray-300">
										{m.keyrings_field_algorithm()}
										{/* `onChange$` alone only keeps this select correct once the client JS is already running (an in-app SPA navigation to this page). A genuine cold load paints the plain SSR HTML first, and a `<select>`'s `value` prop has no effect on that raw markup - only `selected` on the matching `<option>` does */}
										<select name="key_type" class={fieldClass} onChange$={(_, element) => (createKeyType.value = element.value as KeyAlgorithms)}>
											{KEY_ALGORITHM_ENTRIES.map(([label, value]) => (
												<option key={value} value={value} selected={value === createKeyType.value}>
													{label}
												</option>
											))}
										</select>
									</label>

									<label class="w-40 text-sm text-gray-600 dark:text-gray-300">
										{m.keyrings_field_size()}
										{sizeRule.kind === 'choice' ? (
											<select key={createKeyType.value} name="key_size" class={fieldClass}>
												{sizeRule.options.map((size) => (
													<option key={size} value={String(size)} selected={size === sizeRule.fallback}>
														{String(size)}
													</option>
												))}
											</select>
										) : sizeRule.kind === 'range' ? (
											<input name="key_size" type="number" class={fieldClass} min={sizeRule.min} max={sizeRule.max} step={sizeRule.step} value={sizeRule.fallback} />
										) : (
											<input class={[fieldClass, 'cursor-not-allowed opacity-50']} disabled value={m.keyrings_detail_not_applicable()} />
										)}
									</label>

									<label class="w-44 text-sm text-gray-600 dark:text-gray-300">
										{m.keyrings_field_hash()}
										<select name="hash" class={fieldClass}>
											{workersCryptoCatalog.hashes.map((hash) => (
												<option key={hash} value={hash} selected={hash === DEFAULT_KEYRING_HASH}>
													{hash}
												</option>
											))}
										</select>
									</label>
								</div>

								<div class="flex flex-wrap items-end gap-3">
									<label class="w-32 text-sm text-gray-600 dark:text-gray-300">
										{m.keyrings_field_generation_versions()}
										<input name="generation_versions" type="number" class={fieldClass} required min={0} max={MAX_VERSIONS} step={1} value={Number(tenantSchema.keyrings.generation_versions.default ?? 0)} />
									</label>

									<label class="w-32 text-sm text-gray-600 dark:text-gray-300">
										{m.keyrings_field_retrieval_versions()}
										<input name="retreival_versions" type="number" class={fieldClass} required min={0} max={MAX_VERSIONS} step={1} value={Number(tenantSchema.keyrings.retreival_versions.default ?? 2)} />
									</label>

									<label class="inline-flex items-center gap-2 pb-1.5 text-sm text-gray-600 dark:text-gray-300">
										<input type="checkbox" name="time_rotation" checked={createTimeRotation.value} onChange$={(_, element) => (createTimeRotation.value = element.checked)} />
										{m.keyrings_field_time_rotation()}
									</label>

									<label class="inline-flex items-center gap-2 pb-1.5 text-sm text-gray-600 dark:text-gray-300">
										<input type="checkbox" name="count_rotation_enabled" checked={createCountRotation.value} onChange$={(_, element) => (createCountRotation.value = element.checked)} />
										{m.keyrings_field_count_rotation()}
									</label>

									{createCountRotation.value ? (
										<label class="w-48 text-sm text-gray-600 dark:text-gray-300">
											{m.keyrings_field_count_rotation_threshold()}
											<input name="count_rotation" class={fieldClass} inputMode="numeric" pattern="[0-9]*" value={(BigInt(2) ** BigInt(32)).toString()} />
										</label>
									) : null}
								</div>

								{createTimeRotation.value ? (
									<label class="block text-sm text-gray-600 dark:text-gray-300">
										{m.keyrings_field_time_rotation_cron()}
										<div class="mt-1">
											<CronScheduleEditor value={createCronList.value} onChange$={(next) => (createCronList.value = next)} />
										</div>
									</label>
								) : null}
								<input type="hidden" name="time_rotation_cron" value={JSON.stringify(createCronList.value)} />

								<label class="inline-flex items-start gap-2 text-sm text-gray-600 dark:text-gray-300">
									<input type="checkbox" name="plaintext_export" class="mt-1" />
									<span>
										{m.keyrings_field_plaintext_export()}
										<span class="mt-0.5 block text-xs text-gray-500 dark:text-gray-400">{m.keyrings_plaintext_export_hint()}</span>
									</span>
								</label>
							</div>

							<div class="flex items-center justify-end space-x-3 rounded-b border-t border-gray-200 p-4 md:p-5 dark:border-gray-600">
								<button type="button" data-modal-hide="create-keyring-modal" class="rounded-lg border border-gray-200 bg-white px-5 py-2.5 text-sm font-medium text-gray-500 hover:bg-gray-100 hover:text-gray-900 focus:z-10 focus:ring-4 focus:ring-gray-100 focus:outline-none dark:border-gray-500 dark:bg-gray-700 dark:text-gray-300 dark:hover:bg-gray-600 dark:hover:text-white dark:focus:ring-gray-600">
									{m.common_discard()}
								</button>
								<button type="submit" class={[buttonClass, 'bg-primary-accent hover:bg-primary-accent/85 text-white']}>
									{m.keyrings_create_submit()}
								</button>
							</div>
						</Form>
					</div>
				</div>
			</div>
		</div>
	);
});
