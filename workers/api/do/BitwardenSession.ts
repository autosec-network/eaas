import { DurableObject } from 'cloudflare:workers';
import * as rootSchema from 'db/schemas/root';
import { drizzle } from 'drizzle-orm/d1';
import { eq, sql } from 'drizzle-orm/sql';
import { hexToUuid } from 'helpers';
import { bitwardenSessionFingerprint, BitwardenSessionBusyError, MAX_BITWARDEN_SESSION_TASKS } from 'helpers/bitwarden-sessions';
import { ZodUuidHex, ZodUuidInputConverted } from 'helpers/zod/mini';
import * as jose from 'jose';
import { Buffer } from 'node:buffer';
import { createCipheriv, createDecipheriv, createHmac, randomBytes, timingSafeEqual, type UUID } from 'node:crypto';
import { DOJurisdictions } from 'types';
import type { ProjectResponse, SecretCreateRequest, SecretDeleteResponse, SecretResponse } from 'types/bw/schemas';
import { TenantLogEventStatus, TenantLogEventType, TenantLogQueueMessageSchema } from 'types/tenants/logging';
import { v7 as uuidv7 } from 'uuid';
import * as zm from 'zod/mini';
import type { EnvVars } from '~/types';

interface ParsedJwt extends jose.JWTPayload {
	scope: ['api.secrets'];
	client_id: UUID;
	sub: UUID;
	type: 'ServiceAccount';
	organization: UUID;
}

interface ProjectResponseEnhanced extends Omit<ProjectResponse, 'id'> {
	id: UUID;
	read: boolean;
	write: boolean;
}

interface SecretsProject {
	id: UUID;
	name: string;
}

interface SecretDeleteResponseEnhanced extends Omit<SecretDeleteResponse, 'id'> {
	id: UUID;
	object: 'BulkDeleteResponseModel';
}

export class BitwardenSession extends DurableObject<EnvVars> {
	/**
	 * How many calls this session is running right now.
	 *
	 * Deliberately **in memory only**: it describes what this instance is doing at this instant, and an instance that goes away (eviction, deploy, crash) takes its in-flight calls with it - persisting the count would only preserve a number about work that no longer exists, and then refuse callers on behalf of a session that is entirely idle.
	 */
	private runningTasks = 0;

	/**
	 * How long an `init()`ed-but-never-`auth()`ed session gets before the orphan-safety alarm set in {@link init} nukes it. Generous enough that legitimate time between the two calls (a caller validating something else first, a slow request) is never at risk; short enough that a caller that crashes, throws, or simply forgets between the two doesn't leave a Durable Object sitting around forever holding nothing.
	 */
	private static readonly ORPHAN_TIMEOUT_MS = 15 * 60 * 1000;

	/**
	 * Run `task` while it counts against {@link runningTasks}, refusing outright once {@link MAX_BITWARDEN_SESSION_TASKS} are already in flight.
	 *
	 * A pooled session is addressed by every Worker instance that wants the same vault, and a Durable Object runs one thing at a time - so past a handful of concurrent callers, everybody is just queueing. Refusing the surplus with {@link BitwardenSessionBusyError} hands them back the choice: borrow a different session, or open one (see `acquireBitwardenSession` in `helpers/bitwarden-sessions`). Nothing about that is visible to a caller that isn't being turned away.
	 *
	 * Only the public entry points are wrapped. The internals they share (org key derivation, most of all) must not re-enter this, or one call would spend two slots and the cap would silently become three.
	 */
	private async withTaskSlot<T>(task: () => Promise<T>): Promise<T> {
		if (this.runningTasks >= MAX_BITWARDEN_SESSION_TASKS) throw new BitwardenSessionBusyError(this.ctx.id.toString());

		this.runningTasks++;
		try {
			return await task();
		} finally {
			this.runningTasks--;
		}
	}

	/**
	 * How busy this session is, for the admin dashboard's session list. Ungated on purpose - asking a session how loaded it is must never be the call that gets turned away for being the 7th.
	 */
	public activeTasks() {
		return { active: this.runningTasks, max: MAX_BITWARDEN_SESSION_TASKS };
	}

	/**
	 * Whether this session can take work right now: authenticated, unexpired, and under the concurrency cap. Rejecting is the answer, not an error to be logged - see `acquireBitwardenSession`, which uses this to sort a tenant's pool into "borrow this one", "skip this one", and "this row names a session that no longer exists".
	 *
	 * The expiry re-check is belt and braces. {@link auth} sets an alarm for the exact moment the token dies and {@link alarm} nukes on it; this catches the case where that alarm never fired (a `setAlarm` that lost its race with an eviction, say) rather than handing out a session whose every call would fail against Bitwarden.
	 */
	public available() {
		return this.withTaskSlot(async () => {
			const [jwt, decodedJwt] = await Promise.all([this.ctx.storage.get<string>('jwt', { allowConcurrency: true }), this.ctx.storage.get<ParsedJwt>('decodedJwt', { allowConcurrency: true })]);

			if (!jwt || !decodedJwt?.exp) throw new Error('Session is not authenticated');

			const expires = new Date(decodedJwt.exp * 1000);
			if (expires.getTime() <= Date.now()) {
				// Put in `waitUntil` so the caller gets its answer now rather than waiting on a teardown it doesn't care about
				this.ctx.waitUntil(this.nuke('Access token expired'));
				throw new Error('Session has expired');
			}

			return { expires };
		});
	}

	/**
	 * The tenant Durable Object this session's pool row lives in, or `null` for a session that isn't tied to a tenant at all (see {@link initOptions.t_id}) and therefore can't be pooled.
	 */
	private async tenantStub() {
		const [t_do_id, t_jurisdiction] = await Promise.all([this.ctx.storage.get<ArrayBuffer | null>('t_do_id', { allowConcurrency: true }), this.ctx.storage.get<DOJurisdictions | null>('t_jurisdiction', { allowConcurrency: true })]);

		if (!t_do_id) return null;

		const do_id_hex = Buffer.from(t_do_id).toString('hex');
		return this.env.TENANT_D0.get((t_jurisdiction ? this.env.TENANT_D0.jurisdiction(t_jurisdiction) : this.env.TENANT_D0).idFromString(do_id_hex));
	}

