import type { Session } from '@auth/qwik';
import { component$, getLocale, Resource } from '@builder.io/qwik';
import { Form, routeAction$, routeLoader$, useLocation, z, zod$ } from '@builder.io/qwik-city';
import { LuLoader } from '@qwikest/icons/lucide';
import { SiBitwarden } from '@qwikest/icons/simpleicons';
import type { TenantByoBwNoteSchema } from 'db';
import { DebugLogWriter, drizzleD0 } from 'db/core';
import * as rootSchema from 'db/schemas/root';
import * as tenantSchema from 'db/schemas/tenant/main';
import type { DrizzleD1Database } from 'drizzle-orm/d1';
import { DefaultLogger } from 'drizzle-orm/logger';
import { and, count, eq, gt, gte, inArray, sql } from 'drizzle-orm/sql';
import type { SqliteRemoteDatabase } from 'drizzle-orm/sqlite-proxy';
import { hexToUuid, isTenantWorkflowInstanceId, uuidv7ToDate, workflowInstanceId } from 'helpers';
import type { VaultMigrationApprovalSchema } from 'helpers/vault-migration';
import { decodeEnvelope, encodeEnvelope, sealApproval, sealVaultConfig, unsealApproval, VAULT_MIGRATION_APPROVAL_EVENT, vaultMigrationTokenDigest } from 'helpers/vault-migration';
import { ZodUuidBase64url } from 'helpers/zod/mini';
import { Buffer } from 'node:buffer';
import type { UUID } from 'node:crypto';
import { DOJurisdictions, Permissions } from 'types';
import { BitwardenCloudEndpoints, type SecretNote } from 'types/bw';
import { TenantLogEventStatus, TenantLogEventType, TenantLogQueueMessageSchema } from 'types/tenants/logging';
import { TenantVerificationAction } from 'types/tenants/verification';
import { v7 as uuidv7 } from 'uuid';
import type * as zm from 'zod/mini';
import { VaultConnectionFields } from '~/components/team/vault-connection/vault-connection';
import { isLocal, resolveDoStub } from '~/helpers/do-proxy';
import { JwkMetadata, type Jwk, type KeyringMetadata } from '~/helpers/jwk-metadata';
import { usePermissions } from '~/routes/(team)/[tenantId]/layout';
import { useTimezone } from '~/routes/layout';
import { getUserD0 } from '~/routes/plugin@auth';
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
 * Open an authenticated, single-use Bitwarden Secrets Manager session Durable Object. The caller owns nuking it once done.
 */
const openBitwardenSession = async (platform: QwikCityPlatform, t_id_hex: string, u_id: string, jurisdiction: DOJurisdictions | null, t_do_id_hex: string, endpoints: { base: string; authentication: string }, accessToken: string): Promise<BitwardenStub> => {
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
		t_id: t_id_hex,
		u_id,
		ak_id: null,
		endpoints,
	});
	await stub.auth(accessToken);

	return stub;
};

const uuidBase64urlSchema = ZodUuidBase64url(7);

/**
 * Look up the tenant's row in root - jurisdiction and the resolved Durable Object id, both needed before any Bitwarden session can be opened on its behalf.
 */
const readTenantRow = (r_db: DrizzleD1Database, t_id_hex: string) =>
	r_db
		.select({ jurisdiction: rootSchema.tenants.jurisdiction, do_id: rootSchema.tenants.do_id })
		.from(rootSchema.tenants)
		.where(eq(rootSchema.tenants.t_id, sql`unhex(${t_id_hex})`))
		.limit(1)
		.then((rows) => rows.map((row) => ({ ...row, do_id: row.do_id.toString('hex') }))[0]);

const rootEndpoints = (jurisdiction: DOJurisdictions | null) => ({
	base: jurisdiction === DOJurisdictions['The European Union'] ? BitwardenCloudEndpoints.Api.eu : BitwardenCloudEndpoints.Api.us,
	authentication: jurisdiction === DOJurisdictions['The European Union'] ? BitwardenCloudEndpoints.Identity.eu : BitwardenCloudEndpoints.Identity.us,
});

/**
 * Best-effort resolution of a Bitwarden project id to its display name, against the tenant's own vault.
 *
 * Never allowed to fail the page: if the customer's Bitwarden is unreachable, the access token has since been revoked, or the project was renamed/deleted on their end, this falls back to the bare id - the settings form stays fully usable either way, just less readable.
 */
