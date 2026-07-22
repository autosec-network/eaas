import { deriveId, getStub, type DOLocator } from '../../../do-proxy/src/helpers/locator';
import { fromWire, toWire } from '../../../do-proxy/src/helpers/serialize';

export { deriveId };
export type { DOLocator };

/**
 * Method-shaped record used only to call the forwarded RPC method on the proxy binding without pulling in each proxy's specific generated type.
 */
type ProxyCallable = Record<string, (locator: DOLocator, ...args: unknown[]) => unknown>;

/**
 * Property names that must always resolve locally instead of being forwarded to the proxy `WorkerEntrypoint`: id/name accessors and the promise-interop hooks (so an accidental `await stub` doesn't route through the proxy). Everything else on a Durable Object stub is a callable RPC method.
 */
const STUB_PASSTHROUGH = new Set<string>(['id', 'name', 'then', 'catch', 'finally']);

/**
 * True when running in local dev — detected by the absence of the `GIT_HASH` binding, which only deployed environments have (injected at publish time). See `workers/AGENTS.md`.
 */
export function isLocal(platform: QwikCityPlatform): boolean {
	return !('GIT_HASH' in platform.env);
}

/**
 * Resolve a Durable Object stub, redirecting through `do-proxy` when — and only when — running locally with the matching proxy service binding present.
 *
 * Jurisdictions don't exist in local `workerd` (any `namespace.jurisdiction(...)` op throws), and Durable Object bindings can't be `remote: true` in local dev. So instead of computing a jurisdictional `DurableObjectId` locally, the caller passes a raw {@link DOLocator} (`{ jurisdiction?, name?, id? }`); locally we return a stub-shaped object that forwards each RPC method call through the proxy `WorkerEntrypoint` (which runs `remote: true` on real Cloudflare infrastructure and does the `.jurisdiction()` + `idFrom*` there). When deployed (or when the proxy binding is absent) the id is derived and the real stub returned, so production behaviour is unchanged.
 *
 * @param platform Qwik platform — used to detect local dev.
 * @param namespace The **base** (never pre-`.jurisdiction()`'d) Durable Object namespace binding.
 * @param proxyBinding The `do-proxy` service binding for this DO (e.g. `platform.env.USER_D0_PROXY`), or `undefined` when unbound.
 * @param locator Raw jurisdiction + `name`/`id` describing which instance to reach.
 */
export function resolveDoStub<DO extends Rpc.DurableObjectBranded>(platform: QwikCityPlatform, namespace: DurableObjectNamespace<DO>, proxyBinding: Fetcher | undefined, locator: DOLocator): DurableObjectStub<DO> {
	if (isLocal(platform) && proxyBinding) {
		return new Proxy({} as DurableObjectStub<DO>, {
			get(_target, prop) {
				if (typeof prop === 'string' && !STUB_PASSTHROUGH.has(prop)) {
					// Wire-convert args out and the result back (the `remote: true` binding can't serialize `ArrayBuffer`/`Date`), and `Promise.resolve(...)` adopts the RPC result into a native promise (Cloudflare's RPC return is a thenable without `.catch`/`.finally`, which callers here use).
					return (...args: unknown[]) => Promise.resolve((proxyBinding as unknown as ProxyCallable)[prop]!(locator, ...args.map(toWire))).then(fromWire);
				}
				return undefined;
			},
		});
	}

	// Deployed (or no proxy): derive the id and return the real stub. Safe here because jurisdictions work outside local `workerd`.
	return getStub(namespace, locator);
}