	/**
	 * Publish this session to its tenant's pool, so the next operation that needs these exact credentials borrows it instead of paying for another OAuth round trip.
	 *
	 * The session registers itself rather than being registered by whoever opened it: it's the only party that knows its own id and its token's expiry, and self-registration is what lets a borrower stay unaware there's a pool at all.
	 *
	 * Best effort. A registration that doesn't land costs reuse, not correctness - the session still works perfectly for the caller that opened it, it just stays private to them.
	 */
	private async registerInPool(fingerprint: string, expires: Date) {
		try {
			const stub = await this.tenantStub();
			// A session opened before any tenant exists (the live "which projects can this token see" preview) has nowhere to be pooled, and nothing to share it with
			if (!stub) return;

			await stub.registerBitwardenSession({ do_id: this.ctx.id.toString(), fingerprint, expires });
		} catch (error) {
			console.error('Failed to register bitwarden session in tenant pool', error);
		}
	}

	/**
	 * Remove this session's pool row on the way out, so nothing borrows an id that's about to stop answering. Called from {@link nuke}, which is the only way this object ever ends.
	 *
	 * Skipped when the tenant no longer exists in root: any RPC to a tenant Durable Object re-runs its migrations and recreates its tables, so deregistering into a purged tenant would resurrect it as an orphan nothing will ever clean up again. The purge paths tear a tenant's sessions down *before* wiping the tenant, so in practice this check only ever fires for a session that outlived its tenant some other way - and the cost of being wrong (a stale row in a database that no longer exists) is nothing.
	 */
	private async forgetInPool() {
		try {
			const [t_do_id, stub] = await Promise.all([this.ctx.storage.get<ArrayBuffer | null>('t_do_id', { allowConcurrency: true }), this.tenantStub()]);
			if (!t_do_id || !stub) return;

			const do_id_hex = Buffer.from(t_do_id).toString('hex');
			const r_db = drizzle(this.env.DB_ROOT.withSession('first-unconstrained') as unknown as D1Database);
			const [tenant] = await r_db
				.select({ t_id: rootSchema.tenants.t_id })
				.from(rootSchema.tenants)
				.where(eq(rootSchema.tenants.do_id, sql`unhex(${do_id_hex})`))
				.limit(1);

			if (!tenant) return;

			await stub.unregisterBitwardenSession(this.ctx.id.toString());
		} catch (error) {
			console.error('Failed to remove bitwarden session from tenant pool', error);
		}
	}

	public static initOptions = zm.object({
		t_jurisdiction: zm.nullable(zm.enum(DOJurisdictions)),
		t_do_id: zm.nullable(zm.instanceof(ArrayBuffer)),
		/**
		 * The tenant this session is opened on behalf of, if any — accepts any UUID encoding since every caller carries it in a different shape. Lets the session log its own lifecycle audit rows (see {@link logSessionEvent}) without every caller separately doing so. When omitted but {@link t_do_id} is given, `init()` resolves it with a root lookup instead - most callers already had `t_do_id` on hand before this field existed, so this keeps them working without a change. Truly `null` (both this and `t_do_id` absent) only for sessions that aren't tied to a tenant yet at all - e.g. the live "which projects can this token see" preview a customer sees while still typing a token, before any tenant exists - and those sessions simply go unlogged.
		 */
		t_id: zm.nullable(ZodUuidInputConverted(7)),
		/**
		 * Who opened this session, for the audit trail {@link logSessionEvent} builds — the human behind it, if any. A Workflow or admin operation passes through whoever (or whatever) actually triggered it: a dashboard action still carries the acting `u_id` even though a Workflow is what's calling `init()`, an API-key-triggered one carries {@link ak_id} instead, and only a genuinely unattended trigger (e.g. a cron/count-based key rotation) leaves both `null`, which is what makes the row log as `system`.
		 */
		u_id: zm.nullable(ZodUuidHex(7)),
		/**
		 * The API key behind this session, if it was a key rather than a human that triggered it. Mutually exclusive with {@link u_id} in practice, though nothing here enforces that — the audit row just needs at least one of `u_id`/`ak_id`/`system` (see `TenantLogQueueMessageSchema`'s check), and {@link logSessionEvent} picks `u_id` first if somehow both are set.
		 */
		ak_id: zm.nullable(ZodUuidHex(7)),
		endpoints: zm.object({
			/**
			 * @link https://bitwarden.com/help/public-api/#base-url
			 */
			base: zm.url({ protocol: /^https$/, hostname: zm.regexes.domain, normalize: true }),
			/**
			 * @link https://bitwarden.com/help/public-api/#authentication-endpoints
			 */
			authentication: zm.url({ protocol: /^https$/, hostname: zm.regexes.domain, normalize: true }),
		}),
	});
	public async init(_options: zm.input<typeof BitwardenSession.initOptions>) {
		const options = await BitwardenSession.initOptions.parseAsync(_options);

		// Most callers pass `t_do_id` (the tenant's own Durable Object id) but not `t_id` (its UUID) - resolved here, once, with a root lookup, so a caller that already had `t_do_id` on hand doesn't also have to plumb `t_id` through just for this session to audit-log itself.
		let t_id_utf8 = options.t_id?.utf8 ?? null;
		if (!t_id_utf8 && options.t_do_id) {
			try {
				const do_id_hex = Buffer.from(options.t_do_id).toString('hex');
				const r_db = drizzle(this.env.DB_ROOT.withSession('first-unconstrained') as unknown as D1Database);
				const [row] = await r_db
					.select({ t_id: rootSchema.tenants.t_id })
					.from(rootSchema.tenants)
					.where(eq(rootSchema.tenants.do_id, sql`unhex(${do_id_hex})`))
					.limit(1);
				if (row) t_id_utf8 = hexToUuid(row.t_id.toString('hex'));
			} catch (error) {
				// Best-effort: an unresolvable tenant means this session's lifecycle just goes unlogged, not that the session fails to open
				console.warn('Failed to resolve tenant id for bitwarden session audit log', error);
			}
		}

		// Start save task
		const saveEndpoints = this.ctx.storage.put(
			{
				t_jurisdiction: options.t_jurisdiction,
				t_do_id: options.t_do_id,
				t_id_utf8,
				u_id: options.u_id,
				ak_id: options.ak_id,
				apiEndpoint: options.endpoints.base,
				identityEndpoint: options.endpoints.authentication,
			},
			{ allowConcurrency: true },
		);
		// Make sure it completes even if other bad tasks occur
		this.ctx.waitUntil(saveEndpoints);

		/**
		 * Orphan safety net. A caller that `init()`s and then never `auth()`s - crashes, throws before reaching it, or just has a bug - would otherwise leave this session sitting here forever, since nothing else nukes an unauthenticated one. A Durable Object only ever holds one alarm, so a successful `auth()` overwrites this with the token's real expiry (see {@link auth}) and this one simply never fires; that overwrite is what also covers a failure *inside* `auth()`, not just it never being called at all - a thrown error there never reaches the line that would replace this alarm, so this one is still the one that goes off.
		 */
		const orphanAlarm = this.ctx.storage.setAlarm(Date.now() + BitwardenSession.ORPHAN_TIMEOUT_MS, { allowConcurrency: true });
		this.ctx.waitUntil(orphanAlarm);

		// Make sure everything completes before method finishes
		await Promise.all([saveEndpoints, orphanAlarm]);
	}

