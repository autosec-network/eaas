import { WorkflowEntrypoint, type WorkflowEvent, type WorkflowStep, type WorkflowStepConfig } from 'cloudflare:workers';
import { NonRetryableError } from 'cloudflare:workflows';
import type { TenantByoBwNoteSchema } from 'db';
import { DebugLogWriter, drizzleD0, StaticDatabase } from 'db/core';
import * as rootSchema from 'db/schemas/root';
import * as logsSchema from 'db/schemas/tenant/logs';
import * as tenantSchema from 'db/schemas/tenant/main';
import { drizzle } from 'drizzle-orm/d1';
import { DefaultLogger } from 'drizzle-orm/logger';
import { asc, eq, gt, sql } from 'drizzle-orm/sql';
import type { SqliteRemoteDatabase } from 'drizzle-orm/sqlite-proxy';
import { hexToUuid } from 'helpers';
import { unsealVaultConfig, VAULT_MIGRATION_APPROVAL_EVENT, VaultMigrationParamsSchema } from 'helpers/vault-migration';
import { Buffer } from 'node:buffer';
import type { UUID } from 'node:crypto';
import { DOJurisdictions } from 'types';
import { BitwardenCloudEndpoints } from 'types/bw';
import { TenantLogEventStatus, TenantLogEventType, TenantLogQueueMessageSchema } from 'types/tenants/logging';
import { TenantVerificationAction } from 'types/tenants/verification';
import { v7 as uuidv7 } from 'uuid';
import * as zm from 'zod/mini';
import type { EnvVars } from '~/types';

/**
 * Defined in `helpers/vault-migration` rather than here: the dashboard builds this payload and this workflow parses it, from two different workers, so a single definition is the only thing keeping them in step.
 */
export const workflowParams = VaultMigrationParamsSchema;

type BitwardenStub = ReturnType<EnvVars['BITWARDEN_SESSION']['get']>;
type TenantStub = ReturnType<EnvVars['TENANT_D0']['get']>;
type LogsStub = ReturnType<EnvVars['TENANT_D0_LOGS']['get']>;

/**
 * One vault secret proven to belong to a given tenant, by its decrypted key path.
 */
interface OwnedSecret {
	bw_id: UUID;
	kr_id_base64url: string;
	dk_id_base64url: string;
}

/**
 * How many `decryptSecret` round trips to the session Durable Object to keep in flight at once. Identical reasoning to the dashboard's vault rescan: in our managed organization the secret listing spans every tenant, so an unbounded fan-out would be thousands of concurrent RPCs.
 */
const DECRYPT_CONCURRENCY = 25;

/**
 * How many single-row statements to put in one `batch()`. Durable Object SQLite caps bound parameters **per statement**, but a transaction with thousands of statements is its own CPU cliff, so the clone walks the tables in chunks.
 */
const WRITE_CHUNK = 50;

/**
 * Rows of audit log to pull per read. A busy tenant's log dwarfs every other table here, and `sqlExec` materializes a whole result set into memory per call.
 */
const LOG_PAGE = 500;

const chunked = <T>(items: T[], size: number): T[][] =>
	items.reduce<T[][]>((acc, item, index) => {
		if (index % size === 0) acc.push([]);
		acc[acc.length - 1]!.push(item);
		return acc;
	}, []);

/**
 * `BitwardenSession.decryptSecret` is overloaded (the `iv: true` form returns an object), and Durable Object RPC collapses overloads into a union of every return type. Every call here wants the plain string form, so the narrowing happens once, here, instead of at a dozen call sites.
 */
const decryptOne = async (stub: BitwardenStub, accessToken: string, cipherText: string) =>
	// RPC keeps only the last overload, whose `iv` is typed as the literal `true`. The implementation behind it takes `iv?: boolean` and returns the plain string for anything falsy, so `false` is the right runtime argument even though the collapsed signature can't say so.
	(await stub.decryptSecret(accessToken, cipherText, false as true)) as unknown as string;

/**
 * Same story for `encryptSecret`: its trailing `iv`/`version` parameters carry defaults that don't survive the RPC type mapping, so the optional arguments have to be passed explicitly.
 */
const encryptOne = (stub: BitwardenStub, accessToken: string, plainText: string) => stub.encryptSecret(accessToken, plainText, undefined);

/**
 * Decrypt many ciphertexts {@link DECRYPT_CONCURRENCY} at a time. An undecryptable entry yields `undefined` instead of rejecting: in the managed vault the listing covers other tenants' secrets, so "not ours" is the expected outcome rather than a failure. The rejection itself is never logged - it carries the ciphertext.
 */
const decryptAll = (stub: BitwardenStub, accessToken: string, cipherTexts: string[]): Promise<(string | undefined)[]> => chunked(cipherTexts, DECRYPT_CONCURRENCY).reduce<Promise<(string | undefined)[]>>(async (acc, chunk) => [...(await acc), ...(await Promise.all(chunk.map((cipherText) => decryptOne(stub, accessToken, cipherText).catch(() => undefined))))], Promise.resolve([]));

