import type { Session } from '@auth/qwik';
import { Resource, component$, getLocale } from '@builder.io/qwik';
import { Form, routeAction$, routeLoader$ } from '@builder.io/qwik-city';
import { LuLoader } from '@qwikest/icons/lucide';
import { SiBitwarden } from '@qwikest/icons/simpleicons';
import type { TenantByoBwNoteSchema } from 'db';
import { DebugLogWriter, drizzleD0 } from 'db/core';
import * as rootSchema from 'db/schemas/root';
import * as tenantSchema from 'db/schemas/tenant/main';
import type { DrizzleD1Database } from 'drizzle-orm/d1';
import { DefaultLogger } from 'drizzle-orm/logger';
import { and, count, eq, sql } from 'drizzle-orm/sql';
import type { SqliteRemoteDatabase } from 'drizzle-orm/sqlite-proxy';
import { uuidv7ToDate } from 'helpers';
import { ZodUuidBase64url } from 'helpers/zod/mini';
import { Buffer } from 'node:buffer';
import type { UUID } from 'node:crypto';
import { DOJurisdictions, Permissions } from 'types';
import { BitwardenCloudEndpoints, type SecretNote } from 'types/bw';
import { TenantLogEventStatus, TenantLogEventType, TenantLogQueueMessageSchema } from 'types/tenants/logging';
import { v7 as uuidv7 } from 'uuid';
import type * as zm from 'zod/mini';
import { isLocal, resolveDoStub } from '~/helpers/do-proxy';
import { JwkMetadata, type Jwk, type KeyringMetadata } from '~/helpers/jwk-metadata';
import { usePermissions } from '~/routes/(team)/[tenantId]/layout';
import { useTimezone } from '~/routes/layout';
import type { EnvVars } from '~/types';

// eslint-disable-next-line @typescript-eslint/ban-ts-comment
// @ts-ignore this gets generated automatically later in the build process
import * as m from '~/paraglide/messages';

type BitwardenStub = ReturnType<EnvVars['BITWARDEN_SESSION']['get']>;

/**
 * How many `decryptSecret` calls to keep in flight at once. Every one is a round trip to the session Durable Object, so a managed-vault scan (whose secret list spans the whole root organization) would otherwise fan out into thousands of unbounded concurrent calls.
 */
const DECRYPT_CONCURRENCY = 25;

const chunked = <T,>(items: T[], size: number): T[][] =>
	items.reduce<T[][]>((acc, item, index) => {
		if (index % size === 0) acc.push([]);
		acc[acc.length - 1]!.push(item);
		return acc;
	}, []);

/**
 * Decrypt many Bitwarden ciphertexts, {@link DECRYPT_CONCURRENCY} at a time. A ciphertext that can't be decrypted yields `undefined` rather than rejecting the whole scan — in the managed vault the listing covers every tenant's secrets, so "not ours" is an expected outcome, not a failure.
 */
const decryptAll = (stub: BitwardenStub, accessToken: string, cipherTexts: string[]): Promise<(string | undefined)[]> =>
	chunked(cipherTexts, DECRYPT_CONCURRENCY).reduce<Promise<(string | undefined)[]>>(
		async (acc, chunk) => [
			...(await acc),
			...(await Promise.all(
				chunk.map(
					(cipherText) => stub.decryptSecret(accessToken, cipherText).catch(() => undefined),
					// Never log the rejection - `decryptSecret` failures carry the ciphertext, and a partially decrypted payload is still key material
				),
			)),
		],
		Promise.resolve([]),
	);

/**
 * Open an authenticated, single-use Bitwarden Secrets Manager session Durable Object. The caller owns nuking it.
 */