	/**
	 * Builds, validates, and sends one audit log row for this session's lifecycle (open/close) straight onto the `eaas-logs-*` queue - never written to a tenant's `TenantD0Logs` directly, since that queue is what accounts for D1/DO outages and overload, not just a convenience (see `workers/api/AGENTS.md`). Fully self-contained: this DO is the single source of truth for its own lifecycle events, so it owns sending them too instead of handing a message back for some caller to send or buffer - `env.LOGS` (the same queue binding every other producer uses) is available here just as it is anywhere else on the `api` worker.
	 *
	 * A message queued for a tenant that no longer exists by the time it's processed (e.g. onboarding rolled back, or a tenant was purged) isn't this method's problem - see the consumer's tenant-legitimacy check in `workers/api/src/queue.ts`.
	 *
	 * Best-effort: build, validation, and send failures are all swallowed here (logged, not thrown) so a logging bug can never break session creation or teardown, which is what the caller actually needs to succeed.
	 */
	private async logSessionEvent(event_type: TenantLogEventType, context: Record<string, unknown>): Promise<void> {
		try {
			const [t_id_utf8, t_jurisdiction, u_id, ak_id] = await Promise.all([this.ctx.storage.get<string | null>('t_id_utf8', { allowConcurrency: true }), this.ctx.storage.get<DOJurisdictions | null>('t_jurisdiction', { allowConcurrency: true }), this.ctx.storage.get<string | null>('u_id', { allowConcurrency: true }), this.ctx.storage.get<string | null>('ak_id', { allowConcurrency: true })]);

			// No tenant to attribute this to (see `initOptions.t_id`'s doc comment) - nothing to log
			if (!t_id_utf8) return;

			const now = new Date();
			const log: zm.input<typeof TenantLogQueueMessageSchema> = {
				t_id: t_id_utf8.replaceAll('-', ''),
				jurisdiction: t_jurisdiction,
				id: uuidv7({ msecs: now.getTime() }).replaceAll('-', ''),
				timestamp: now.toISOString(),
				event_type,
				context,
				...(u_id ? { u_id } : ak_id ? { ak_id } : { system: true }),
				status: TenantLogEventStatus.success,
			};

			// Validated here so a producer bug surfaces at the source; the raw (pre-parse) version is still what's sent, same as every other producer, so the queue consumer validates independently
			await TenantLogQueueMessageSchema.parseAsync(log);
			await this.env.LOGS.sendBatch([{ body: log, contentType: 'json' }]);
		} catch (error) {
			console.error(`Failed to enqueue "${TenantLogEventType[event_type]}" audit log`, error);
		}
	}

	/**
	 * HKDF Expand using SHA-256.
	 * @param key - The derived secret (PRK) as a Buffer.
	 * @param info - Optional context and application-specific information.
	 * @param outputLength - Desired length of the output keying material.
	 * @returns Expanded key as a Buffer.
	 */
	private static hkdfExpand(key: Buffer, info: string | null, outputLength: number) {
		const infoBytes = info ? Buffer.from(info, 'utf8') : Buffer.alloc(0);
		const output = Buffer.alloc(outputLength);
		const hashLength = 256 / 8; // SHA-256 output length
		const iterations = Math.ceil(outputLength / hashLength);

		let t = Buffer.alloc(0);
		for (let i = 0; i < iterations; i++) {
			t = createHmac('sha256', key)
				.update(Buffer.concat([t, infoBytes, Buffer.from([i + 1])]))
				.digest();

			const offset = i * hashLength;
			const length = Math.min(hashLength, outputLength - offset);
			t.copy(output, offset, 0, length);
		}

		return output;
	}
	/**
	 * Derive a SymmetricCryptoKey using HKDF with SHA-256.
	 * @param secret - The 16-byte secret as a Buffer.
	 * @param name - The name (e.g., "accesstoken") as a string.
	 * @param info - Optional additional context for HKDF.
	 * @returns The derived key as a Buffer.
	 */
	private static deriveShareableKey(secret: Buffer, name: string, info: string | null) {
		// Create the initial hash (PRK) using HMAC-SHA256
		const prk = createHmac('sha256', Buffer.from(`bitwarden-${name}`, 'utf8'))
			.update(secret)
			.digest();

		// Expand the PRK using HKDF to generate the final key
		return this.hkdfExpand(prk, info, 64); // Output length: 64 bytes
	}