const resolveProjectName = async (platform: QwikCityPlatform, t_id_hex: string, u_id: string, jurisdiction: DOJurisdictions | null, t_do_id_hex: string, endpoints: { base: string; authentication: string }, accessToken: string, projectId: string) => {
	let stub: BitwardenStub | undefined;

	try {
		stub = await openBitwardenSession(platform, t_id_hex, u_id, jurisdiction, t_do_id_hex, endpoints, accessToken);
		const project = (await stub.getProjects()).find(({ id }) => id === projectId);
		return project ? await stub.decryptSecret(accessToken, project.name) : projectId;
	} catch (error) {
		console.error('Error resolving vault project name', error);
		return projectId;
	} finally {
		if (stub) platform.ctx.waitUntil(stub.nuke('Project name resolved'));
	}
};

/**
 * Where this tenant's key material lives right now, as far as the settings form needs to know.
 *
 * The access token is deliberately **not** returned. It's only ever needed to talk to the vault, never to describe it, and the form asks the customer to re-enter it for any change rather than round-tripping it through the browser.
 *
 * `withProjectName` opts into an extra round trip to the tenant's own Bitwarden to resolve `project` to a display name - worth paying for a page render, not for every diff check `useSaveVaultConnection` runs on submit.
 */
const readVaultConnection = async (platform: QwikCityPlatform, u_id: string, r_db: DrizzleD1Database, t_do: ReturnType<EnvVars['TENANT_D0']['get']>, t_id_hex: string, { withProjectName = false }: { withProjectName?: boolean } = {}) => {
	const [tenant, { byo_bw }] = await Promise.all([readTenantRow(r_db, t_id_hex), t_do.getProperties({ byo_bw: true })]);

	if (!tenant) return null;
	if (!byo_bw) return { mode: 'managed' as const, tenant, byo_bw: null, project: null, projectName: null, endpoints: null };

	const accessToken = tenant.jurisdiction === DOJurisdictions['The European Union'] ? platform.env.EU_BW_SM_ACCESS_TOKEN : platform.env.US_BW_SM_ACCESS_TOKEN;
	const stub = await openBitwardenSession(platform, t_id_hex, u_id, tenant.jurisdiction, tenant.do_id, rootEndpoints(tenant.jurisdiction), accessToken);

	try {
		const [connection] = await stub.getSecrets([byo_bw]);
		if (!connection) return { mode: 'managed' as const, tenant, byo_bw: null, project: null, projectName: null, endpoints: null };

		const [note, customerAccessToken] = await Promise.all([
			stub.decryptSecret(accessToken, connection.note).then((raw) => JSON.parse(raw) as zm.output<typeof TenantByoBwNoteSchema>),
			// Only decrypted when actually needed for the lookup below - nothing holds onto it past this function
			withProjectName ? stub.decryptSecret(accessToken, connection.value) : Promise.resolve(undefined),
		]);

		const projectName = withProjectName && customerAccessToken !== undefined ? await resolveProjectName(platform, t_id_hex, u_id, tenant.jurisdiction, tenant.do_id, note.endpoints, customerAccessToken, note.project) : null;

		return { mode: 'bitwarden' as const, tenant, byo_bw: byo_bw as UUID, project: note.project, projectName, endpoints: note.endpoints };
	} finally {
		platform.ctx.waitUntil(stub.nuke('Vault connection read'));
	}
};

/**
 * Replace the secret in our organization that holds a tenant's BYO connection, and repoint `byo_bw` at the replacement.
 *
 * Bitwarden's Secrets Manager API here is create-only, so "updating" a connection is write-new, repoint, delete-old - in that order, so a failure anywhere leaves `byo_bw` aimed at a secret that still exists.
 */
const replaceVaultConnection = async (platform: QwikCityPlatform, u_id: string, tenant: { jurisdiction: DOJurisdictions | null; do_id: string }, t_do: ReturnType<EnvVars['TENANT_D0']['get']>, t_id_base64url: string, previous: UUID | null, connection: { accessToken: string; project: string; endpoints: { base: string; authentication: string } }) => {
	const t_id_hex = Buffer.from(t_id_base64url, 'base64url').toString('hex');
	const rootAccessToken = tenant.jurisdiction === DOJurisdictions['The European Union'] ? platform.env.EU_BW_SM_ACCESS_TOKEN : platform.env.US_BW_SM_ACCESS_TOKEN;
	const stub = await openBitwardenSession(platform, t_id_hex, u_id, tenant.jurisdiction, tenant.do_id, rootEndpoints(tenant.jurisdiction), rootAccessToken);

	try {
		const [key, value, note] = await Promise.all([stub.encryptSecret(rootAccessToken, [t_id_base64url, 'bw'].join('/')), stub.encryptSecret(rootAccessToken, connection.accessToken), stub.encryptSecret(rootAccessToken, JSON.stringify({ project: connection.project, endpoints: connection.endpoints } satisfies zm.input<typeof TenantByoBwNoteSchema>))]);

		const secret = await stub.setSecret({
			projectId: tenant.jurisdiction === DOJurisdictions['The European Union'] ? platform.env.EU_BW_SM_PROJECT_ID : platform.env.US_BW_SM_PROJECT_ID,
			key,
			value,
			note,
		});

		await t_do.updateProperties({ byo_bw: secret.id }, false, true);

		// Only once nothing points at it anymore. A failure here leaks one orphaned secret rather than stranding the tenant.
		if (previous) platform.ctx.waitUntil(stub.deleteSecrets([previous]).catch((error: unknown) => console.error('Failed to delete superseded vault connection secret', error)));

		return secret.id;
	} finally {
		platform.ctx.waitUntil(stub.nuke('Vault connection replaced'));
	}
};