const openBitwardenSession = async (platform: QwikCityPlatform, jurisdiction: DOJurisdictions | null, t_do_id_hex: string, endpoints: { base: string; authentication: string }, accessToken: string): Promise<BitwardenStub> => {
	// An id minted by the local `workerd` namespace isn't valid for the deployed one the proxy resolves against, so when proxying, mint it on the proxy (which can also apply the jurisdiction workerd doesn't support).
	const useProxy = isLocal(platform) && !!platform.env.BITWARDEN_SESSION_PROXY;
	const bw_id = useProxy ? await platform.env.BITWARDEN_SESSION_PROXY!.newUniqueId(jurisdiction ?? undefined) : (jurisdiction ? platform.env.BITWARDEN_SESSION.jurisdiction(jurisdiction) : platform.env.BITWARDEN_SESSION).newUniqueId().toString();
	const stub = resolveDoStub(platform, platform.env.BITWARDEN_SESSION, platform.env.BITWARDEN_SESSION_PROXY, { id: bw_id, jurisdiction: jurisdiction ?? undefined });

	await stub.init({
		t_jurisdiction: jurisdiction,
		t_do_id: (() => {
			const mainBuffer = Buffer.from(t_do_id_hex, 'hex');
			return mainBuffer.buffer.slice(mainBuffer.byteOffset, mainBuffer.byteOffset + mainBuffer.byteLength);
		})(),
		endpoints,
	});
	await stub.auth(accessToken);

	return stub;
};

const uuidBase64urlSchema = ZodUuidBase64url(7);

/**
 * A datakey secret's note, as `dataKeyRotation` writes it. Only the public half is narrowed to the JWK members that matter here — {@link SecretNote} types it as `node:crypto`'s untyped `JsonWebKey`.
 */
interface ScannedNote extends Omit<SecretNote, 'public'> {
	public?: Jwk;
}

/**
 * One vault secret that belongs to this tenant, as named by its (decrypted) key path — `<t_id>/<kr_id>/<dk_id>`, all base64url.
 */
interface ScannedSecret {
	bw_id: UUID;
	kr_id_hex: string;
	dk_id_hex: string;
}

interface ScannedDatakey {
	dk_id_hex: string;
	bw_id_hex: string;
	created: Date;
}

interface ScannedKeyring {
	kr_id_hex: string;
	created: Date;
	/** Newest datakey first, so index 0 is the keyring's current key */
	datakeys: ScannedDatakey[];
	metadata?: KeyringMetadata;
}

// eslint-disable-next-line qwik/loader-location
const useVaultOverview = routeLoader$(({ sharedMap, resolveValue }) => async () => {
	const perms = await resolveValue(usePermissions);

	if (!perms || perms.r_keyring < Permissions.Read) {
		return null;
	}

	const t_db = sharedMap.get('t_db') as SqliteRemoteDatabase;
	const t_do = sharedMap.get('t_do') as ReturnType<EnvVars['TENANT_D0']['get']>;

	const [{ byo_bw }, [keyrings], [datakeys]] = await Promise.all([t_do.getProperties({ byo_bw: true }), t_db.select({ total: count() }).from(tenantSchema.keyrings), t_db.select({ total: count() }).from(tenantSchema.datakeys)]);

	return {
		byo: Boolean(byo_bw),
		keyrings: keyrings?.total ?? 0,
		datakeys: datakeys?.total ?? 0,
		canRescan: perms.r_keyring >= Permissions.Write && perms.r_datakey >= Permissions.Write,
	};
});