	/**
	 * Authenticates with the Bitwarden API using a service account access token.
	 * Performs OAuth2 with access token, stores the encrypted payload and JWT, schedules an alarm for token expiration, and publishes the session to its tenant's reusable pool.
	 *
	 * Called exactly once per session, by whoever opened it. A **borrowed** session is never re-`init()`ed or re-`auth()`ed: doing so would fetch a second token (defeating the point of reusing the first) and fire a second "created" audit row for a session that was only ever created once.
	 * @param accessToken - The service account access token from Bitwarden
	 * @throws {Error} If the identity endpoint is not set or if authentication fails
	 */
	public async auth(accessToken: string) {
		const { apiEndpoint, identityEndpoint } = await this.ctx.storage.get<string>(['apiEndpoint', 'identityEndpoint'], { allowConcurrency: true }).then((results) => Object.fromEntries(results.entries()));

		// Both endpoints, not just the one this call posts to: `init()` stores them together, and the pool fingerprint below is over the pair
		if (identityEndpoint && apiEndpoint) {
			const [, uuid, extra] = accessToken.split('.');
			const [secret] = extra!.split(':');

			const response = await fetch(identityEndpoint, {
				method: 'POST',
				headers: {
					'Content-Type': 'application/x-www-form-urlencoded',
				},
				body: new URLSearchParams({
					scope: 'api.secrets',
					client_id: uuid!,
					client_secret: secret!,
					grant_type: 'client_credentials',
				}),
			});

			if (response.ok) {
				const json = await response.json<{
					access_token: string;
					encrypted_payload: string;
					expires_in: number;
					scope: 'api.secrets';
					token_type: 'Bearer';
				}>();
				// Start saving the identity information in storage immediately, while we continue processing.
				const identitySave = this.ctx.storage.put(
					{
						jwt: json.access_token,
						encryptedPayload: json.encrypted_payload,
					},
					{ allowConcurrency: true },
				);

				// Decode the JWT to extract expiration time
				const jwt = jose.decodeJwt<ParsedJwt>(json.access_token);
				await Promise.all([
					// Guarantee that the identity information is saved before this method finishes.
					identitySave,
					this.ctx.storage.put('decodedJwt', jwt, { allowConcurrency: true }),
				]);

				if (jwt.exp) {
					const expires = new Date(jwt.exp * 1000);

					/**
					 * Delete the session DO when the token expires - **awaited**, not `waitUntil`ed. Now that sessions outlive the operation that opened them, this alarm is the only thing that ends one; a `setAlarm` that never landed would leave a pooled session holding a dead token, handing itself out until its pool row aged past `expires`. `deleteAll()` clears the alarm along with the data on this worker's compatibility date (>= `2026-02-24`), so a nuke never leaves one behind either.
					 */
					await this.ctx.storage.setAlarm(expires, { allowConcurrency: true });

					// Endpoints come from storage rather than `init`'s arguments so the digest is over the same normalized values a borrower will hash - see `bitwardenSessionFingerprint`
					await this.registerInPool(await bitwardenSessionFingerprint({ base: apiEndpoint, authentication: identityEndpoint }, accessToken), expires);

					this.ctx.waitUntil(this.logSessionEvent(TenantLogEventType['created bitwarden session'], { session: this.ctx.id.toString() }));
				} else {
					// Put in waitUntil() so that it can perform the nuke even on a uncaught exception.
					this.ctx.waitUntil(this.nuke('Access token missing exp claim, something went wrong with the token response'));
					throw new Error('Access token missing exp claim');
				}
			} else {
				throw new Error(
					JSON.stringify({
						uiMessage: 'Failed to get token',
						headers: Object.fromEntries(response.headers.entries()),
						status: response.status,
						statusText: response.statusText,
						text: await response.text(),
						url: response.url,
					}),
				);
			}
		} else {
			throw new Error('Identity endpoint not set. Try calling setEndpoints() first.');
		}
	}

	/**
	 * Retrieves and decrypts the organization encryption key from the stored encrypted payload.
	 * Uses the access token to derive the decryption key and decrypts the payload.
	 * @param accessToken - The service account access token containing encryption key material
	 * @returns The decrypted organization encryption key as a string
	 * @throws {BitwardenSessionBusyError} If this session is already running {@link MAX_BITWARDEN_SESSION_TASKS} calls
	 * @throws {Error} If the encrypted payload is not found in storage or decryption fails
	 */
	public getOrgEncryptionKey(accessToken: string) {
		return this.withTaskSlot(() => this._getOrgEncryptionKey(accessToken));
	}
	/**
	 * The work behind {@link getOrgEncryptionKey}, unmetered so the encrypt/decrypt paths that need the org key can reuse it inside their own slot instead of taking a second one.
	 */
	private async _getOrgEncryptionKey(accessToken: string) {
		const encryptedPayload = await this.ctx.storage.get<string>('encryptedPayload', { allowConcurrency: true });
		if (encryptedPayload) {
			// Step 1: Parse the string into an EncString object
			const encString = EncString.fromString(encryptedPayload);

			// Step 2: Create the SymmetricCryptoKey
			const [, , extra] = accessToken.split('.');
			const [, encryptionKey] = extra!.split(':');
			const accTokenSymmetricKey = BitwardenSession.deriveShareableKey(Buffer.from(encryptionKey!, 'base64'), 'accesstoken', 'sm-access-token');
			const symmetricKey = SymmetricCryptoKey.fromBase64Key(accTokenSymmetricKey.toString('base64'), 2);

			const decryptedData = encString.decryptWithKey(symmetricKey);

			const decryptedString = JSON.parse(decryptedData.toString('utf8')) as { encryptionKey: string };

			return decryptedString.encryptionKey;
		} else {
			throw new Error('No encrypted payload found in storage. Try calling identity() first.');
		}
	}

	/**
	 * Retrieves all projects from the Bitwarden API that the service account has read and write access to.
	 * @returns An array of projects with read and write permissions
	 * @throws {BitwardenSessionBusyError} If this session is already running {@link MAX_BITWARDEN_SESSION_TASKS} calls
	 * @throws {AggregateError} If API endpoint, organization ID, or access token are not found in storage
	 * @throws {Error} If the API request fails
	 */
	public getProjects() {
		return this.withTaskSlot(() => this._getProjects());
	}
	private async _getProjects() {
		const [orgId, { apiEndpoint, jwt }] = await Promise.all([
			// Separate for typing reasons
			this.ctx.storage.get<ParsedJwt>('decodedJwt', { allowConcurrency: true }).then((jwt) => jwt?.organization),
			this.ctx.storage.get<string>(['apiEndpoint', 'jwt'], { allowConcurrency: true }).then((results) => Object.fromEntries(results.entries())),
		]);

		if (apiEndpoint && orgId && jwt) {
			const response = await fetch(new URL(['organizations', orgId, 'projects'].join('/'), apiEndpoint), {
				headers: {
					Authorization: `Bearer ${jwt}`,
				},
			});

			if (response.ok) {
				const { data: projects } = await response.json<{
					object: string;
					data: ProjectResponseEnhanced[];
				}>();

				return projects.filter((project) => project.read && project.write);
			} else {
				throw new Error(
					JSON.stringify({
						uiMessage: 'Failed to get projects',
						headers: Object.fromEntries(response.headers.entries()),
						status: response.status,
						statusText: response.statusText,
						text: await response.text(),
						url: response.url,
					}),
				);
			}
		} else {
			const errors: Error[] = [];
			if (!apiEndpoint) errors.push(new Error('API endpoint not found'));
			if (!orgId) errors.push(new Error('Organization ID not found'));
			if (!jwt) errors.push(new Error('Access token not found'));

			throw new AggregateError(errors, 'Try calling identity() first.');
		}
	}