/**
 * Run single-row writes through `batch()` in {@link WRITE_CHUNK}-sized transactions, in order.
 */
const writeChunked = (db: SqliteRemoteDatabase, writes: ReturnType<SqliteRemoteDatabase['run']>[]) => chunked(writes, WRITE_CHUNK).reduce<Promise<unknown>>((acc, chunk) => acc.then(() => db.batch(chunk as [(typeof chunk)[number], ...(typeof chunk)[number][]])), Promise.resolve());

/**
 * Atomic, copy-on-write migration of a tenant onto a different secret vault.
 *
 * Changing which vault holds a tenant's key material can't be done in place - the keyrings and datakeys have to exist in the destination before the source can be torn down, and a half-finished move would leave a tenant whose database points at secrets that aren't there. So instead of mutating the tenant, this builds a **second** tenant beside it, copies everything across, cuts the root references over, and only then destroys the original. Every intermediate state is one the tenant can be left in indefinitely.
 *
 * The vault credentials it needs are sealed in {@link workflowParams.config} and only openable with the token emailed to the tenant's admins, which arrives via {@link VAULT_MIGRATION_APPROVAL_EVENT}. Nothing runs before that event, and nothing that touches the unsealed config ever returns it - Cloudflare persists step output in plaintext.
 */
export class VaultMigration extends WorkflowEntrypoint<EnvVars, zm.input<typeof workflowParams>> {
	private static readonly cfApiCallRetry: WorkflowStepConfig = {
		retries: {
			/**
			 * CF global rate limit is 1200/5m
			 * @link https://developers.cloudflare.com/fundamentals/api/reference/limits/
			 */
			delay: 5 * 60 * 1000,
			/**
			 * days * hours * minutes / delay
			 */
			limit: (3 * 24 * 60) / 5,
			backoff: 'constant',
		},
	};
	private static readonly bitwardenCallRetry: WorkflowStepConfig = {
		retries: {
			delay: ({ error }) => {
				// Bitwarden api rate limit is 500/1m (1 * 60 * 1000)
				const bitwardenBaseDelayMs = 60_000 as const;

				try {
					/**
					 * BitwardenSession (do/BitwardenSession.ts) throws errors whose `message` is a JSON blob carrying the raw Bitwarden response `headers`. If the `x-rate-limit-reset` header is present, wait until then instead of the base delay whenever that's the longer of the two.
					 */
					const headers = new Headers((JSON.parse(error.message) as { headers?: Record<string, string> }).headers);
					const reset = headers.get('x-rate-limit-reset');
					if (reset) {
						const msUntilReset = new Date(reset).getTime() - Date.now();
						return Math.max(bitwardenBaseDelayMs, msUntilReset);
					}
					// eslint-disable-next-line @typescript-eslint/no-unused-vars
				} catch (_err) {
					// error.message wasn't a BitwardenSession API error payload (e.g. a network error) - fall back to the base delay
				}

				return bitwardenBaseDelayMs;
			},
			/**
			 * days * hours * minutes / delay
			 */
			limit: (3 * 24 * 60) / 1,
			backoff: 'constant',
		},
		/**
		 * Every Bitwarden step here fans out over the whole vault, so the 10 minute default is the wrong shape - a large tenant's clone is many hundreds of sequential round trips.
		 */
		timeout: '30 minutes',
		sensitive: 'output',
	};

	private r_db() {
		return drizzle(this.env.DB_ROOT.withSession('first-unconstrained') as unknown as D1Database, {
			logger: new DefaultLogger({ writer: new DebugLogWriter(this.env.ENVIRONMENT === 'production' ? StaticDatabase.Root.eaas_root_prod : StaticDatabase.Root.eaas_root_dev) }),
		});
	}

	/**
	 * A tenant DO's Drizzle handle, with `throwOnError` on. The default swallows a failed statement into an empty result set, which in a migration is indistinguishable from a successful write - a step would report success having copied nothing. Caching is deliberately omitted: every table here is read exactly once.
	 */
	private t_db(stub: TenantStub | LogsStub, do_id_hex: string) {
		return drizzleD0(stub, {
			throwOnError: true,
			logger: new DefaultLogger({ writer: new DebugLogWriter(do_id_hex) }),
		});
	}

	private tenantStubFromId(jurisdiction: DOJurisdictions | null, do_id_hex: string) {
		return this.env.TENANT_D0.get((jurisdiction ? this.env.TENANT_D0.jurisdiction(jurisdiction) : this.env.TENANT_D0).idFromString(do_id_hex));
	}

	/**
	 * A tenant's audit log Durable Object. Its id is never stored anywhere - it's always derived from the tenant id as `<hyphenated t_id>_logs`, which is exactly what lets a new tenant's logs DO be addressed before it exists.
	 */
	private logsStubFromName(jurisdiction: DOJurisdictions | null, t_id_utf8: string) {
		return this.env.TENANT_D0_LOGS.get((jurisdiction ? this.env.TENANT_D0_LOGS.jurisdiction(jurisdiction) : this.env.TENANT_D0_LOGS).idFromName(`${t_id_utf8}_logs`));
	}