// eslint-disable-next-line qwik/loader-location
const useRescanVault = routeAction$(async (_data, { sharedMap, platform, fail, request }) => {
	const t_db = sharedMap.get('t_db') as SqliteRemoteDatabase;
	const session = sharedMap.get('session') as Session;

	const [you] = await t_db
		.select({ r_keyring: tenantSchema.users.r_keyring, r_datakey: tenantSchema.users.r_datakey })
		.from(tenantSchema.users)
		.where(and(eq(tenantSchema.users.u_id, sql`unhex(${session.user!.u_id.hex})`), eq(tenantSchema.users.approved, true)))
		.limit(1);

	// Rebuilding rows creates keyrings *and* datakeys, so it takes write on both
	if (!you || you.r_keyring < Permissions.Write || you.r_datakey < Permissions.Write) {
		return fail(403, { message: 'Insufficient permissions' });
	}

	const t_id_hex = sharedMap.get('t_id_hex') as string;

	// Crawling and decrypting the whole vault is expensive on both our side and Bitwarden's, so this is capped at the tightest rate the binding supports - one rescan per tenant per minute
	const rateLimit = await platform.env.VAULT_RESCAN_RATE_LIMITER.limit({ key: t_id_hex });
	if (!rateLimit.success) {
		return fail(429, { message: 'Vault rescans are limited to once per minute' });
	}

	const t_id_base64url = Buffer.from(t_id_hex, 'hex').toString('base64url');
	const r_db = sharedMap.get('r_db') as DrizzleD1Database;
	const t_do = sharedMap.get('t_do') as ReturnType<EnvVars['TENANT_D0']['get']>;

	const [[tenant], { byo_bw }] = await Promise.all([
		r_db
			.select({ jurisdiction: rootSchema.tenants.jurisdiction, do_id: rootSchema.tenants.do_id })
			.from(rootSchema.tenants)
			.where(eq(rootSchema.tenants.t_id, sql`unhex(${t_id_hex})`))
			.limit(1)
			.then((rows) => rows.map((row) => ({ ...row, do_id: row.do_id.toString('hex') }))),
		t_do.getProperties({ byo_bw: true }),
	]);

	if (!tenant) {
		return fail(404, { message: 'Tenant not found' });
	}

	const rootAccessToken = tenant.jurisdiction === DOJurisdictions['The European Union'] ? platform.env.EU_BW_SM_ACCESS_TOKEN : platform.env.US_BW_SM_ACCESS_TOKEN;

	const r_bwStub = await openBitwardenSession(
		platform,
		tenant.jurisdiction,
		tenant.do_id,
		{
			base: tenant.jurisdiction === DOJurisdictions['The European Union'] ? BitwardenCloudEndpoints.Api.eu : BitwardenCloudEndpoints.Api.us,
			authentication: tenant.jurisdiction === DOJurisdictions['The European Union'] ? BitwardenCloudEndpoints.Identity.eu : BitwardenCloudEndpoints.Identity.us,
		},
		rootAccessToken,
	);
	// Only set when the tenant brought their own vault, so the `finally` knows whether there's a second session to tear down
	let t_bwStub: BitwardenStub | undefined;

	try {
		// Whichever vault actually holds this tenant's key material, plus the token that decrypts its contents
		let scanStub = r_bwStub;
		let scanToken = rootAccessToken;

		if (byo_bw) {
			const [connection] = await r_bwStub.getSecrets([byo_bw]);

			if (!connection) {
				return fail(424, { message: 'Bitwarden connection secret not found' });
			}

			const note = JSON.parse(await r_bwStub.decryptSecret(rootAccessToken, connection.note)) as zm.output<typeof TenantByoBwNoteSchema>;
			scanToken = await r_bwStub.decryptSecret(rootAccessToken, connection.value);
			t_bwStub = await openBitwardenSession(platform, tenant.jurisdiction, tenant.do_id, note.endpoints, scanToken);
			scanStub = t_bwStub;
		}

		const { secrets } = await scanStub.getSecretsAndProjects();

		// Key paths only, on purpose: in the managed vault this listing spans every tenant's secrets, so nothing may fetch a secret's *value* until the path has proven it belongs to this tenant
		const paths = await decryptAll(
			scanStub,
			scanToken,
			secrets.map(({ key }) => key),
		);

		const matches = paths.reduce<ScannedSecret[]>((acc, path, index) => {
			const [t, kr, dk, ...rest] = (path ?? '').split('/');

			// `<t_id>/bw` (the BYO vault token) and anything belonging to another tenant fall out here
			if (rest.length === 0 && t === t_id_base64url && kr && dk && uuidBase64urlSchema.safeParse(kr).success && uuidBase64urlSchema.safeParse(dk).success) {
				acc.push({
					bw_id: secrets[index]!.id,
					kr_id_hex: Buffer.from(kr, 'base64url').toString('hex'),
					dk_id_hex: Buffer.from(dk, 'base64url').toString('hex'),
				});
			}

			return acc;
		}, []);

		if (matches.length === 0) {
			return { success: true, scanned: 0, keyringsCreated: 0, keyringsUpdated: 0, datakeysCreated: 0, datakeysRelinked: 0, skipped: 0, keyrings: [] };
		}

		// Safe now: every id below was proven to be this tenant's above
		const details = await scanStub.getSecrets(matches.map(({ bw_id }) => bw_id));
		const notes = await decryptAll(
			scanStub,
			scanToken,
			details.map(({ note }) => note),
		);
		const noteBySecretId = details.reduce<Record<string, ScannedNote | undefined>>((acc, { id }, index) => {
			try {
				acc[id] = notes[index] ? (JSON.parse(notes[index]) as ScannedNote) : undefined;
			} catch {
				acc[id] = undefined;
			}
			return acc;
		}, {});

		// Symmetric keyrings have no public half, so their algorithm can only be read off the private JWK. Fetch those - and only those - separately.
		const privateOnly = details.filter(({ id }) => !noteBySecretId[id]?.public);
		const privateJwks = await decryptAll(
			scanStub,
			scanToken,
			privateOnly.map(({ value }) => value),
		);
		const jwkBySecretId = privateOnly.reduce<Record<string, Jwk | undefined>>((acc, { id }, index) => {
			try {
				acc[id] = privateJwks[index] ? (JSON.parse(privateJwks[index]) as Jwk) : undefined;
			} catch {
				acc[id] = undefined;
			}
			return acc;
		}, {});

		const scannedKeyrings = Array.from(
			matches
				.reduce<Map<string, ScannedKeyring>>((acc, match) => {
					const keyring = acc.get(match.kr_id_hex) ?? {
						kr_id_hex: match.kr_id_hex,
						// A keyring's UUIDv7 was minted the moment the keyring was created
						created: uuidv7ToDate(match.kr_id_hex),
						datakeys: [],
					};

					keyring.datakeys.push({
						dk_id_hex: match.dk_id_hex,
						bw_id_hex: match.bw_id.replaceAll('-', ''),
						created: uuidv7ToDate(match.dk_id_hex),
					});

					acc.set(match.kr_id_hex, keyring);
					return acc;
				}, new Map())
				.values(),
		).map((keyring) => {
			keyring.datakeys.sort((a, b) => b.created.getTime() - a.created.getTime());

			// The newest datakey reflects the keyring's current settings; older generations may predate a settings change
			const newest = matches.find(({ dk_id_hex }) => dk_id_hex === keyring.datakeys[0]!.dk_id_hex)!;
			const note = noteBySecretId[newest.bw_id];
			const jwk = note?.public ?? jwkBySecretId[newest.bw_id];
			keyring.metadata = jwk ? JwkMetadata.describe(jwk, note?.salt) : undefined;

			return keyring;
		});

		/**
		 * The layout's `t_db` leaves `throwOnError` off, so a failed statement is logged and swallowed — which would let a rebuild that wrote nothing still report success. The reconciliation runs on its own instance that surfaces failures instead; `drizzleD0` is cheap, it's the (deliberately omitted) cache that isn't.
		 */
		const t_rebuild_db = drizzleD0(t_do, {
			throwOnError: true,
			logger: new DefaultLogger({ writer: new DebugLogWriter(tenant.do_id) }),
		});

		const [existingKeyrings, existingDatakeys] = await Promise.all([
			t_rebuild_db
				.select({ kr_id: tenantSchema.keyrings.kr_id, name: tenantSchema.keyrings.name, m_time: tenantSchema.keyrings.m_time })
				.from(tenantSchema.keyrings)
				.then((rows) => new Map(rows.map((row) => [row.kr_id.toString('hex'), row]))),
			t_rebuild_db
				.select({ dk_id: tenantSchema.datakeys.dk_id, bw_id: tenantSchema.datakeys.bw_id })
				.from(tenantSchema.datakeys)
				.then((rows) => rows.map((row) => ({ dk_id_hex: row.dk_id.toString('hex'), bw_id_hex: row.bw_id?.toString('hex') ?? null }))),
		]);
		const existingDatakeyById = new Map(existingDatakeys.map((row) => [row.dk_id_hex, row]));
		const claimedBwIds = new Set(existingDatakeys.flatMap((row) => (row.bw_id_hex ? [row.bw_id_hex] : [])));

		const writes: ReturnType<SqliteRemoteDatabase['run']>[] = [];
		const report: { kr_id_base64url: string; name: string; key_type: string | null; key_size: number | null; hash: string | null; created: string; rotated: string; datakeys: number; datakeysCreated: number; isNew: boolean }[] = [];
		let keyringsCreated = 0;
		let keyringsUpdated = 0;
		let datakeysCreated = 0;
		let datakeysRelinked = 0;
		let skipped = 0;

		scannedKeyrings.forEach((keyring) => {
			const existing = existingKeyrings.get(keyring.kr_id_hex);
			const rotated = keyring.datakeys[0]!.created;

			if (!existing) {
				// Nothing to rebuild the row from - report it instead of writing a keyring whose `key_type` would be a guess
				if (!keyring.metadata) {
					skipped += keyring.datakeys.length;
					return;
				}

				writes.push(
					t_rebuild_db.insert(tenantSchema.keyrings).values({
						kr_id: sql`unhex(${keyring.kr_id_hex})`,
						// The original name is not recoverable - it never left the tenant DB. Hex (not base64url) keeps this unique under the `lower(name)` index, which base64url's case-significant alphabet would not.
						name: `recovered-${keyring.kr_id_hex}`,
						key_type: keyring.metadata.key_type,
						key_size: keyring.metadata.key_size,
						hash: keyring.metadata.hash,
						b_time: keyring.created,
						// No record of when settings last changed, so the creation time is the safest claim
						c_time: keyring.created,
						m_time: rotated,
					}) as unknown as ReturnType<SqliteRemoteDatabase['run']>,
				);
				keyringsCreated++;
			} else if (existing.m_time.getTime() < rotated.getTime()) {
				// The keyring survived but lost track of a rotation. Only the rotation time is corrected - name, algorithm and rotation policy stay as the tenant configured them.
				writes.push(
					t_rebuild_db
						.update(tenantSchema.keyrings)
						.set({ m_time: rotated })
						.where(eq(tenantSchema.keyrings.kr_id, sql`unhex(${keyring.kr_id_hex})`)) as unknown as ReturnType<SqliteRemoteDatabase['run']>,
				);
				keyringsUpdated++;
			}

			let created = 0;
			keyring.datakeys.forEach((datakey) => {
				const existingDatakey = existingDatakeyById.get(datakey.dk_id_hex);

				if (!existingDatakey) {
					writes.push(
						t_rebuild_db.insert(tenantSchema.datakeys).values({
							dk_id: sql`unhex(${datakey.dk_id_hex})`,
							kr_id: sql`unhex(${keyring.kr_id_hex})`,
							bw_id: sql`unhex(${datakey.bw_id_hex})`,
						}) as unknown as ReturnType<SqliteRemoteDatabase['run']>,
					);
					created++;
					datakeysCreated++;
				} else if (existingDatakey.bw_id_hex !== datakey.bw_id_hex && !claimedBwIds.has(datakey.bw_id_hex)) {
					// The row is there but points at the wrong secret (or none). `bw_id` is unique, so only re-point it when no other row already holds this secret.
					writes.push(
						t_rebuild_db
							.update(tenantSchema.datakeys)
							.set({ bw_id: sql`unhex(${datakey.bw_id_hex})` })
							.where(eq(tenantSchema.datakeys.dk_id, sql`unhex(${datakey.dk_id_hex})`)) as unknown as ReturnType<SqliteRemoteDatabase['run']>,
					);
					datakeysRelinked++;
				}
			});

			report.push({
				kr_id_base64url: Buffer.from(keyring.kr_id_hex, 'hex').toString('base64url'),
				name: existing?.name ?? `recovered-${keyring.kr_id_hex}`,
				key_type: keyring.metadata?.key_type ?? null,
				key_size: keyring.metadata?.key_size ?? null,
				hash: keyring.metadata?.hash ?? null,
				created: keyring.created.toISOString(),
				rotated: rotated.toISOString(),
				datakeys: keyring.datakeys.length,
				datakeysCreated: created,
				isNew: !existing,
			});
		});

		// Ordered, so a datakey never lands before the keyring its foreign key points at
		if (writes.length > 0) {
			await t_rebuild_db.batch(writes as [(typeof writes)[number], ...(typeof writes)[number][]]);
		}

		const now = new Date();
		const headers = (platform.request ?? request).headers;
		const log: zm.input<typeof TenantLogQueueMessageSchema> = {
			t_id: t_id_hex,
			jurisdiction: tenant.jurisdiction,
			id: uuidv7({ msecs: now.getTime() }).replaceAll('-', ''),
			timestamp: now.toISOString(),
			event_type: TenantLogEventType['rescanned vault'],
			context: { scanned: matches.length, keyringsCreated, keyringsUpdated, datakeysCreated, datakeysRelinked, skipped },
			ip: headers.get('CF-Connecting-IP'),
			user_agent: headers.get('User-Agent'),
			// `Cf-Ray` is `<hex id>-<colo>`, and only the id half is hex, so that's all the blob column can hold
			ray_id: headers.get('CF-Ray')?.split('-')[0],
			u_id: session.user!.u_id.hex,
			status: TenantLogEventStatus.success,
		};
		// Post the raw version, not the parsed one, so the consumer validates it independently and a bug here can't smuggle an unvalidated row past both ends
		await TenantLogQueueMessageSchema.parseAsync(log);
		platform.ctx.waitUntil(platform.env.LOGS.sendBatch([{ body: log, contentType: 'json' }]));

		return {
			success: true,
			scanned: matches.length,
			keyringsCreated,
			keyringsUpdated,
			datakeysCreated,
			datakeysRelinked,
			skipped,
			keyrings: report.sort((a, b) => Date.parse(b.rotated) - Date.parse(a.rotated)),
		};
	} catch (error) {
		// Safe to log and surface: what reaches here is a Bitwarden API response or a DB failure. The bulk decrypt paths swallow their own rejections (which carry ciphertext) rather than letting them through, and the remaining decrypt errors are bare `EncString` parse/MAC messages with no payload attached.
		console.error('Error rescanning vault', error);
		return fail(500, { message: error instanceof Error ? error.message : 'Vault rescan failed' });
	} finally {
		platform.ctx.waitUntil(r_bwStub.nuke('Vault rescan ended'));
		if (t_bwStub) platform.ctx.waitUntil(t_bwStub.nuke('Vault rescan ended'));
	}
});