	/**
	 * Retrieves all secrets and projects from the Bitwarden API that the service account has read and write access to.
	 * @returns An object containing an array of all projects and an array of secrets with read and write permissions
	 * @throws {BitwardenSessionBusyError} If this session is already running {@link MAX_BITWARDEN_SESSION_TASKS} calls
	 * @throws {AggregateError} If API endpoint, organization ID, or access token are not found in storage
	 * @throws {Error} If the API request fails
	 */
	public getSecretsAndProjects() {
		return this.withTaskSlot(() => this._getSecretsAndProjects());
	}
	private async _getSecretsAndProjects() {
		const [orgId, { apiEndpoint, jwt }] = await Promise.all([
			// Separate for typing reasons
			this.ctx.storage.get<ParsedJwt>('decodedJwt', { allowConcurrency: true }).then((jwt) => jwt?.organization),
			this.ctx.storage.get<string>(['apiEndpoint', 'jwt'], { allowConcurrency: true }).then((results) => Object.fromEntries(results.entries())),
		]);

		if (apiEndpoint && orgId && jwt) {
			const response = await fetch(new URL(['organizations', orgId, 'secrets'].join('/'), apiEndpoint), {
				headers: {
					Authorization: `Bearer ${jwt}`,
				},
			});

			if (response.ok) {
				const { projects, secrets } = await response.json<{
					object: 'SecretsWithProjectsList';
					projects: SecretsProject[];
					secrets: {
						creationDate: string;
						id: UUID;
						key: string;
						organizationId: UUID;
						projects: SecretsProject[];
						read: boolean;
						revisionDate: string;
						write: boolean;
					}[];
				}>();

				return {
					projects,
					secrets: secrets.filter((secret) => secret.read && secret.write),
				};
			} else {
				throw new Error(
					JSON.stringify({
						uiMessage: 'Failed to get secrets and projects',
						headers: Object.fromEntries(response.headers.entries()),
						status: response.status,
						statusText: response.statusText,
						text: await response.text(),
						url: response.url,
					}),
				);
			}
		} else {
			const errors: Error[] = [];
			if (!apiEndpoint) errors.push(new Error('API endpoint not found'));
			if (!orgId) errors.push(new Error('Organization ID not found'));
			if (!jwt) errors.push(new Error('Access token not found'));

			throw new AggregateError(errors, 'Try calling identity() first.');
		}
	}

	public static getSecretsOptions = zm
		.array(
			zm.pipe(
				zm.uuidv4().check(zm.trim(), zm.toLowerCase()),
				zm.transform((uuid) => uuid as UUID),
			),
		)
		.check(zm.minLength(1));
	/**
	 * Retrieves secrets by their IDs from the Bitwarden API using pagination. Pages through the `secrets/get-by-ids` endpoint, following continuation tokens until all results are fetched.
	 * @warning This buffers all secrets in memory before returning. Use with caution if expecting a large number of secrets.
	 * @param secretIds - Array of secret UUIDs to retrieve
	 * @returns An array of secret objects with their metadata and values
	 * @throws {BitwardenSessionBusyError} If this session is already running {@link MAX_BITWARDEN_SESSION_TASKS} calls
	 * @throws {AggregateError} If API endpoint or access token are not found in storage
	 * @throws {Error} If the API request fails
	 */
	public getSecrets(_secretIds: zm.input<typeof BitwardenSession.getSecretsOptions>) {
		return this.withTaskSlot(() => this._getSecrets(_secretIds));
	}
	private async _getSecrets(_secretIds: zm.input<typeof BitwardenSession.getSecretsOptions>) {
		const secretIds = await BitwardenSession.getSecretsOptions.parseAsync(_secretIds);

		const { apiEndpoint, jwt } = await this.ctx.storage.get<string>(['apiEndpoint', 'jwt'], { allowConcurrency: true }).then((results) => Object.fromEntries(results.entries()));

		if (apiEndpoint && jwt) {
			/**
			 * Async generator that pages through the `secrets/get-by-ids` endpoint,
			 * following `continuationToken` until all results have been fetched.
			 * @see https://bitwarden.com/help/public-api/#continuation-token
			 */
			async function* fetchSecretPages() {
				const url = new URL(['secrets', 'get-by-ids'].join('/'), apiEndpoint);
				let continuationToken: string | null = null;

				do {
					if (continuationToken) {
						url.searchParams.set('continuationToken', continuationToken);
					}

					const response = await fetch(url, {
						method: 'POST',
						headers: {
							Authorization: `Bearer ${jwt}`,
							'Content-Type': 'application/json',
						},
						body: JSON.stringify({
							ids: secretIds,
						}),
					});

					if (response.ok) {
						const page = await response.json<{
							continuationToken: string | null;
							data: {
								creationDate: string;
								id: UUID;
								key: string;
								note: string;
								object: string;
								organizationId: UUID;
								projects: SecretsProject[];
								revisionDate: string;
								value: string;
							}[];
							object: 'list';
						}>();

						for (const secret of page.data) {
							yield secret;
						}

						continuationToken = page.continuationToken;
					} else {
						throw new Error(
							JSON.stringify({
								uiMessage: 'Failed to get secrets',
								headers: Object.fromEntries(response.headers.entries()),
								status: response.status,
								statusText: response.statusText,
								text: await response.text(),
								url: response.url,
							}),
						);
					}
				} while (continuationToken);
			}

			return Array.fromAsync(fetchSecretPages());
		} else {
			const errors: Error[] = [];
			if (!apiEndpoint) errors.push(new Error('API endpoint not found'));
			if (!jwt) errors.push(new Error('Access token not found'));

			throw new AggregateError(errors, 'Try calling identity() first.');
		}
	}