/**
 * Everyone who may approve `action`, and the address to reach them at.
 *
 * Membership is read from the tenant, but a user's email only exists inside their own Durable Object (root stores an HMAC of it, which is one-way on purpose), so each recipient costs a lookup. They're bounded the same way the vault scan is.
 */
const approvalRecipients = async (platform: QwikCityPlatform, r_db: DrizzleD1Database, t_db: SqliteRemoteDatabase, threshold: Permissions) => {
	const members = await t_db
		.select({ u_id: tenantSchema.users.u_id })
		.from(tenantSchema.users)
		.where(and(eq(tenantSchema.users.approved, true), gte(tenantSchema.users.r_tenant, threshold)))
		.then((rows) => rows.map(({ u_id }) => u_id.toString('hex')));

	if (members.length === 0) return [];

	const rows = await r_db
		.select({ u_id: rootSchema.users.u_id, jurisdiction: rootSchema.users.jurisdiction, do_id: rootSchema.users.do_id })
		.from(rootSchema.users)
		.where(inArray(rootSchema.users.u_id, members.map((hex) => sql`unhex(${hex})`) as never))
		.then((rows) => rows.map((row) => ({ u_id: row.u_id.toString('hex'), jurisdiction: row.jurisdiction, do_id: row.do_id?.toString('hex') ?? null })));

	return chunked(rows, DECRYPT_CONCURRENCY)
		.reduce<Promise<(string | undefined)[]>>(
			async (acc, chunk) => [
				...(await acc),
				...(await Promise.all(
					chunk.map((row) =>
						getUserD0(platform, r_db, row.jurisdiction, row.do_id ?? hexToUuid(row.u_id))
							.getProperties({ email: true })
							.then(({ email }) => email)
							// A member whose Durable Object can't be reached simply doesn't get an email; the others still do
							.catch(() => undefined),
					),
				)),
			],
			Promise.resolve([]),
		)
		.then((emails) => Array.from(new Set(emails.filter((email): email is string => Boolean(email)))));
};

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
		t_id_hex,
		session.user!.u_id.hex,
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
			t_bwStub = await openBitwardenSession(platform, t_id_hex, session.user!.u_id.hex, tenant.jurisdiction, tenant.do_id, note.endpoints, scanToken);
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

/**
 * A tenant DB handle that surfaces failed statements instead of logging and swallowing them.
 *
 * The layout's `t_db` leaves `throwOnError` off, which is fine for reads but not for the approval token: an insert that silently did nothing would still send out emails, and every link in them would then be rejected as expired with nothing anywhere saying why. A delete that silently did nothing would leave a single-use token spendable twice. `drizzleD0` is cheap - it's the (deliberately omitted) cache that isn't.
 */
const strictTenantDb = (t_do: ReturnType<EnvVars['TENANT_D0']['get']>, do_id_hex: string) =>
	drizzleD0(t_do, {
		throwOnError: true,
		logger: new DefaultLogger({ writer: new DebugLogWriter(do_id_hex) }),
	});

/**
 * Which of the destructive migration actions an approval token authorizes, and therefore how much authority redeeming it takes.
 */
const APPROVAL_THRESHOLD: Record<TenantVerificationAction, Permissions> = {
	[TenantVerificationAction['migrate and transfer']]: Permissions.Write,
	[TenantVerificationAction['migrate and delete']]: Permissions.Admin,
};

/**
 * Enqueue one tenant audit log. Every worker builds these itself rather than sharing a helper, because each reaches the incoming request differently - this is the Qwik shape.
 */