	/**
	 * Open an authenticated, single-use Bitwarden Secrets Manager session. The caller owns closing it with {@link closeBitwardenSession}.
	 *
	 * `log_t_id_hex` is whichever tenant this session's activity should be attributed to in the audit row the session logs on open/close - not necessarily the tenant whose vault it's talking to, though it usually is. The session logs itself (see `BitwardenSession.logSessionEvent`) straight onto the `eaas-logs-*` queue; a message for a tenant that no longer exists by the time it's processed - e.g. 'Delete old tenant' having already nuked the old tenant's logs DO - is the queue consumer's problem to filter out, not this workflow's to avoid by misattributing rows (see `workers/api/src/queue.ts`).
	 */
	private async openBitwardenSession(log_t_id_hex: string, jurisdiction: DOJurisdictions | null, t_do_id_hex: string, endpoints: { base: string; authentication: string }, accessToken: string) {
		const stub = this.env.BITWARDEN_SESSION.get((jurisdiction ? this.env.BITWARDEN_SESSION.jurisdiction(jurisdiction) : this.env.BITWARDEN_SESSION).newUniqueId());

		await stub.init({
			t_jurisdiction: jurisdiction,
			t_do_id: (() => {
				const mainBuffer = Buffer.from(t_do_id_hex, 'hex');
				return mainBuffer.buffer.slice(mainBuffer.byteOffset, mainBuffer.byteOffset + mainBuffer.byteLength);
			})(),
			t_id: log_t_id_hex,
			// No human session inside a Workflow
			u_id: null,
			ak_id: null,
			endpoints,
		});
		await stub.auth(accessToken);

		return stub;
	}

	/**
	 * Close a session opened by {@link openBitwardenSession}. The session logs its own close audit row internally (see `BitwardenSession.nuke`), so this just schedules the wipe - `ctx.waitUntil`'d since nothing here depends on it finishing first.
	 */
	private closeBitwardenSession(stub: BitwardenStub, reason: string) {
		this.ctx.waitUntil(stub.nuke(reason));
	}

	private rootEndpoints(jurisdiction: DOJurisdictions | null) {
		return {
			base: jurisdiction === DOJurisdictions['The European Union'] ? BitwardenCloudEndpoints.Api.eu : BitwardenCloudEndpoints.Api.us,
			authentication: jurisdiction === DOJurisdictions['The European Union'] ? BitwardenCloudEndpoints.Identity.eu : BitwardenCloudEndpoints.Identity.us,
		};
	}

	private rootAccessToken(jurisdiction: DOJurisdictions | null) {
		return jurisdiction === DOJurisdictions['The European Union'] ? this.env.EU_BW_SM_ACCESS_TOKEN : this.env.US_BW_SM_ACCESS_TOKEN;
	}

	private rootProjectId(jurisdiction: DOJurisdictions | null) {
		return jurisdiction === DOJurisdictions['The European Union'] ? this.env.EU_BW_SM_PROJECT_ID : this.env.US_BW_SM_PROJECT_ID;
	}

	/**
	 * Resolve where a tenant's key material actually lives - our organization, or theirs - and hand back an authenticated session on it plus the token that decrypts its contents.
	 *
	 * `byo_bw` is the id of a secret in *our* organization whose value is the tenant's own access token, so reaching a BYO vault always costs two sessions. Both are returned so the caller can nuke them.
	 */
	private async openTenantVault(log_t_id_hex: string, jurisdiction: DOJurisdictions | null, t_do_id_hex: string, byo_bw: string | null | undefined) {
		const rootToken = this.rootAccessToken(jurisdiction);
		const rootStub = await this.openBitwardenSession(log_t_id_hex, jurisdiction, t_do_id_hex, this.rootEndpoints(jurisdiction), rootToken);

		if (!byo_bw) {
			return { stub: rootStub, token: rootToken, projectId: this.rootProjectId(jurisdiction), sessions: [rootStub], byo: false as const };
		}

		const [connection] = await rootStub.getSecrets([byo_bw]);
		if (!connection) {
			this.ctx.waitUntil(rootStub.nuke('Vault migration: BYO connection missing'));
			throw new NonRetryableError('BYO Bitwarden connection secret not found');
		}

		const note = JSON.parse(await decryptOne(rootStub, rootToken, connection.note)) as zm.output<typeof TenantByoBwNoteSchema>;
		const token = await decryptOne(rootStub, rootToken, connection.value);
		const stub = await this.openBitwardenSession(log_t_id_hex, jurisdiction, t_do_id_hex, note.endpoints, token);

		return { stub, token, projectId: note.project, sessions: [rootStub, stub], byo: true as const };
	}