	public static setSecretOptions = zm.object({
		projectId: zm.pipe(
			zm.uuidv4().check(zm.trim(), zm.toLowerCase()),
			zm.transform((uuid) => uuid as UUID),
		),
		key: zm.string().check(zm.trim(), zm.minLength(1)),
		value: zm.string().check(zm.trim(), zm.minLength(1)),
		note: zm._default(zm.string(), '').check(zm.trim(), zm.minLength(1)),
	});
	/**
	 * Creates a secret in the organization this session is authenticated against.
	 * @throws {BitwardenSessionBusyError} If this session is already running {@link MAX_BITWARDEN_SESSION_TASKS} calls. Nothing was sent to Bitwarden when this is thrown - unlike a failure from the API itself, it's safe to run the same create against another session.
	 */
	public setSecret(_options: zm.input<typeof BitwardenSession.setSecretOptions>) {
		return this.withTaskSlot(() => this._setSecret(_options));
	}
	private async _setSecret(_options: zm.input<typeof BitwardenSession.setSecretOptions>) {
		const options = await BitwardenSession.setSecretOptions.parseAsync(_options);

		const [orgId, { apiEndpoint, jwt }] = await Promise.all([
			// Separate for typing reasons
			this.ctx.storage.get<ParsedJwt>('decodedJwt', { allowConcurrency: true }).then((jwt) => jwt?.organization),
			this.ctx.storage.get<string>(['apiEndpoint', 'jwt'], { allowConcurrency: true }).then((results) => Object.fromEntries(results.entries())),
		]);

		if (apiEndpoint && orgId && jwt) {
			const response = await fetch(new URL(['organizations', orgId, 'secrets'].join('/'), apiEndpoint), {
				method: 'POST',
				headers: {
					Authorization: `Bearer ${jwt}`,
					'Content-Type': 'application/json',
				},
				body: JSON.stringify({
					organizationId: orgId,
					projectIds: [options.projectId],
					key: options.key,
					value: options.value,
					note: options.note,
				} satisfies SecretCreateRequest),
			});

			if (response.ok) {
				return response.json<SecretResponse>();
			} else {
				throw new Error(
					JSON.stringify({
						uiMessage: 'Failed to save secret',
						headers: Object.fromEntries(response.headers.entries()),
						status: response.status,
						statusText: response.statusText,
						text: await response.text(),
						url: response.url,
					}),
				);
			}
		} else {
			const errors: Error[] = [];
			if (!apiEndpoint) errors.push(new Error('API endpoint not found'));
			if (!orgId) errors.push(new Error('Organization ID not found'));
			if (!jwt) errors.push(new Error('Access token not found'));

			throw new AggregateError(errors, 'Try calling identity() first.');
		}
	}

	/**
	 * @param iv - Only for debugging purposes. leave undefined otherwise
	 * @throws {BitwardenSessionBusyError} If this session is already running {@link MAX_BITWARDEN_SESSION_TASKS} calls. Callers decrypting in bulk should fan out no wider than that against one session.
	 */
	public decryptSecret(accessToken: string, cipherText: string): Promise<string>;
	public decryptSecret(accessToken: string, cipherText: string, iv: true): Promise<{ data: string; iv: Readonly<Buffer> }>;
	public decryptSecret(accessToken: string, cipherText: string, iv?: boolean) {
		return this.withTaskSlot(() => this._decryptSecret(accessToken, cipherText, iv));
	}
	private async _decryptSecret(accessToken: string, cipherText: string, iv?: boolean) {
		// Step 1: Parse the string into an EncString object
		const encString = EncString.fromString(cipherText);

		// Step 2: Create the SymmetricCryptoKey
		const symmetricKey = SymmetricCryptoKey.fromBase64Key(await this._getOrgEncryptionKey(accessToken), encString.encType as 0 | 1 | 2);

		if (iv) {
			const data = encString.decryptToString(symmetricKey);

			return {
				data,
				iv: encString.iv,
			};
		} else {
			return encString.decryptToString(symmetricKey);
		}
	}

	/**
	 * @throws {BitwardenSessionBusyError} If this session is already running {@link MAX_BITWARDEN_SESSION_TASKS} calls
	 */
	public encryptSecret(accessToken: string, plainText: string, iv?: Buffer, version: 0 | 1 | 2 = 2) {
		return this.withTaskSlot(() => this._encryptSecret(accessToken, plainText, iv, version));
	}
	private async _encryptSecret(accessToken: string, plainText: string, iv?: Buffer, version: 0 | 1 | 2 = 2) {
		// Step 1: Create the SymmetricCryptoKey
		const symmetricKey = SymmetricCryptoKey.fromBase64Key(await this._getOrgEncryptionKey(accessToken), version);

		// Step 2: Parse the string into an EncString object
		const encString = EncString.encryptAes256Hmac(Buffer.from(plainText, 'utf8'), symmetricKey, iv);

		return encString.toString();
	}

	public static deleteSecretsOptions = zm
		.array(
			zm.pipe(
				zm.uuidv4().check(zm.trim(), zm.toLowerCase()),
				zm.transform((uuid) => uuid as UUID),
			),
		)
		.check(zm.minLength(1));
	/**
	 * @throws {BitwardenSessionBusyError} If this session is already running {@link MAX_BITWARDEN_SESSION_TASKS} calls
	 */
	public deleteSecrets(_secretIds: zm.input<typeof BitwardenSession.deleteSecretsOptions>) {
		return this.withTaskSlot(() => this._deleteSecrets(_secretIds));
	}
	private async _deleteSecrets(_secretIds: zm.input<typeof BitwardenSession.deleteSecretsOptions>) {
		const secretIds = await BitwardenSession.deleteSecretsOptions.parseAsync(_secretIds);

		const { apiEndpoint, jwt } = await this.ctx.storage.get<string>(['apiEndpoint', 'jwt'], { allowConcurrency: true }).then((results) => Object.fromEntries(results.entries()));

		if (apiEndpoint && jwt) {
			const response = await fetch(new URL(['secrets', 'delete'].join('/'), apiEndpoint), {
				method: 'POST',
				headers: {
					Authorization: `Bearer ${jwt}`,
					'Content-Type': 'application/json',
				},
				body: JSON.stringify(secretIds),
			});

			if (response.ok) {
				const { data } = await response.json<{
					data: SecretDeleteResponseEnhanced[];
					continuationToken: string | null;
					object: 'list';
				}>();

				const erroredDeletions = data.filter(({ error }) => error !== null);

				if (erroredDeletions.length === 0) {
					return data.map(({ id }) => id);
				} else {
					throw new AggregateError(
						erroredDeletions.map(({ id, error }) => new Error(`Failed to delete secret ${id}: ${error}`)),
						'One or more secrets failed to delete',
					);
				}
			} else {
				throw new Error(
					JSON.stringify({
						uiMessage: 'Failed to delete secrets',
						headers: Object.fromEntries(response.headers.entries()),
						status: response.status,
						statusText: response.statusText,
						text: await response.text(),
						url: response.url,
					}),
				);
			}
		} else {
			const errors: Error[] = [];
			if (!apiEndpoint) errors.push(new Error('API endpoint not found'));
			if (!jwt) errors.push(new Error('Access token not found'));

			throw new AggregateError(errors, 'Try calling identity() first.');
		}
	}