const logTenantEvent = async (platform: QwikCityPlatform, request: Request, tenant: { t_id_hex: string; jurisdiction: DOJurisdictions | null }, session: Session, event_type: TenantLogEventType, context: Record<string, unknown>, status: TenantLogEventStatus = TenantLogEventStatus.success) => {
	const now = new Date();
	const headers = (platform.request ?? request).headers;

	const log: zm.input<typeof TenantLogQueueMessageSchema> = {
		t_id: tenant.t_id_hex,
		jurisdiction: tenant.jurisdiction,
		// The row's UUIDv7 carries the same millisecond as `timestamp`, so ordering reflects when the event happened
		id: uuidv7({ msecs: now.getTime() }).replaceAll('-', ''),
		timestamp: now.toISOString(),
		event_type,
		context,
		ip: headers.get('CF-Connecting-IP'),
		user_agent: headers.get('User-Agent'),
		// `Cf-Ray` is `<hex id>-<colo>`, and only the id half is hex, so that's all the blob column can hold
		ray_id: headers.get('CF-Ray')?.split('-')[0],
		u_id: session.user!.u_id.hex,
		status,
	};
	// Post the raw version, not the parsed one, so the consumer validates it independently
	await TenantLogQueueMessageSchema.parseAsync(log);
	platform.ctx.waitUntil(platform.env.LOGS.sendBatch([{ body: log, contentType: 'json' }]));
};

/**
 * The vault this tenant is currently pointed at, for the settings form to render and diff against.
 */
// eslint-disable-next-line qwik/loader-location
const useVaultConnection = routeLoader$(({ sharedMap, platform, resolveValue }) => async () => {
	const perms = await resolveValue(usePermissions);

	// Which vault a tenant uses is a tenant-settings question, not a keyring one
	if (!perms || perms.r_tenant < Permissions.Read) return null;

	const session = sharedMap.get('session') as Session;
	const connection = await readVaultConnection(platform, session.user!.u_id.hex, sharedMap.get('r_db') as DrizzleD1Database, sharedMap.get('t_do') as ReturnType<EnvVars['TENANT_D0']['get']>, sharedMap.get('t_id_hex') as string, { withProjectName: true });

	if (!connection) return null;

	return {
		mode: connection.mode,
		endpoints: connection.endpoints,
		project: connection.project,
		projectName: connection.projectName,
		jurisdiction: connection.tenant.jurisdiction,
		canEdit: perms.r_tenant >= Permissions.Write,
	};
});

/**
 * A pending migration this visitor arrived to approve, if the link they followed still holds up.
 *
 * Read-only on purpose. Email scanners and link prefetchers follow URLs, so a GET may never be the thing that spends a single-use token - only the POST behind an explicit click does.
 */
// eslint-disable-next-line qwik/loader-location
const useMigrationApproval = routeLoader$(({ query, sharedMap, resolveValue }) => async () => {
	const rawTokenParam = query.get('token');
	const approvalParam = query.get('approval');
	if (!rawTokenParam || !approvalParam) return null;

	const perms = await resolveValue(usePermissions);
	if (!perms) return null;

	const envelope = decodeEnvelope(approvalParam);
	if (!envelope) return null;

	/**
	 * No database read on this path. `approval` only unseals under a key derived from `token` (see `sealApproval`'s doc comment), so a successful unseal is itself the proof that whoever holds this link also holds the exact token it was minted with - there's nothing left for a DB row to additionally confirm here. The row still gets consulted, once, at redemption (the POST below) - purely to enforce single use, which crypto alone can't do.
	 */
	let pending: zm.output<typeof VaultMigrationApprovalSchema>;
	try {
		pending = await unsealApproval(Buffer.from(rawTokenParam, 'base64url'), envelope);
	} catch {
		// Wrong token for this link, a tampered `approval` value, or a token minted for a different instance entirely - all indistinguishable from "nothing to show"
		return null;
	}

	const t_id_hex = sharedMap.get('t_id_hex') as string;
	// `pending.instance` is only trustworthy because unsealing succeeded, but it still has to name *this* tenant: without this check, a token+approval pair minted for another tenant could be replayed here and evaluated against whichever tenant's permissions the current page happens to be on
	if (!isTenantWorkflowInstanceId(pending.instance, t_id_hex)) return null;

	if (new Date(pending.expires).getTime() <= Date.now()) return null;

	return {
		action: pending.action,
		expires: pending.expires,
		// A forwarded email is not authorization: whoever clicks has to hold the permission themselves
		allowed: perms.r_tenant >= APPROVAL_THRESHOLD[pending.action],
	};
});

/**
 * Apply a change to the tenant's vault settings, or - when the change would move key material - start the approval that has to precede one.
 *
 * The browser proposes a `strategy`; this decides whether that strategy is applicable at all, from the difference between what was submitted and what the tenant is actually on. A form that lied about the current state can therefore only ever be wrong in the safe direction.
 */