const cardClass = 'border-surface-light/60 dark:border-surface-dark/60 dark:bg-surface-dark/70 rounded-2xl border bg-white/70 p-6 shadow-sm backdrop-blur-md';

export default component$(() => {
	const locale = getLocale();
	const timezone = useTimezone();
	const overview = useVaultOverview();
	const rescan = useRescanVault();

	return (
		<div class="mx-auto w-full max-w-5xl px-6 py-10">
			<div class="mb-8">
				<h1 class="text-2xl font-bold tracking-tight text-gray-900 dark:text-white">{m.vault_page_title()}</h1>
				<p class="mt-1 text-sm text-gray-500 dark:text-gray-400">{m.vault_page_subtitle()}</p>
			</div>

			<Resource
				value={overview}
				onPending={() => (
					<div class="space-y-4">
						<div class="h-28 animate-pulse rounded-2xl bg-gray-200 dark:bg-gray-700" />
						<div class="h-48 animate-pulse rounded-2xl bg-gray-200 dark:bg-gray-700" />
					</div>
				)}
				onRejected={(error) =>
					error instanceof Error ? (
						<p class="text-red-600">
							{m.common_error_label()} {error.message}
						</p>
					) : (
						<pre class="text-red-600">{JSON.stringify(error, null, '\t')}</pre>
					)
				}
				onResolved={(info) =>
					info === null ? (
						<div class={cardClass}>
							<p class="text-sm text-gray-500 dark:text-gray-400">{m.vault_no_access()}</p>
						</div>
					) : (
						<div class="space-y-6">
							{/* Where this tenant's key material lives */}
							<section class={cardClass}>
								<h2 class="text-lg font-semibold text-gray-900 dark:text-white">{m.vault_storage_title()}</h2>
								<div class="mt-3 flex flex-wrap items-center gap-3">
									<span class="border-primary-accent/30 bg-primary-accent/10 text-primary-accent inline-flex items-center gap-1.5 rounded-full border px-3 py-1 text-sm font-medium">
										{info.byo ? (
											<>
												<SiBitwarden class="inline-block align-middle" /> {m.vault_storage_byo()}
											</>
										) : (
											m.vault_storage_managed()
										)}
									</span>
									<span class="text-sm text-gray-600 dark:text-gray-300">{m.vault_storage_counts({ keyrings: info.keyrings, datakeys: info.datakeys })}</span>
								</div>
								<p class="mt-2 text-xs text-gray-400 dark:text-gray-500">{info.byo ? m.vault_storage_byo_hint() : m.vault_storage_managed_hint()}</p>
							</section>

							{/* Rescan */}
							<section class={cardClass}>
								<h2 class="text-lg font-semibold text-gray-900 dark:text-white">{m.vault_rescan_title()}</h2>
								<p class="mt-1 text-sm text-gray-500 dark:text-gray-400">{m.vault_rescan_body()}</p>
								<ul class="mt-3 list-inside list-disc space-y-1 text-xs text-gray-500 dark:text-gray-400">
									<li>{m.vault_rescan_detail_derive()}</li>
									<li>{m.vault_rescan_detail_names()}</li>
									<li>{m.vault_rescan_detail_nondestructive()}</li>
									<li>{m.vault_rescan_detail_schedules()}</li>
								</ul>

								{info.canRescan ? (
									<Form action={rescan} class="mt-5">
										<button type="submit" disabled={rescan.isRunning} class="bg-primary-accent hover:bg-primary-accent/85 hover:shadow-primary-accent/25 inline-flex cursor-pointer items-center justify-center gap-2 rounded-xl px-4 py-2.5 text-sm font-medium text-white transition-all duration-150 hover:shadow-md active:scale-[0.98] disabled:cursor-wait disabled:opacity-60">
											{rescan.isRunning ? (
												<>
													<LuLoader class="h-4 w-4 animate-spin" />
													{m.vault_rescan_running()}
												</>
											) : (
												m.vault_rescan_btn()
											)}
										</button>
									</Form>
								) : (
									<p class="mt-5 text-xs text-amber-600 dark:text-amber-400">{m.vault_rescan_needs_write()}</p>
								)}

								{rescan.value?.failed ? (
									<div class="mt-4 rounded-lg border border-red-200 bg-red-50 p-3 text-sm text-red-700 dark:border-red-800 dark:bg-red-900/30 dark:text-red-300">
										{m.vault_rescan_failed()} <span class="font-mono">{rescan.value.message}</span>
									</div>
								) : null}

								{rescan.value?.success ? (
									<div class="mt-5">
										<div class="flex flex-wrap gap-3">
											{(
												[
													[m.vault_rescan_stat_scanned(), rescan.value.scanned],
													[m.vault_rescan_stat_keyrings_created(), rescan.value.keyringsCreated],
													[m.vault_rescan_stat_keyrings_updated(), rescan.value.keyringsUpdated],
													[m.vault_rescan_stat_datakeys_created(), rescan.value.datakeysCreated],
													[m.vault_rescan_stat_datakeys_relinked(), rescan.value.datakeysRelinked],
													[m.vault_rescan_stat_skipped(), rescan.value.skipped],
												] as [string, number][]
											).map(([label, value]) => (
												<div key={label} class="dark:border-surface-dark/60 min-w-30 flex-1 rounded-xl border border-gray-200/80 px-3 py-2">
													<p class="text-lg font-semibold text-gray-900 dark:text-white">{value}</p>
													<p class="text-[11px] font-medium tracking-wide text-gray-500 uppercase dark:text-gray-400">{label}</p>
												</div>
											))}
										</div>

										{rescan.value.keyrings.length > 0 ? (
											<ul class="divide-surface-light/60 dark:divide-surface-dark/60 mt-4 divide-y">
												{rescan.value.keyrings.map((keyring) => (
													<li key={keyring.kr_id_base64url} class="flex flex-wrap items-center justify-between gap-3 py-3">
														<div>
															<p class="flex items-center gap-2 text-sm font-semibold text-gray-900 dark:text-white">
																{keyring.name}
																{keyring.isNew ? <span class="inline-flex items-center rounded-full bg-green-100 px-2 py-0.5 text-[11px] font-medium text-green-700 dark:bg-green-900/30 dark:text-green-400">{m.vault_rescan_badge_recovered()}</span> : null}
															</p>
															<p class="font-mono text-xs text-gray-500 dark:text-gray-400">{keyring.kr_id_base64url}</p>
														</div>
														<div class="text-right text-xs text-gray-500 dark:text-gray-400">
															<p>{keyring.key_type ? `${keyring.key_type}${keyring.key_size ? ` · ${keyring.key_size}` : ''} · ${keyring.hash}` : m.vault_rescan_algo_unknown()}</p>
															<p>{m.vault_rescan_datakeys_found({ count: keyring.datakeys, created: keyring.datakeysCreated })}</p>
															<p>
																{m.vault_rescan_label_rotated()}{' '}
																<time dateTime={keyring.rotated} title={`${new Date(keyring.rotated).toLocaleString(locale, { hour12: false, timeZone: 'UTC' })} UTC`}>
																	{`${new Date(keyring.rotated).toLocaleString(locale, { timeZone: timezone.value.long })} ${timezone.value.short}`}
																</time>
															</p>
														</div>
													</li>
												))}
											</ul>
										) : (
											<p class="mt-4 text-sm text-gray-500 dark:text-gray-400">{m.vault_rescan_empty()}</p>
										)}
									</div>
								) : null}
							</section>
						</div>
					)
				}
			/>
		</div>
	);
});