	/**
	 * The token this session holds has just expired, so the session has no reason to exist anymore. This is what makes a pooled session temporary: nothing else ever ends one, since borrowers no longer close what they didn't open.
	 */
	override async alarm() {
		await this.nuke('Access token expired');
	}

	/**
	 * Wipes all persisted state, logging this session's closing itself (see {@link logSessionEvent}) and removing itself from its tenant's pool (see {@link forgetInPool}) before it does - the only caller of `nuke()` that could still do either after the fact is this class, so it owns both, same as {@link auth} owns the "created" side.
	 *
	 * Now that sessions are pooled, this is the tenant's session too: only its own expiry alarm, or a tenant being torn down entirely, has any business calling it. A borrower that nukes a session it merely borrowed pulls it out from under every other caller mid-operation.
	 * @param reason Optional reason for the nuke.
	 * @param [hard=false] Optionally force exit the DO
	 */
	public async nuke(reason?: string, hard: boolean = false) {
		if (reason) console.warn(reason);

		// Both of these read state that `deleteAll` below is about to remove, so both are started (their storage reads issued) before it rather than after
		const closeLog = this.logSessionEvent(TenantLogEventType['ended bitwarden session'], { session: this.ctx.id.toString(), reason });
		const forget = this.forgetInPool();
		if (hard) {
			// Awaited, not `waitUntil`, and ahead of `deleteAll` below: `ctx.abort()` further down is uncatchable and would tear the DO down mid-flight, silently dropping the audit row or leaving a pool row pointing at a session that no longer exists
			await Promise.all([closeLog, forget]);
		} else {
			this.ctx.waitUntil(closeLog);
			this.ctx.waitUntil(forget);
		}

		await this.ctx.storage.deleteAll({ allowConcurrency: false });
		// To ensure that the DO is fully evicted, this.ctx.abort() is called
		// `ctx.abort` throws an uncatchable error, so we yield to the event loop to avoid capturing it and let handlers finish cleaning up
		if (hard) {
			setTimeout(() => {
				try {
					this.ctx.abort(`nuked${reason ? `: ${reason}` : ''}`);
					// eslint-disable-next-line @typescript-eslint/no-unused-vars
				} catch (error) {
					// Do nothing
				}
			}, 0);
		}
	}
}

/**
 * Types and utilities for working with EncString in a manner similar to the provided Rust code, but implemented in TypeScript using `node:crypto` and `node:buffer`. This code assumes:
 *
 * - Use of AES-CBC and HMAC-SHA256 for encryption/decryption and integrity.
 * - SymmetricCryptoKey is represented as keys derived from base64-encoded raw key material.
 *
 * NOTE: The actual encryption/decryption logic will differ from the Rust code since the Rust code uses its own AES/HMAC implementations and data structures, while here we rely on the native Crypto API to ensure keys and inputs align with what the Rust code expects.
 */

/**
 * Represents a symmetric key for encryption/decryption and optional MAC.
 */
class SymmetricCryptoKey {
	public encKey: Buffer;
	public macKey?: Buffer; // optional, required for variants 1 and 2

	constructor(encKey: Buffer, macKey?: Buffer) {
		this.encKey = encKey;
		this.macKey = macKey;
	}

	/**
	 * Given a base64-encoded string containing a 32-byte key or a combined key,
	 * derive `encKey` and optionally `macKey`.
	 *
	 * For variant 1: The 32-byte key is split into two 16-byte segments:
	 *  - first 16 bytes: encryption key (AES-128-CBC)
	 *  - last 16 bytes: HMAC-SHA256 key
	 *
	 * For variant 0: Only AES-256-CBC key is used, no MAC key.
	 * For variant 2: A 32-byte AES-256-CBC key and a separate 32-byte HMAC-SHA256 key are expected.
	 *
	 * Adjust logic as needed for your actual key material layout.
	 */
	static fromBase64Key(keyB64: string, variant: 0 | 1 | 2): SymmetricCryptoKey {
		const keyRaw = Buffer.from(keyB64, 'base64');
		if (variant === 0) {
			// Expect a 32-byte key for AES-256-CBC
			if (keyRaw.length !== 32) {
				throw new Error('Invalid key length for variant 0. Expected 32 bytes.');
			}

			return new SymmetricCryptoKey(keyRaw);
		} else if (variant === 1) {
			// 32-byte key total, 16 bytes for AES-128-CBC and 16 bytes for HMAC-SHA256
			if (keyRaw.length !== 32) {
				throw new Error('Invalid key length for variant 1. Expected 32 bytes.');
			}
			const encKeyRaw = keyRaw.subarray(0, 16);
			const macKeyRaw = keyRaw.subarray(16, 32);

			return new SymmetricCryptoKey(Buffer.from(encKeyRaw), Buffer.from(macKeyRaw));
		} else {
			// variant 2: keyRaw expected: 64 bytes (32 for AES-256-CBC, 32 for HMAC-SHA256)
			if (keyRaw.length !== 64) {
				throw new Error('Invalid key length for variant 2. Expected 64 bytes.');
			}
			const encKeyRaw = keyRaw.subarray(0, 32);
			const macKeyRaw = keyRaw.subarray(32, 64);

			return new SymmetricCryptoKey(Buffer.from(encKeyRaw), Buffer.from(macKeyRaw));
		}
	}
}

/**
 * EncString variants:
 * - 0: AesCbc256_B64 { iv, data }
 * - 1: AesCbc128_HmacSha256_B64 { iv, mac, data }
 * - 2: AesCbc256_HmacSha256_B64 { iv, mac, data }
 *
 * This class stores and manipulates the encoded form. It can parse from string/buffer and
 * serialize back to string/buffer. It can also encrypt/decrypt using provided keys.
 */
class EncString {
	encType: number; // 0,1,2
	_iv: Buffer;
	data: Buffer;
	mac?: Buffer;

	constructor(encType: number, iv: Buffer, data: Buffer, mac?: Buffer) {
		this.encType = encType;
		this._iv = iv;
		this.data = data;
		this.mac = mac;
	}