// eslint-disable-next-line qwik/loader-location
const useSaveVaultConnection = routeAction$(
	async (data, { sharedMap, platform, fail, request, url }) => {
		const session = sharedMap.get('session') as Session;
		const t_db = sharedMap.get('t_db') as SqliteRemoteDatabase;
		const r_db = sharedMap.get('r_db') as DrizzleD1Database;
		const t_do = sharedMap.get('t_do') as ReturnType<EnvVars['TENANT_D0']['get']>;
		const t_id_hex = sharedMap.get('t_id_hex') as string;
		const t_id_base64url = Buffer.from(t_id_hex, 'hex').toString('base64url');

		const [you] = await t_db
			.select({ r_tenant: tenantSchema.users.r_tenant })
			.from(tenantSchema.users)
			.where(and(eq(tenantSchema.users.u_id, sql`unhex(${session.user!.u_id.hex})`), eq(tenantSchema.users.approved, true)))
			.limit(1);

		// Starting a migration takes write on the tenant; the destructive variant is gated again, higher, at approval time
		if (!you || you.r_tenant < Permissions.Write) {
			return fail(403, { message: 'Insufficient permissions' });
		}

		const current = await readVaultConnection(platform, session.user!.u_id.hex, r_db, t_do, t_id_hex);
		if (!current) return fail(404, { message: 'Tenant not found' });

		if (data.vaultMode === 'bitwarden' && (!data.accessToken || !data.project || !data.baseCloudEndpoint || !data.authCloudEndpoint)) {
			return fail(400, { message: 'A Bitwarden vault needs endpoints, an access token and a project' });
		}

		const target = data.vaultMode === 'bitwarden' ? ({ mode: 'bitwarden', accessToken: data.accessToken!, project: data.project!, endpoints: { base: data.baseCloudEndpoint!, authentication: data.authCloudEndpoint! } } as const) : ({ mode: 'managed' } as const);

		const modeChanged = target.mode !== current.mode;
		const connectionChanged = target.mode === 'bitwarden' && current.mode === 'bitwarden' && (target.endpoints.base !== current.endpoints.base || target.endpoints.authentication !== current.endpoints.authentication || target.project !== current.project);

		try {
			// Nothing moves: same vault, same project, reached the same way - only the credential is new
			if (!modeChanged && !connectionChanged) {
				if (target.mode !== 'bitwarden') return fail(400, { message: 'Nothing to change' });

				await replaceVaultConnection(platform, session.user!.u_id.hex, current.tenant, t_do, t_id_base64url, current.byo_bw, target);
				await logTenantEvent(platform, request, { t_id_hex, jurisdiction: current.tenant.jurisdiction }, session, TenantLogEventType['changed byo vault token'], { project: target.project, endpoints: target.endpoints });

				return { applied: 'token' as const };
			}

			// The endpoints or project moved, and the customer says they already carried their key material across by hand. There is nothing for us to move, only a pointer to correct.
			if (!modeChanged && target.mode === 'bitwarden' && data.strategy === 'manual') {
				await replaceVaultConnection(platform, session.user!.u_id.hex, current.tenant, t_do, t_id_base64url, current.byo_bw, target);
				await logTenantEvent(platform, request, { t_id_hex, jurisdiction: current.tenant.jurisdiction }, session, TenantLogEventType['changed byo vault token'], { project: target.project, endpoints: target.endpoints, manual: true });

				return { applied: 'manual' as const };
			}

			if (data.strategy !== 'transfer' && data.strategy !== 'delete') {
				return fail(400, { message: 'This change needs a migration strategy' });
			}

			const action = data.strategy === 'transfer' ? TenantVerificationAction['migrate and transfer'] : TenantVerificationAction['migrate and delete'];

			const recipients = await approvalRecipients(platform, r_db, t_db, APPROVAL_THRESHOLD[action]);
			// Minting a token nobody can redeem would only leave a workflow waiting out its timeout
			if (recipients.length === 0) return fail(409, { message: 'No member of this team has the permission needed to approve this change' });

			const rawToken = await import('node:crypto').then(({ randomBytes }) => randomBytes(512 / 8));
			const expires = new Date(
				Date.now() +
					// minutes * seconds * milliseconds
					15 * 60 * 1000,
			);
			const instanceId = workflowInstanceId(t_id_hex, uuidv7() as UUID);

			// Sealed before the workflow exists, because sealed is the only shape these credentials may be created with
			const [config, approval] = await Promise.all([sealVaultConfig(rawToken, target), sealApproval(rawToken, { instance: instanceId, action, expires: expires.toISOString() })]);

			await platform.env.VAULT_MIGRATION.create({
				id: instanceId,
				params: { t_id: t_id_hex, action, config },
				// A completed migration's step log is an audit trail, not something worth keeping for a month
				retention: { successRetention: '1 day' },
			});

			// Strict: the emails below are only worth sending if this row actually landed
			await strictTenantDb(t_do, current.tenant.do_id)
				.insert(tenantSchema.verification_tokens)
				.values({
					action,
					// sha512 here, sha256 inside the envelope key - see the column's own note for why they have to differ
					hashed_token: sql`unhex(${await vaultMigrationTokenDigest(rawToken)})`,
					expires,
				});

			const link = new URL(`/${t_id_base64url}/vault`, url.origin);
			link.searchParams.set('token', rawToken.toString('base64url'));
			// Bound to `instanceId` and `action` by construction - see `sealApproval`'s doc comment for why this makes the plaintext `instance` param this link used to carry unnecessary (and unsafe to trust) on the redeeming end
			link.searchParams.set('approval', encodeEnvelope(approval));

			// `allSettled`, not `all`: one address the email binding won't accept must not sink an approval the other admins could still give
			const delivered = await Promise.allSettled(
				recipients.map((to) =>
					platform.env.EMAIL.send({
						headers: {
							'Auto-Submitted': 'auto-generated',
							'Content-Language': 'en',
							...((platform.request ?? request).headers.has('Cf-Ray') && { 'X-Entity-Ref-ID': (platform.request ?? request).headers.get('Cf-Ray')! }),
						},
						from: 'system@eaas.autosec.network',
						to,
						subject: '[Autosec EaaS] Approve a vault migration',
						text: ["A change to your team's secret vault is waiting for approval.", action === TenantVerificationAction['migrate and transfer'] ? 'Every keyring and data key will be copied into the new vault, and the old copies deleted afterwards.' : 'Every keyring and data key will be permanently deleted. They will not be copied into the new vault.', 'If you did not expect this, do not open the link - it expires on its own, and ignoring it cancels the change.', link.toString(), `This link expires in 15 minutes (${expires.toUTCString()}).`].join('\n\n'),
					}),
				),
			);

			const sent = delivered.filter(({ status }) => status === 'fulfilled').length;
			// Every address bounced, so nobody can approve. The workflow and its token are left to expire rather than cleaned up - both do so on their own, in the same 15 minutes.
			if (sent === 0) {
				delivered.forEach((result) => result.status === 'rejected' && console.error('Failed to send vault migration approval email', result.reason));
				return fail(502, { message: 'The approval email could not be delivered to anyone who can approve this change' });
			}

			await logTenantEvent(platform, request, { t_id_hex, jurisdiction: current.tenant.jurisdiction }, session, TenantLogEventType['requested vault migration'], {
				action,
				instance: instanceId,
				recipients: sent,
				to: target.mode,
				// Endpoints and project describe where, never how to get in - the access token is not logged
				...(target.mode === 'bitwarden' && { project: target.project, endpoints: target.endpoints }),
			});

			return { applied: 'pending' as const, action, recipients: sent, expires: expires.toISOString() };
		} catch (error) {
			// What reaches here is a Bitwarden API response or a DB failure. Bitwarden errors quote request metadata, not secret values.
			console.error('Error saving vault connection', error);
			return fail(500, { message: error instanceof Error ? error.message : 'Vault settings could not be saved' });
		}
	},
	zod$({
		vaultMode: z.enum(['managed', 'bitwarden']),
		strategy: z.enum(['token', 'manual', 'transfer', 'delete']),
		baseCloudEndpoint: z.string().trim().url().optional(),
		authCloudEndpoint: z.string().trim().url().optional(),
		accessToken: z.string().trim().nonempty().optional(),
		project: z.string().trim().uuid().optional(),
	}),
);