	/**
	 * Every secret in `vault` whose decrypted key path says it belongs to `t_id_base64url`.
	 *
	 * Key paths only, on purpose. In the managed organization this listing spans every tenant's secrets, so nothing may fetch a secret's *value* until its path has proven it belongs to this tenant. `<t_id>/bw` (the BYO connection) is excluded here and handled separately - it isn't key material.
	 */
	private async ownedSecrets(stub: BitwardenStub, token: string, t_id_base64url: string) {
		const { secrets } = await stub.getSecretsAndProjects();
		const paths = await decryptAll(
			stub,
			token,
			secrets.map(({ key }) => key),
		);

		return paths.reduce<OwnedSecret[]>((acc, path, index) => {
			const [t, kr, dk, ...rest] = (path ?? '').split('/');

			if (rest.length === 0 && t === t_id_base64url && kr && dk) {
				acc.push({ bw_id: secrets[index]!.id, kr_id_base64url: kr, dk_id_base64url: dk });
			}

			return acc;
		}, []);
	}

	override async run(event: Readonly<WorkflowEvent<zm.input<typeof workflowParams>>>, step: WorkflowStep) {
		// First step: always parse params with Zod for validation
		const parsedPayload = await step.do('Parse workflow params', () =>
			workflowParams.safeParseAsync(typeof event.payload === 'string' ? JSON.parse(event.payload) : event.payload).then((result) => {
				if (result.success) {
					return result.data;
				} else {
					throw new NonRetryableError(`${result.error.message}: ${zm.prettifyError(result.error)}`);
				}
			}),
		);

		/**
		 * Nothing below this line runs until a tenant admin opens the emailed link.
		 *
		 * The raw token comes back as this step's output, which Cloudflare persists in plaintext. That's accepted here and nowhere else: the token is single-use (the dashboard deletes its row before sending the event), dies with the 15 minute window, and grants nothing beyond unsealing parameters that are themselves already in this instance's storage. `waitForEvent` takes no `sensitive` option - only `step.do` does - so the redaction that would normally accompany this can't be applied.
		 */
		const approval = await step.waitForEvent<{ token: string }>('Await migration approval', { type: VAULT_MIGRATION_APPROVAL_EVENT, timeout: '15 minutes' });
		const rawToken = Buffer.from(approval.payload.token, 'base64url');

		const oldTenant = await step.do('Look up tenant', VaultMigration.cfApiCallRetry, async () => {
			const [row] = await this.r_db()
				.select({ jurisdiction: rootSchema.tenants.jurisdiction, do_id: rootSchema.tenants.do_id })
				.from(rootSchema.tenants)
				.where(eq(rootSchema.tenants.t_id, sql`unhex(${parsedPayload.t_id.hex})`))
				.limit(1)
				.then((rows) => rows.map((row) => ({ ...row, do_id: row.do_id.toString('hex') })));

			if (!row) throw new NonRetryableError('Tenant not found');
			return row;
		});

		const oldStub = this.tenantStubFromId(oldTenant.jurisdiction, oldTenant.do_id);
		const old_db = this.t_db(oldStub, oldTenant.do_id);

		/**
		 * Flattened to plain JSON on the way out: `getProperties` hands back a `Partial<>` of a Zod schema (and an `ArrayBuffer` for the noise key), none of which a step is allowed to persist as-is.
		 */
		const oldProperties = await step.do('Read tenant properties', VaultMigration.cfApiCallRetry, async () => {
			const properties = await oldStub.getProperties({ name: true, avatar: true, byo_bw: true, noise_static_public: true, noise_bw: true });

			return {
				name: properties.name ?? '',
				avatar: properties.avatar ?? null,
				byo_bw: properties.byo_bw ?? null,
				noise_static_public: properties.noise_static_public ? Buffer.from(properties.noise_static_public).toString('base64url') : null,
				noise_bw: properties.noise_bw ?? null,
			};
		});

		/**
		 * Step 3 - the new tenant, root references included. Named with a `new_<instance id>` suffix so a run that dies midway leaves something obviously provisional rather than a convincing duplicate of the tenant beside it.
		 */
		const newTenant = await step.do('Create new tenant', VaultMigration.cfApiCallRetry, async () => {
			// Derived from the instance id rather than freshly minted, because a step body re-runs from the top on retry. A `uuidv7()` here would hand out a different tenant on every attempt and orphan the rows the last one already wrote; the instance id's trailing half is itself a UUIDv7, and it doesn't change.
			const utf8 = hexToUuid(event.instanceId.slice(32));
			const hex = utf8.replaceAll('-', '');
			const buffer = Buffer.from(hex, 'hex');
			const do_id = (oldTenant.jurisdiction ? this.env.TENANT_D0.jurisdiction(oldTenant.jurisdiction) : this.env.TENANT_D0).idFromName(utf8).toString();

			const r_db = this.r_db();
			const members = await r_db
				.select({ u_id: rootSchema.users_tenants.u_id })
				.from(rootSchema.users_tenants)
				.where(eq(rootSchema.users_tenants.t_id, sql`unhex(${parsedPayload.t_id.hex})`))
				.then((rows) => rows.map(({ u_id }) => u_id.toString('hex')));

			// `onConflictDoNothing` throughout, so a retry after a partial write finishes the job instead of colliding with itself
			await r_db.batch([
				r_db
					.insert(rootSchema.tenants)
					.values({
						t_id: sql`unhex(${hex})`,
						jurisdiction: oldTenant.jurisdiction,
						do_id: sql`unhex(${do_id})`,
					})
					.onConflictDoNothing(),
				...members.map((u_id_hex) =>
					r_db
						.insert(rootSchema.users_tenants)
						.values({
							t_id: sql`unhex(${hex})`,
							u_id: sql`unhex(${u_id_hex})`,
						})
						.onConflictDoNothing(),
				),
			]);

			return { utf8, hex, base64url: buffer.toString('base64url'), do_id, members: members.length };
		});

		const newStub = this.tenantStubFromId(oldTenant.jurisdiction, newTenant.do_id);
		const new_db = this.t_db(newStub, newTenant.do_id);

		/**
		 * The tenant's own settings, carried over verbatim apart from the provisional name. `byo_bw` is deliberately *not* copied - it names the old vault, and the sealed config decides what the new one is. The noise keypair pointers are: they name secrets in our root organization, which a change of tenant vault doesn't move.
		 */
		await step.do('Seed new tenant properties', VaultMigration.cfApiCallRetry, () =>
			newStub
				.updateProperties({
					name: `${oldProperties.name}new_${event.instanceId}`,
					avatar: oldProperties.avatar,
					noise_static_public: oldProperties.noise_static_public
						? (() => {
								const buffer = Buffer.from(oldProperties.noise_static_public, 'base64url');
								return buffer.buffer.slice(buffer.byteOffset, buffer.byteOffset + buffer.byteLength);
							})()
						: undefined,
					noise_bw: oldProperties.noise_bw,
					m_time: new Date(),
				})
				.then(() => {}),
		);

		/**
		 * `migrate and delete` walks the same path as `migrate and transfer` right up to the point where key material would be carried across, and then simply doesn't carry it. The tenant, its members, its API keys and its settings all survive; the keyrings, datakeys and the permission rows that reference them do not.
		 */
		const carryKeyMaterial = parsedPayload.action === TenantVerificationAction['migrate and transfer'];

		// Steps 4 & 5 - independent: the tenant's database, its audit log, and its vault are three separate stores. All three only need the new tenant to exist.
		const [, , clonedSecrets] = await Promise.all([
			/**
			 * The audit trail is the one thing here whose value *is* its continuity, so a migration that dropped it would be worse than one that failed. Only `logs` comes across: the new object schedules its own system alarms, and the websocket tables are live-connection state belonging to sessions that ended when the old object did.
			 *
			 * Read in pages ordered by primary key. A busy tenant's log is the largest table in this workflow by a wide margin, and `sqlExec` materializes a whole result set per call.
			 */
			step.do('Clone audit log', VaultMigration.cfApiCallRetry, async () => {
				const old_logs_db = this.t_db(this.logsStubFromName(oldTenant.jurisdiction, parsedPayload.t_id.utf8), `${parsedPayload.t_id.hex}_logs`);
				const new_logs_db = this.t_db(this.logsStubFromName(oldTenant.jurisdiction, newTenant.utf8), `${newTenant.hex}_logs`);

				const copyPage = async (after: string | null, copied: number): Promise<number> => {
					const page = await old_logs_db
						.select()
						.from(logsSchema.logs)
						.where(after ? gt(logsSchema.logs.id, sql`unhex(${after})`) : undefined)
						.orderBy(asc(logsSchema.logs.id))
						.limit(LOG_PAGE);

					if (page.length === 0) return copied;

					await writeChunked(
						new_logs_db,
						page.map((row) =>
							new_logs_db
								.insert(logsSchema.logs)
								.values({
									...row,
									id: sql`unhex(${row.id.toString('hex')})`,
									ray_id: row.ray_id ? sql`unhex(${row.ray_id.toString('hex')})` : null,
									u_id: row.u_id ? sql`unhex(${row.u_id.toString('hex')})` : null,
									ak_id: row.ak_id ? sql`unhex(${row.ak_id.toString('hex')})` : null,
									kr_id: row.kr_id ? sql`unhex(${row.kr_id.toString('hex')})` : null,
									dk_id: row.dk_id ? sql`unhex(${row.dk_id.toString('hex')})` : null,
								})
								.onConflictDoNothing(),
						) as unknown as ReturnType<SqliteRemoteDatabase['run']>[],
					);

					// Ids are UUIDv7, so ordering by them is chronological and the cursor can't skip a row written mid-copy
					return page.length < LOG_PAGE ? copied + page.length : copyPage(page[page.length - 1]!.id.toString('hex'), copied + page.length);
				};

				return { logs: await copyPage(null, 0) };
			}),
			step.do('Clone tenant database', VaultMigration.cfApiCallRetry, async () => {
				const [alarms, users, apiKeys, keyrings, datakeys, usersKeyrings, apiKeysKeyrings] = await Promise.all([carryKeyMaterial ? old_db.select().from(tenantSchema.alarms) : Promise.resolve([]), old_db.select().from(tenantSchema.users), old_db.select().from(tenantSchema.api_keys), carryKeyMaterial ? old_db.select().from(tenantSchema.keyrings) : Promise.resolve([]), carryKeyMaterial ? old_db.select().from(tenantSchema.datakeys) : Promise.resolve([]), carryKeyMaterial ? old_db.select().from(tenantSchema.users_keyrings) : Promise.resolve([]), carryKeyMaterial ? old_db.select().from(tenantSchema.api_keys_keyrings) : Promise.resolve([])]);

				// The new DO scheduled its own system alarms while it was migrating, and they carry fixed ids - re-inserting the old rows would collide on the primary key. Everything else (rotation schedules and the like) has to come across, but only when the keyrings they rotate do: a `migrate and delete` that carried the crons over would leave them firing forever against keyrings that no longer exist.
				const existingAlarmIds = await new_db
					.select({ id: tenantSchema.alarms.id })
					.from(tenantSchema.alarms)
					.then((rows) => new Set(rows.map(({ id }) => id.toString('hex'))));

				// Ordered so a row never lands before the row its foreign key points at
				const writes: ReturnType<SqliteRemoteDatabase['run']>[] = [
					...alarms
						.filter((alarm) => !existingAlarmIds.has(alarm.id.toString('hex')))
						.map((alarm) =>
							new_db
								.insert(tenantSchema.alarms)
								.values({ ...alarm, id: sql`unhex(${alarm.id.toString('hex')})` })
								.onConflictDoNothing(),
						),
					...users.map((user) =>
						new_db
							.insert(tenantSchema.users)
							.values({ ...user, u_id: sql`unhex(${user.u_id.toString('hex')})`, do_id: sql`unhex(${user.do_id.toString('hex')})` })
							.onConflictDoNothing(),
					),
					...apiKeys.map((apiKey) =>
						new_db
							.insert(tenantSchema.api_keys)
							.values({ ...apiKey, ak_id: sql`unhex(${apiKey.ak_id.toString('hex')})`, hash: sql`unhex(${apiKey.hash.toString('hex')})` })
							.onConflictDoNothing(),
					),
					...keyrings.map((keyring) =>
						new_db
							.insert(tenantSchema.keyrings)
							.values({ ...keyring, kr_id: sql`unhex(${keyring.kr_id.toString('hex')})`, count_rotation: keyring.count_rotation ? sql`unhex(${keyring.count_rotation.toString('hex')})` : null })
							.onConflictDoNothing(),
					),
					// `bw_id` is left null on purpose - the secrets it would point at are being rewritten into the destination vault right now, and 'Relink datakeys' fills it in from that step's output
					...datakeys.map((datakey) =>
						new_db
							.insert(tenantSchema.datakeys)
							.values({ ...datakey, dk_id: sql`unhex(${datakey.dk_id.toString('hex')})`, kr_id: sql`unhex(${datakey.kr_id.toString('hex')})`, bw_id: null, generation_count: sql`unhex(${datakey.generation_count.toString('hex')})` })
							.onConflictDoNothing(),
					),
					...usersKeyrings.map((row) =>
						new_db
							.insert(tenantSchema.users_keyrings)
							.values({ ...row, u_id: sql`unhex(${row.u_id.toString('hex')})`, kr_id: sql`unhex(${row.kr_id.toString('hex')})` })
							.onConflictDoNothing(),
					),
					...apiKeysKeyrings.map((row) =>
						new_db
							.insert(tenantSchema.api_keys_keyrings)
							.values({ ...row, ak_id: sql`unhex(${row.ak_id.toString('hex')})`, kr_id: sql`unhex(${row.kr_id.toString('hex')})` })
							.onConflictDoNothing(),
					),
				] as unknown as ReturnType<SqliteRemoteDatabase['run']>[];

				await writeChunked(new_db, writes);

				return { alarms: alarms.length, users: users.length, apiKeys: apiKeys.length, keyrings: keyrings.length, datakeys: datakeys.length };
			}),
			step.do('Clone vault secrets', VaultMigration.bitwardenCallRetry, async () => {
				if (!carryKeyMaterial) return [] as { dk_id_hex: string; bw_id_hex: string }[];

				const config = await unsealVaultConfig(rawToken, parsedPayload.config);
				const source = await this.openTenantVault(parsedPayload.t_id.hex, oldTenant.jurisdiction, oldTenant.do_id, oldProperties.byo_bw);

				// The destination is whatever the sealed config describes: back onto our organization, or onto the tenant's own
				const destination = config.mode === 'managed' ? { stub: await this.openBitwardenSession(newTenant.hex, oldTenant.jurisdiction, newTenant.do_id, this.rootEndpoints(oldTenant.jurisdiction), this.rootAccessToken(oldTenant.jurisdiction)), token: this.rootAccessToken(oldTenant.jurisdiction), projectId: this.rootProjectId(oldTenant.jurisdiction) } : { stub: await this.openBitwardenSession(newTenant.hex, oldTenant.jurisdiction, newTenant.do_id, config.endpoints, config.accessToken), token: config.accessToken, projectId: config.project };

				try {
					const owned = await this.ownedSecrets(source.stub, source.token, parsedPayload.t_id.base64url);
					if (owned.length === 0) return [];

					/**
					 * A retry re-enters this closure from the top, so anything a previous attempt already wrote has to be recognised rather than written again. Bitwarden happily accepts a duplicate key, and duplicates here would be orphans forever: 'Relink datakeys' can only point a row at one of them, and the loser is a copy of live key material nothing references.
					 *
					 * The destination is listed by the *new* tenant's prefix, which nothing but this step ever writes - so a hit is always our own earlier attempt.
					 */
					const existing = new Map((await this.ownedSecrets(destination.stub, destination.token, newTenant.base64url)).map((secret) => [`${secret.kr_id_base64url}/${secret.dk_id_base64url}`, secret.bw_id]));

					const alreadyCopied = owned.flatMap((secret) => {
						const bw_id = existing.get(`${secret.kr_id_base64url}/${secret.dk_id_base64url}`);
						return bw_id ? [{ dk_id_hex: Buffer.from(secret.dk_id_base64url, 'base64url').toString('hex'), bw_id_hex: bw_id.replaceAll('-', '') }] : [];
					});
					const remaining = owned.filter((secret) => !existing.has(`${secret.kr_id_base64url}/${secret.dk_id_base64url}`));

					if (remaining.length === 0) return alreadyCopied;

					// Safe now: every id below was proven to be this tenant's above
					const details = await source.stub.getSecrets(remaining.map(({ bw_id }) => bw_id));
					const byId = new Map(remaining.map((secret) => [secret.bw_id, secret]));

					// One secret at a time through the destination, sequentially per chunk, so a big tenant doesn't stampede either organization's rate limit
					return chunked(details, DECRYPT_CONCURRENCY).reduce<Promise<{ dk_id_hex: string; bw_id_hex: string }[]>>(
						async (acc, chunk) => [
							...(await acc),
							...(await Promise.all(
								chunk.map(async (secret) => {
									const owner = byId.get(secret.id)!;
									// Plaintext key material exists only inside this closure. It is re-sealed under the destination's own organization key before anything is returned, and the return value is ids only.
									const [value, note] = await Promise.all([decryptOne(source.stub, source.token, secret.value), decryptOne(source.stub, source.token, secret.note)]);

									const [key, encryptedValue, encryptedNote] = await Promise.all([
										// The key path carries the tenant id, so a migrated secret has to be re-keyed against the *new* tenant
										encryptOne(destination.stub, destination.token, [newTenant.base64url, owner.kr_id_base64url, owner.dk_id_base64url].join('/')),
										encryptOne(destination.stub, destination.token, value),
										encryptOne(destination.stub, destination.token, note),
									]);

									const { id } = await destination.stub.setSecret({ projectId: destination.projectId, key, value: encryptedValue, note: encryptedNote });

									return {
										dk_id_hex: Buffer.from(owner.dk_id_base64url, 'base64url').toString('hex'),
										bw_id_hex: id.replaceAll('-', ''),
									};
								}),
							)),
						],
						Promise.resolve(alreadyCopied),
					);
				} finally {
					source.sessions.forEach((session) => this.closeBitwardenSession(session, 'Vault migration: clone finished'));
					this.closeBitwardenSession(destination.stub, 'Vault migration: clone finished');
				}
			}),
		]);

		// Still step 5 - the half that can only run once both of the above have: the new rows exist, and the secrets they point at have ids
		await step.do('Relink datakeys', VaultMigration.cfApiCallRetry, async () => {
			if (clonedSecrets.length === 0) return { relinked: 0 };

			await writeChunked(
				new_db,
				clonedSecrets.map(
					({ dk_id_hex, bw_id_hex }) =>
						new_db
							.update(tenantSchema.datakeys)
							.set({ bw_id: sql`unhex(${bw_id_hex})` })
							.where(eq(tenantSchema.datakeys.dk_id, sql`unhex(${dk_id_hex})`)) as unknown as ReturnType<SqliteRemoteDatabase['run']>,
				),
			);

			return { relinked: clonedSecrets.length };
		});

		/**
		 * Step 5's tail end for the destination *connection* rather than its contents: a BYO destination needs its access token stored in our organization and pointed at by `byo_bw`, exactly as onboarding does it. A managed destination needs no pointer at all, which is what leaving `byo_bw` unset already means.
		 */
		await step.do('Record destination vault connection', VaultMigration.bitwardenCallRetry, async () => {
			const config = await unsealVaultConfig(rawToken, parsedPayload.config);
			if (config.mode === 'managed') return { byo: false };

			const rootToken = this.rootAccessToken(oldTenant.jurisdiction);
			const rootStub = await this.openBitwardenSession(newTenant.hex, oldTenant.jurisdiction, newTenant.do_id, this.rootEndpoints(oldTenant.jurisdiction), rootToken);

			// Tracks whether the secret landed in our organization, so a failure below can delete it instead of leaving the tenant's access token sitting there unreferenced - same rollback onboarding does
			let createdSecretId: string | undefined;

			try {
				const [key, value, note] = await Promise.all([encryptOne(rootStub, rootToken, [newTenant.base64url, 'bw'].join('/')), encryptOne(rootStub, rootToken, config.accessToken), encryptOne(rootStub, rootToken, JSON.stringify({ project: config.project, endpoints: config.endpoints } satisfies zm.input<typeof TenantByoBwNoteSchema>))]);

				const secret = await rootStub.setSecret({ projectId: this.rootProjectId(oldTenant.jurisdiction), key, value, note });
				createdSecretId = secret.id;

				await newStub.updateProperties({ byo_bw: secret.id });

				return { byo: true };
			} catch (error) {
				if (createdSecretId) await rootStub.deleteSecrets([createdSecretId]).catch((cleanupError: unknown) => console.error('Failed to roll back orphaned vault connection secret', cleanupError));
				throw error;
			} finally {
				this.closeBitwardenSession(rootStub, 'Vault migration: connection stored');
			}
		});

		// Step 6 - the new tenant is complete, so it stops advertising itself as provisional
		await step.do('Finalize new tenant name', VaultMigration.cfApiCallRetry, () => newStub.updateProperties({ name: oldProperties.name, m_time: new Date() }).then(() => {}));

		// Steps 7 & 8 - independent: one repoints root's API-key mapping at the new tenant, the other marks the old one superseded
		await Promise.all([
			step.do('Repoint root references', VaultMigration.cfApiCallRetry, async () => {
				const r_db = this.r_db();

				// `api_keys_tenants.t_id` cascades on delete, so this has to happen *before* the old tenant row goes - otherwise the mapping disappears with it. `users_tenants` already has its new rows; the old ones are what the cascade is for.
				const { meta } = await r_db
					.update(rootSchema.api_keys_tenants)
					.set({ t_id: sql`unhex(${newTenant.hex})` })
					.where(eq(rootSchema.api_keys_tenants.t_id, sql`unhex(${parsedPayload.t_id.hex})`));

				return { apiKeys: meta.changes };
			}),
			step.do('Mark old tenant superseded', VaultMigration.cfApiCallRetry, () => oldStub.updateProperties({ name: `${oldProperties.name}old_${event.instanceId}`, m_time: new Date() }).then(() => {})),
		]);

		/**
		 * Step 9. Only this tenant's secrets, identified the same way the clone identified them - in the managed organization the listing is shared with every other tenant, and a BYO organization is the customer's own and may hold anything. The BYO connection secret in *our* organization goes too; it named a vault this tenant no longer uses.
		 */
		await step.do('Purge old vault secrets', VaultMigration.bitwardenCallRetry, async () => {
			const source = await this.openTenantVault(parsedPayload.t_id.hex, oldTenant.jurisdiction, oldTenant.do_id, oldProperties.byo_bw);

			try {
				const owned = await this.ownedSecrets(source.stub, source.token, parsedPayload.t_id.base64url);
				if (owned.length > 0) await source.stub.deleteSecrets(owned.map(({ bw_id }) => bw_id));

				// Lives in our organization regardless of where the tenant's key material was, so it's deleted through the root session rather than the tenant's
				if (oldProperties.byo_bw) await source.sessions[0]!.deleteSecrets([oldProperties.byo_bw]);

				return { deleted: owned.length, connection: Boolean(oldProperties.byo_bw) };
			} finally {
				source.sessions.forEach((session) => this.closeBitwardenSession(session, 'Vault migration: purge finished'));
			}
		});

		// Step 10 - nothing points at the old tenant anymore
		await step.do('Delete old tenant', VaultMigration.cfApiCallRetry, async () => {
			// Wiping a Durable Object's storage is what makes it stop existing. The audit log lives in its own object, whose copy is already sitting under the new tenant; leaving the original behind would strand a store of request metadata nothing can reach anymore.
			await Promise.all([oldStub.nuke('Superseded by vault migration', false), this.logsStubFromName(oldTenant.jurisdiction, parsedPayload.t_id.utf8).nuke('Superseded by vault migration', false)]);

			// `users_tenants.t_id` cascades on delete, so the tenant row is enough to clean up what's left of it in root
			await this.r_db()
				.delete(rootSchema.tenants)
				.where(eq(rootSchema.tenants.t_id, sql`unhex(${parsedPayload.t_id.hex})`))
				.limit(1);

			return { deleted: true };
		});

		await step.do('Record audit log', VaultMigration.cfApiCallRetry, async () => {
			const now = new Date();
			const log: zm.input<typeof TenantLogQueueMessageSchema> = {
				t_id: newTenant.hex,
				jurisdiction: oldTenant.jurisdiction,
				id: uuidv7({ msecs: now.getTime() }).replaceAll('-', ''),
				timestamp: now.toISOString(),
				event_type: TenantLogEventType['completed vault migration'],
				context: {
					action: parsedPayload.action,
					from: parsedPayload.t_id.hex,
					instance: event.instanceId,
					datakeys: clonedSecrets.length,
				},
				system: true,
				status: TenantLogEventStatus.success,
			};
			// Post the raw version, not the parsed one, so the consumer validates it independently
			await TenantLogQueueMessageSchema.parseAsync(log);
			await this.env.LOGS.sendBatch([{ body: log, contentType: 'json' }]);

			return { logged: true };
		});

		return { t_id: newTenant.base64url, action: parsedPayload.action, datakeys: clonedSecrets.length };
	}
}