	/**
	 * Parse from a string like: `encType.iv|data` or `encType.iv|data|mac`
	 */
	static fromString(s: string): EncString {
		const [encTypeStr, remainder] = s.split('.', 2);
		if (!encTypeStr || remainder === undefined) {
			throw new Error(`Invalid EncString format`);
		}
		const parts = remainder.split('|');
		const encType = Number(encTypeStr);

		if (encType === 0 && parts.length === 2) {
			const iv = Buffer.from(parts[0]!, 'base64');
			const data = Buffer.from(parts[1]!, 'base64');
			if (iv.length !== 16) {
				throw new Error('Invalid IV length for variant 0');
			}
			return new EncString(encType, iv, data);
		} else if ((encType === 1 || encType === 2) && parts.length === 3) {
			const iv = Buffer.from(parts[0]!, 'base64');
			const data = Buffer.from(parts[1]!, 'base64');
			const mac = Buffer.from(parts[2]!, 'base64');
			if (iv.length !== 16) {
				throw new Error('Invalid IV length for variant 1/2');
			}
			if (mac.length !== 32) {
				throw new Error('Invalid MAC length for variant 1/2');
			}
			return new EncString(encType, iv, data, mac);
		} else {
			throw new Error(`Invalid EncString: type ${encTypeStr} with ${parts.length} parts`);
		}
	}

	/**
	 * Convert to the string format: `encType.iv|data` or `encType.iv|data|mac`
	 */
	toString(): string {
		const parts: string[] = [this._iv.toString('base64'), this.data.toString('base64')];
		if (this.encType === 1 || this.encType === 2) {
			if (!this.mac) {
				throw new Error('MAC missing for variant 1/2');
			}
			parts.push(this.mac.toString('base64'));
		}
		return `${this.encType}.${parts.join('|')}`;
	}

	get iv(): Readonly<Buffer> {
		return this._iv;
	}

	/**
	 * Parse from a binary buffer: [encType, ...iv, ...mac?, ...data]
	 */
	static fromBuffer(buf: Buffer): EncString {
		if (buf.length < 1) {
			throw new Error('Buffer too short');
		}
		const encType = buf[0];
		if (encType === 0) {
			// 1 + 16 + data
			if (buf.length < 1 + 16) throw new Error('Buffer too short for variant 0');
			const iv = buf.subarray(1, 17);
			const data = buf.subarray(17);
			return new EncString(encType, iv, data);
		} else if (encType === 1 || encType === 2) {
			// 1 + 16 + 32 + data
			if (buf.length < 1 + 16 + 32) throw new Error(`Buffer too short for variant ${encType}`);
			const iv = buf.subarray(1, 17);
			const mac = buf.subarray(17, 49);
			const data = buf.subarray(49);
			return new EncString(encType, iv, data, mac);
		} else {
			throw new Error(`Invalid encType ${encType}`);
		}
	}

	/**
	 * Convert to binary buffer
	 */
	toBuffer() {
		if (this.encType === 0) {
			return Buffer.concat([Buffer.from([this.encType]), this._iv, this.data]);
		} else {
			if (!this.mac) {
				throw new Error('MAC missing for variant 1/2');
			}
			return Buffer.concat([Buffer.from([this.encType]), this._iv, this.mac, this.data]);
		}
	}

	/**
	 * Encrypt data into variant 2 (AES256 + HMAC-SHA256).
	 * Adjust as needed for other variants.
	 */
	static encryptAes256Hmac(dataDec: Buffer, key: SymmetricCryptoKey, iv: Buffer = randomBytes(16)): EncString {
		if (!key.macKey) {
			throw new Error('MAC key required for variant 2 encryption');
		}

		const cipher = createCipheriv('aes-256-cbc', key.encKey, iv);
		const data = Buffer.concat([cipher.update(dataDec), cipher.final()]);

		// Compute MAC over IV || data
		const mac = createHmac('sha256', key.macKey)
			.update(Buffer.concat([iv, data]))
			.digest();

		return new EncString(2, iv, data, mac);
	}

	/**
	 * Decrypt data for all variants
	 */
	decryptWithKey(key: SymmetricCryptoKey): Buffer {
		if (this.encType === 0) {
			// AES-256 no MAC
			if (key.macKey) {
				// If MAC key is present, we must fail per original logic
				throw new Error('MacNotProvided');
			}

			const decipher = createDecipheriv('aes-256-cbc', key.encKey, this._iv);
			return Buffer.concat([decipher.update(this.data), decipher.final()]);
		} else if (this.encType === 1) {
			// AES-128 + HMAC-SHA256
			// Key expected to be split 16 bytes for AES, 16 for HMAC
			// Here we assume `key.encKey` and `key.macKey` were derived accordingly.
			if (!key.macKey) {
				throw new Error('Missing MAC key for variant 1');
			}

			// Verify MAC
			const computedMac = createHmac('sha256', key.macKey)
				.update(Buffer.concat([this._iv, this.data]))
				.digest();

			if (!timingSafeEqual(computedMac, this.mac!)) {
				throw new Error('Invalid MAC');
			}

			const decipher = createDecipheriv('aes-128-cbc', key.encKey, this._iv);
			return Buffer.concat([decipher.update(this.data), decipher.final()]);
		} else if (this.encType === 2) {
			// AES-256 + HMAC-SHA256
			if (!key.macKey) {
				throw new Error('InvalidMac');
			}

			// Verify MAC
			const computedMac = createHmac('sha256', key.macKey)
				.update(Buffer.concat([this._iv, this.data]))
				.digest();

			if (!timingSafeEqual(computedMac, this.mac!)) {
				throw new Error('Invalid MAC');
			}

			const decipher = createDecipheriv('aes-256-cbc', key.encKey, this._iv);
			return Buffer.concat([decipher.update(this.data), decipher.final()]);
		} else {
			throw new Error(`Invalid encType ${this.encType}`);
		}
	}

	/**
	 * Encrypt data (Uint8Array) with a symmetric key into variant 2 by default
	 */
	static encryptWithKey(data: Buffer, key: SymmetricCryptoKey): EncString {
		// Always produce variant 2 (AES256 + HMAC)
		return EncString.encryptAes256Hmac(data, key);
	}

	/** Convenience method for encrypting strings */
	static encryptStringWithKey(str: string, key: SymmetricCryptoKey): EncString {
		return EncString.encryptWithKey(Buffer.from(str, 'utf8'), key);
	}

	decryptToString(key: SymmetricCryptoKey): string {
		return this.decryptWithKey(key).toString('utf8');
	}
}
