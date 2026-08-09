import { acquireBitwardenSession, bitwardenSessionFingerprint } from 'helpers/bitwarden-sessions';
import { Buffer } from 'node:buffer';
import type { DOJurisdictions } from 'types';
import type { EnvVars } from '~/types';

type BitwardenStub = ReturnType<EnvVars['BITWARDEN_SESSION']['get']>;

/**
 * Everything it takes to reach a tenant's Bitwarden session pool and, if nothing in it can serve the call, open a session that joins it.
 */
export interface PooledBitwardenSessionOptions {
	jurisdiction: DOJurisdictions | null;
	/**
	 * The tenant Durable Object whose pool this session belongs to. Sessions are pooled per tenant, not globally: a tenant's own database is the only place a list of them is worth keeping, and it's wiped along with everything else when the tenant goes.
	 */
	t_do_id_hex: string;
	/**
	 * Which tenant a newly opened session attributes its lifecycle audit rows to - not always the tenant whose pool it lands in (a vault migration builds a second tenant beside the first). `null` leaves a new session unlogged; see `BitwardenSession.initOptions.t_id`.
	 */
	log_t_id_hex: string | null;
	u_id: string | null;
	ak_id: string | null;
	endpoints: { base: string; authentication: string };
	accessToken: string;
}

function tenantStub(env: EnvVars, jurisdiction: DOJurisdictions | null, do_id_hex: string) {
	return env.TENANT_D0.get((jurisdiction ? env.TENANT_D0.jurisdiction(jurisdiction) : env.TENANT_D0).idFromString(do_id_hex));
}

function sessionNamespace(env: EnvVars, jurisdiction: DOJurisdictions | null) {
	return jurisdiction ? env.BITWARDEN_SESSION.jurisdiction(jurisdiction) : env.BITWARDEN_SESSION;
}

/**
 * An authenticated Bitwarden Secrets Manager session on `options.endpoints` as `options.accessToken` - reused from the tenant's pool whenever one is already open and free, and opened (then pooled) when not.
 *
 * **The caller does not own what it gets back.** A pooled session tears itself down when its token expires; nuking it because you're finished with it would yank it out from under whatever else is mid-call on it. See `acquireBitwardenSession` for the rest of the contract, including why a `BitwardenSessionBusyError` that surfaces mid-sequence must not be answered by replaying the sequence.
 */
export async function openBitwardenSession(env: EnvVars, options: PooledBitwardenSessionOptions): Promise<BitwardenStub> {
	const namespace = sessionNamespace(env, options.jurisdiction);
	const tenant = tenantStub(env, options.jurisdiction, options.t_do_id_hex);
	// Only sessions on these exact credentials are interchangeable - our managed organization and a tenant's own vault are different pools that happen to share a tenant
	const fingerprint = await bitwardenSessionFingerprint(options.endpoints, options.accessToken);

	return acquireBitwardenSession<BitwardenStub>({
		list: () => tenant.listBitwardenSessions({ fingerprint }).then((rows) => rows.map(({ do_id }) => do_id)),
		stub: (do_id) => env.BITWARDEN_SESSION.get(namespace.idFromString(do_id)),
		probe: (stub) => stub.available(),
		forget: (do_id) => tenant.unregisterBitwardenSession(do_id),
		create: async () => {
			const stub = env.BITWARDEN_SESSION.get(namespace.newUniqueId());

			await stub.init({
				t_jurisdiction: options.jurisdiction,
				t_do_id: (() => {
					const mainBuffer = Buffer.from(options.t_do_id_hex, 'hex');
					return mainBuffer.buffer.slice(mainBuffer.byteOffset, mainBuffer.byteOffset + mainBuffer.byteLength);
				})(),
				t_id: options.log_t_id_hex,
				u_id: options.u_id,
				ak_id: options.ak_id,
				endpoints: options.endpoints,
			});
			// Registers itself in the tenant's pool on the way out, so the next caller finds it
			await stub.auth(options.accessToken);

			return stub;
		},
	});
}

/**
 * End every Bitwarden session pooled for a tenant, expired ones included.
 *
 * For tenant teardown only, and it has to run **before** the tenant's own Durable Object is wiped: each session removes its own pool row as it goes (see `BitwardenSession.nuke`), and any RPC to an already-purged tenant would recreate it as an orphan. Leaving the sessions behind instead would leave objects holding live vault credentials with nothing left to account for them.
 */
export async function nukeTenantBitwardenSessions(env: EnvVars, jurisdiction: DOJurisdictions | null, t_do_id_hex: string, reason: string) {
	const namespace = sessionNamespace(env, jurisdiction);
	const sessions = await tenantStub(env, jurisdiction, t_do_id_hex)
		.listBitwardenSessions({ includeExpired: true })
		// A pool that can't be read just means its sessions expire on their own schedule instead of now - never a reason to fail the teardown that asked
		.catch((error: unknown) => {
			console.error('Failed to list pooled bitwarden sessions for teardown', error);
			return [];
		});

	const settled = await Promise.allSettled(sessions.map(({ do_id }) => env.BITWARDEN_SESSION.get(namespace.idFromString(do_id)).nuke(reason)));
	settled.forEach((result) => result.status === 'rejected' && console.error('Failed to nuke pooled bitwarden session', result.reason));

	return { nuked: settled.filter(({ status }) => status === 'fulfilled').length, total: sessions.length };
}
