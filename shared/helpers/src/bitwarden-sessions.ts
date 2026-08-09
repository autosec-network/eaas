/**
 * The rules a pool of reusable `BitwardenSession` Durable Objects runs by, in one place because both ends of the pool depend on agreeing exactly: the session itself (`workers/api/do/BitwardenSession.ts`) enforces them, and every worker that borrows one (`api`'s Workflows, `customer`'s dashboard actions, `admin`'s tenant tools) reacts to them.
 */

/**
 * How many calls one session Durable Object will run at the same time before it starts turning callers away with {@link BitwardenSessionBusyError}.
 *
 * A Durable Object is single threaded, and a pooled session is addressed by every Worker instance that happens to want the same vault at the same moment - so without a cap, one popular session becomes a queue everybody waits behind. Turning the 7th caller away is cheaper than serialising it: the caller just borrows a different session (or opens one), which is the whole point of there being a pool.
 *
 * Set to 6 to mirror Cloudflare's own ceiling on simultaneous connections per Worker invocation - a Worker only ever has 6 `fetch()`es in flight waiting on headers at once, so a session Durable Object built to serve exactly one Worker instance would never be asked to run more than 6 Bitwarden calls concurrently in the first place. That's the ideal this pool is standing in for: one dedicated session per Worker instance is what "single threaded and no reuse needed" would actually look like, but authenticating that many separate sessions against the *same* Bitwarden service account simultaneously, at scale, risks tripping Bitwarden's own abuse/anomaly detection on the identity endpoint. Pooling trades that off - fewer, shared sessions - which is exactly why they need this cap: an unbounded number of Workers sharing one session Durable Object would otherwise bottleneck it far past what one dedicated session ever would have handled, or run it out of CPU. Borrowing the platform's own number keeps the shared session's real ceiling the same as the un-pooled one it's standing in for, rather than an arbitrary pick.
 * @link https://developers.cloudflare.com/workers/platform/limits/#simultaneous-open-connections
 *
 * Also the ceiling for any caller-side fan-out onto a *single* session (bulk decrypts, mostly) - chunk at this width, not wider, or the fan-out trips the cap against itself.
 */
export const MAX_BITWARDEN_SESSION_TASKS = 6;

/**
 * `name` of {@link BitwardenSessionBusyError}. Its own constant because Durable Object RPC only carries an error's `name`/`message` to the caller - a custom class doesn't survive the hop, so recognition is by these strings and nothing else.
 * @link https://developers.cloudflare.com/workers/runtime-apis/rpc/error-handling/
 */
export const BITWARDEN_SESSION_BUSY = 'BitwardenSessionBusy';

/**
 * Thrown by a session already running {@link MAX_BITWARDEN_SESSION_TASKS} tasks. Not a failure of the call - the work simply never started, so the caller is free to run it against a different session, and {@link acquireBitwardenSession} does exactly that.
 */
export class BitwardenSessionBusyError extends Error {
	public override readonly name = BITWARDEN_SESSION_BUSY;

	constructor(do_id: string) {
		super(`${BITWARDEN_SESSION_BUSY}: session ${do_id} is already running ${MAX_BITWARDEN_SESSION_TASKS} tasks`);
	}
}

/**
 * Whether a rejection is a session refusing more concurrent work. Mirrors `isNukedError`'s shape (`workers/admin/.../tenant-ops.ts`) for the same reason: after an RPC hop there is no class left to `instanceof`, only `name` and `message`.
 */
export function isBitwardenSessionBusyError(error: unknown): boolean {
	return error instanceof Error && (error.name === BITWARDEN_SESSION_BUSY || error.message.startsWith(BITWARDEN_SESSION_BUSY));
}

/**
 * Which credential a session is authenticated as, as a value safe to store in a tenant's database.
 *
 * Two sessions are interchangeable only if they authenticated the same access token against the same endpoints - a session on our managed organization can't serve a call meant for a tenant's own vault, and vice versa - so the pool is keyed by this rather than by tenant alone. sha512 of the three inputs: the token never rests anywhere here, and the digest is only ever compared, never reversed. sha512 rather than sha256 purely because the digest is cheap to compute and store either way and there's no reason to take the smaller margin - this hash has no compatibility constraint pulling it toward a specific algorithm the way the Bitwarden protocol's own HMAC-SHA256 calls in `BitwardenSession.ts` do.
 *
 * Both ends of the pool derive it through this one function on purpose. Two hand-rolled digests that drift apart wouldn't fail loudly; they'd just quietly stop matching, and every acquire would mint a new session forever. Endpoints are normalized here for the same reason: the session hashes the copies it stored (which `BitwardenSession.initOptions` ran through Zod's `normalize: true`, i.e. `new URL(x).href`), while a borrower hashes whatever string it happens to be holding - one trailing slash apart would be two different pools.
 */