/**
 * Redeem an approval token and let the waiting migration run.
 *
 * A POST, and only a POST: this is what actually spends the token.
 */
// eslint-disable-next-line qwik/loader-location
const useApproveMigration = routeAction$(
	async (data, { sharedMap, platform, fail, request }) => {
		const session = sharedMap.get('session') as Session;
		const t_db = sharedMap.get('t_db') as SqliteRemoteDatabase;
		const t_id_hex = sharedMap.get('t_id_hex') as string;

		const envelope = decodeEnvelope(data.approval);
		if (!envelope) return fail(400, { message: 'That approval link is malformed' });

		const rawToken = Buffer.from(data.token, 'base64url');

		/**
		 * The only source of truth for `instance` and `action` on this path. `data.instance` doesn't exist anymore as client input precisely because it can't be trusted - a client could send any workflow id it wants alongside a token that's genuinely theirs. Unsealing recovers `instance`/`action` from a blob that only opens under a key derived from `token` itself, so what comes out is bound to whichever request actually minted this specific token.
		 */
		let approval: zm.output<typeof VaultMigrationApprovalSchema>;
		try {
			approval = await unsealApproval(rawToken, envelope);
		} catch {
			return fail(400, { message: 'That approval link is invalid' });
		}

		if (!isTenantWorkflowInstanceId(approval.instance, t_id_hex)) {
			return fail(400, { message: 'That approval link is not for this team' });
		}
		if (new Date(approval.expires).getTime() <= Date.now()) {
			return fail(410, { message: 'That approval link has expired' });
		}

		const hashed_token_hex = await vaultMigrationTokenDigest(rawToken);

		const [you, [pending]] = await Promise.all([
			t_db
				.select({ r_tenant: tenantSchema.users.r_tenant })
				.from(tenantSchema.users)
				.where(and(eq(tenantSchema.users.u_id, sql`unhex(${session.user!.u_id.hex})`), eq(tenantSchema.users.approved, true)))
				.limit(1)
				.then((rows) => rows[0]),
			// Purely a single-use guard at this point - `action` here is only cross-checked against the sealed copy as a defense-in-depth sanity check, not trusted on its own
			t_db
				.select({ action: tenantSchema.verification_tokens.action })
				.from(tenantSchema.verification_tokens)
				.where(and(eq(tenantSchema.verification_tokens.hashed_token, sql`unhex(${hashed_token_hex})`), gt(tenantSchema.verification_tokens.expires, new Date())))
				.limit(1),
		]);

		if (pending?.action !== approval.action) return fail(410, { message: 'That approval link has already been used or has expired' });

		// The email said who should approve; this is what checks who actually did. Mail forwards, and links get pasted into chat.
		if (!you || you.r_tenant < APPROVAL_THRESHOLD[approval.action]) {
			return fail(403, { message: 'Approving this change needs more permission than you have' });
		}

		const tenant = await readTenantRow(sharedMap.get('r_db') as DrizzleD1Database, t_id_hex);

		if (!tenant) return fail(404, { message: 'Tenant not found' });

		// Spend it before releasing the workflow, so a double submit cannot send the event twice - and strictly, because a delete that quietly did nothing would leave this token spendable again
		await strictTenantDb(sharedMap.get('t_do') as ReturnType<EnvVars['TENANT_D0']['get']>, tenant.do_id)
			.delete(tenantSchema.verification_tokens)
			.where(eq(tenantSchema.verification_tokens.hashed_token, sql`unhex(${hashed_token_hex})`));

		try {
			const instance = await platform.env.VAULT_MIGRATION.get(approval.instance);
			await instance.sendEvent({ type: VAULT_MIGRATION_APPROVAL_EVENT, payload: { token: data.token } });
		} catch (error) {
			// The token is spent either way - it was single-use, and re-offering it after a failed release would be worse than making them start over
			console.error('Error releasing vault migration workflow', error);
			await logTenantEvent(platform, request, { t_id_hex, jurisdiction: tenant.jurisdiction }, session, TenantLogEventType['approved vault migration'], { action: approval.action, instance: approval.instance }, TenantLogEventStatus.error);
			return fail(502, { message: 'The migration could not be started. Please request the change again.' });
		}

		await logTenantEvent(platform, request, { t_id_hex, jurisdiction: tenant.jurisdiction }, session, TenantLogEventType['approved vault migration'], { action: approval.action, instance: approval.instance });

		return { approved: true, action: approval.action };
	},
	zod$({
		token: z.string().trim().nonempty(),
		approval: z.string().trim().nonempty(),
	}),
);

