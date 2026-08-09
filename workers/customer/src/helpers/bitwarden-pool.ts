import { acquireBitwardenSession, bitwardenSessionFingerprint } from 'helpers/bitwarden-sessions';
import { Buffer } from 'node:buffer';
import type { DOJurisdictions } from 'types';
import { isLocal, resolveDoStub } from '~/helpers/do-proxy';
import type { EnvVars } from '~/types';

type BitwardenStub = ReturnType<EnvVars['BITWARDEN_SESSION']['get']>;

/**
 * Everything it takes to reach a tenant's Bitwarden session pool from a Qwik server action or loader, and to open a session into it when nothing pooled can serve the call.
 */
export interface PooledBitwardenSessionOptions {
	jurisdiction: DOJurisdictions | null;
	/**
	 * The tenant Durable Object whose pool this session belongs to.
	 */
	t_do_id_hex: string;
	/**
	 * Which tenant a newly opened session attributes its lifecycle audit rows to. `null` leaves it unlogged - see `BitwardenSession.initOptions.t_id`.
	 */
	log_t_id_hex: string | null;
	/**
	 * The signed-in person behind the request. A dashboard session always has one; nothing here is triggered by an API key.
	 */
	u_id: string;
	endpoints: { base: string; authentication: string };
	accessToken: string;
}

function tenantStub(platform: QwikCityPlatform, jurisdiction: DOJurisdictions | null, do_id_hex: string) {
	return resolveDoStub(platform, platform.env.TENANT_D0, platform.env.TENANT_D0_PROXY, { id: do_id_hex, jurisdiction: jurisdiction ?? undefined });
}

/**
 * An authenticated Bitwarden Secrets Manager session on `options.endpoints` as `options.accessToken` - reused from the tenant's pool when one is already open and free, opened (and pooled) when not.
 *
 * **Nothing here owns what it gets back.** A pooled session is shared with every other request, loader and Workflow working on this tenant, and it ends itself when its token expires; a `nuke()` in a `finally` block would pull it out from under whatever else is mid-call. See `acquireBitwardenSession` in `helpers/bitwarden-sessions` for the rest of the contract.
 */
export async function openBitwardenSession(platform: QwikCityPlatform, options: PooledBitwardenSessionOptions): Promise<BitwardenStub> {
	const tenant = tenantStub(platform, options.jurisdiction, options.t_do_id_hex);
	// Only sessions on these exact credentials are interchangeable - our managed organization and the tenant's own vault share a tenant but never a session
	const fingerprint = await bitwardenSessionFingerprint(options.endpoints, options.accessToken);

	const stubFor = (do_id: string) => resolveDoStub(platform, platform.env.BITWARDEN_SESSION, platform.env.BITWARDEN_SESSION_PROXY, { id: do_id, jurisdiction: options.jurisdiction ?? undefined });

	return acquireBitwardenSession<BitwardenStub>({
		list: () => tenant.listBitwardenSessions({ fingerprint }).then((rows) => rows.map(({ do_id }) => do_id)),
		stub: stubFor,
		probe: (stub) => stub.available(),
		forget: (do_id) => tenant.unregisterBitwardenSession(do_id),
		create: async () => {
			// An id minted by the local `workerd` namespace isn't valid for the deployed one the proxy resolves against, so when proxying, mint it on the proxy (which can also apply the jurisdiction workerd doesn't support).
			const useProxy = isLocal(platform) && !!platform.env.BITWARDEN_SESSION_PROXY;
			const bw_id = useProxy ? await platform.env.BITWARDEN_SESSION_PROXY!.newUniqueId(options.jurisdiction ?? undefined) : (options.jurisdiction ? platform.env.BITWARDEN_SESSION.jurisdiction(options.jurisdiction) : platform.env.BITWARDEN_SESSION).newUniqueId().toString();
			const stub = stubFor(bw_id);

			await stub.init({
				t_jurisdiction: options.jurisdiction,
				t_do_id: (() => {
					const mainBuffer = Buffer.from(options.t_do_id_hex, 'hex');
					return mainBuffer.buffer.slice(mainBuffer.byteOffset, mainBuffer.byteOffset + mainBuffer.byteLength);
				})(),
				t_id: options.log_t_id_hex,
				u_id: options.u_id,
				// Everything on the dashboard is a person acting, never an API key
				ak_id: null,
				endpoints: options.endpoints,
			});
			// Registers itself in the tenant's pool on the way out, so the next request finds it
			await stub.auth(options.accessToken);

			return stub;
		},
	});
}