export function bitwardenSessionFingerprint(endpoints: { base: string; authentication: string }, accessToken: string): Promise<string> {
	return import('node:crypto').then(({ createHash }) =>
		createHash('sha512')
			// `\n` can't appear in a URL or a Bitwarden access token, so the joined string is unambiguous
			.update([new URL(endpoints.base).href, new URL(endpoints.authentication).href, accessToken].join('\n'), 'utf8')
			.digest('hex'),
	);
}

/**
 * Everything {@link acquireBitwardenSession} needs to reach a pool, as callbacks: each Worker addresses Durable Objects differently (`customer` routes through a local-dev proxy, `admin` binds the `_PROD` namespace cross-worker, `api` holds the namespace directly), so the pool logic stays here and the addressing stays with whoever knows how to do it.
 */
export interface BitwardenSessionPool<TStub> {
	/**
	 * Durable Object ids of this tenant's pooled sessions carrying the fingerprint being acquired for, already filtered to the unexpired ones.
	 */
	list: () => Promise<string[]>;
	/**
	 * A stub for one of {@link list}'s ids. May throw - an id minted in another jurisdiction isn't addressable from this namespace - which is treated the same as the session being unusable.
	 */
	stub: (do_id: string) => TStub;
	/**
	 * Ask the session whether it can take work: it must be authenticated, unexpired, and under {@link MAX_BITWARDEN_SESSION_TASKS}. Anything else rejects.
	 */
	probe: (stub: TStub) => Promise<unknown>;
	/**
	 * Drop a pool row whose session no longer answers as one. Best effort - a row that outlives its session is a wasted probe, not a correctness problem.
	 */
	forget: (do_id: string) => Promise<unknown>;
	/**
	 * Mint, `init()` and `auth()` a brand new session. Registering it in the pool is the session's own job, so this only has to hand back the stub.
	 */
	create: () => Promise<TStub>;
}

/**
 * Unbiased shuffle (random sort key per item), so "pick a random session" doesn't quietly become "pick the oldest" - which would pile every caller onto one session and defeat the cap.
 */
function shuffle<T>(items: T[]): T[] {
	return items
		.map((item) => ({ item, order: Math.random() }))
		.sort((a, b) => a.order - b.order)
		.map(({ item }) => item);
}

/**
 * Borrow a session out of the tenant's pool, or open one if the pool can't serve this call.
 *
 * Walks the tenant's unexpired sessions for this fingerprint in random order, probing each: a busy one (see {@link BitwardenSessionBusyError}) is skipped and left alone, a dead one is skipped *and* forgotten, and the first one that answers is handed back. Only when none can take the work does it open a new session - which then joins the pool for everybody else.
 *
 * **The returned session is shared, and the caller does not own it.** Don't `nuke()` it when you're done - it expires and tears itself down on its own (see `BitwardenSession.alarm`), and nuking it out from under whoever else is mid-call is exactly what pooling exists to avoid. The only legitimate teardown is a tenant going away entirely.
 *
 * **Don't retry a whole sequence of calls on a busy error.** The probe above is what keeps a busy session from being handed out in the first place; a rejection that still surfaces mid-sequence should propagate (to the Workflow's own retry, or to the user) rather than replaying calls that already ran - `setSecret` is not idempotent, and a replayed one leaves an orphaned copy of live key material.
 */
export async function acquireBitwardenSession<TStub>(pool: BitwardenSessionPool<TStub>): Promise<TStub> {
	// A pool that can't be read is a pool that can't be used - never a reason to fail the call the session was wanted for
	const pooled = await pool.list().catch((error: unknown) => {
		console.error('Failed to list pooled bitwarden sessions', error);
		return [] as string[];
	});

	for (const do_id of shuffle(pooled)) {
		try {
			const stub = pool.stub(do_id);
			await pool.probe(stub);
			return stub;
		} catch (error) {
			// Busy is a "not this one" answer, and the session is perfectly healthy - leave its row alone
			if (isBitwardenSessionBusyError(error)) continue;

			// Anything else means the row outlived the session it names (it self-nuked on expiry, or its registration lost a race with its own teardown). Drop it so the next acquire doesn't pay for the same dead id.
			await pool.forget(do_id).catch((forgetError: unknown) => console.error('Failed to forget stale bitwarden session', forgetError));
		}
	}

	return pool.create();
}