const cardClass = 'border-surface-light/60 dark:border-surface-dark/60 dark:bg-surface-dark/70 rounded-2xl border bg-white/70 p-6 shadow-sm backdrop-blur-md';

export default component$(() => {
	const locale = getLocale();
	const timezone = useTimezone();
	const location = useLocation();
	const overview = useVaultOverview();
	const connection = useVaultConnection();
	const approval = useMigrationApproval();
	const rescan = useRescanVault();
	const save = useSaveVaultConnection();
	const approve = useApproveMigration();

	return (
		<div class="mx-auto w-full max-w-5xl px-6 py-10">
			<div class="mb-8">
				<h1 class="text-2xl font-bold tracking-tight text-gray-900 dark:text-white">{m.vault_page_title()}</h1>
				<p class="mt-1 text-sm text-gray-500 dark:text-gray-400">{m.vault_page_subtitle()}</p>
			</div>

			{/*
			 * Someone followed an approval link. Nothing has been spent by getting here - the button below is what does that.
			 *
			 * The outcome is rendered *outside* the loader on purpose: redeeming the token deletes its row, so by the time the action returns, the loader that produced this banner resolves to `null`. Reporting the result from inside it would make both success and failure vanish the instant they happened.
			 */}
			{approve.value?.approved ? (
				<section class={[cardClass, 'mb-6', 'border-green-300', 'dark:border-green-700']}>
					<h2 class="text-lg font-semibold text-gray-900 dark:text-white">{m.vault_approval_title()}</h2>
					<p class="mt-2 text-sm text-green-700 dark:text-green-300">{m.vault_approval_done()}</p>
				</section>
			) : (
				<>
					{approve.value?.failed ? (
						<section class={[cardClass, 'mb-6', 'border-red-300', 'dark:border-red-700']}>
							<p class="text-sm text-red-700 dark:text-red-300">
								{m.vault_approval_failed()} <span class="font-mono">{approve.value.message}</span>
							</p>
						</section>
					) : null}

					<Resource
						value={approval}
						onPending={() => null}
						onRejected={() => null}
						onResolved={(pending) =>
							pending === null ? null : (
								<section class={[cardClass, 'mb-6', 'border-amber-300', 'dark:border-amber-700']}>
									<h2 class="text-lg font-semibold text-gray-900 dark:text-white">{m.vault_approval_title()}</h2>
									<p class="mt-1 text-sm text-gray-500 dark:text-gray-400">{pending.action === TenantVerificationAction['migrate and delete'] ? m.vault_approval_body_delete() : m.vault_approval_body_transfer()}</p>
									<p class="mt-2 text-xs text-amber-600 dark:text-amber-400">{m.vault_config_new_id_notice()}</p>
									<p class="mt-2 text-xs text-gray-400 dark:text-gray-500">
										{m.vault_approval_expires()}{' '}
										<time dateTime={pending.expires} title={`${new Date(pending.expires).toLocaleString(locale, { hour12: false, timeZone: 'UTC' })} UTC`}>
											{`${new Date(pending.expires).toLocaleString(locale, { timeZone: timezone.value.long })} ${timezone.value.short}`}
										</time>
									</p>

									{pending.allowed ? (
										<Form action={approve} class="mt-4">
											<input type="hidden" name="token" value={location.url.searchParams.get('token') ?? ''} />
											<input type="hidden" name="approval" value={location.url.searchParams.get('approval') ?? ''} />
											<button type="submit" disabled={approve.isRunning} class="inline-flex cursor-pointer items-center justify-center gap-2 rounded-xl bg-amber-600 px-4 py-2.5 text-sm font-medium text-white transition-all duration-150 hover:bg-amber-700 hover:shadow-md active:scale-[0.98] disabled:cursor-wait disabled:opacity-60">
												{approve.isRunning ? (
													<>
														<LuLoader class="h-4 w-4 animate-spin" />
														{m.vault_approval_running()}
													</>
												) : (
													m.vault_approval_confirm()
												)}
											</button>
										</Form>
									) : (
										<p class="mt-4 text-xs text-amber-600 dark:text-amber-400">{m.vault_approval_denied()}</p>
									)}
								</section>
							)
						}
					/>
				</>
			)}

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

							{/* Change where it lives */}
							<section class={cardClass}>
								<h2 class="text-lg font-semibold text-gray-900 dark:text-white">{m.vault_config_title()}</h2>
								<p class="mt-1 mb-4 text-sm text-gray-500 dark:text-gray-400">{m.vault_config_body()}</p>

								<Resource
									value={connection}
									onPending={() => <div class="h-64 animate-pulse rounded-xl bg-gray-200 dark:bg-gray-700" />}
									onRejected={(error) => <p class="text-sm text-red-600">{error instanceof Error ? error.message : m.vault_config_failed()}</p>}
									onResolved={(current) =>
										current === null ? (
											<p class="text-sm text-gray-500 dark:text-gray-400">{m.vault_no_access()}</p>
										) : (
											<>
												<Form action={save}>
													<VaultConnectionFields current={current} isRunning={save.isRunning} />
												</Form>

												{save.value?.failed ? (
													<div class="mt-4 rounded-lg border border-red-200 bg-red-50 p-3 text-sm text-red-700 dark:border-red-800 dark:bg-red-900/30 dark:text-red-300">
														{m.vault_config_failed()} <span class="font-mono">{save.value.message}</span>
													</div>
												) : null}

												{save.value?.applied === 'pending' ? (
													<div class="mt-4 rounded-lg border border-amber-200 bg-amber-50 p-3 text-sm text-amber-700 dark:border-amber-800 dark:bg-amber-900/30 dark:text-amber-300">
														<p>{m.vault_config_saved_pending({ recipients: save.value.recipients })}</p>
														<p class="mt-1 text-xs">
															{m.vault_approval_expires()}{' '}
															<time dateTime={save.value.expires} title={`${new Date(save.value.expires).toLocaleString(locale, { hour12: false, timeZone: 'UTC' })} UTC`}>
																{`${new Date(save.value.expires).toLocaleString(locale, { timeZone: timezone.value.long })} ${timezone.value.short}`}
															</time>
														</p>
													</div>
												) : save.value?.applied ? (
													<p class="mt-4 rounded-lg border border-green-200 bg-green-50 p-3 text-sm text-green-700 dark:border-green-800 dark:bg-green-900/30 dark:text-green-300">{save.value.applied === 'manual' ? m.vault_config_saved_manual() : m.vault_config_saved_token()}</p>
												) : null}
											</>
										)
									}
								/>
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
