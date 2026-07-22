import type { DOJurisdictions } from 'types';
import { fromWire, toWire } from './serialize';

/**
 * Identifies which Durable Object instance an RPC call should be routed to.
 *
 * The id derivation — `namespace.jurisdiction(...)` plus `idFromName`/`idFromString` — happens *here*, inside the proxy, because this worker runs on real Cloudflare infrastructure where jurisdictions work. In local `workerd` any jurisdictional namespace operation throws (`"Jurisdiction restrictions are not implemented in workerd."`), so callers must hand over the raw jurisdiction string plus either a `name` or an `id` and let the proxy do the derivation, rather than pre-computing a jurisdictional `DurableObjectId` locally.
 */
export interface DOLocator {
	/**
	 * Applied via `namespace.jurisdiction(...)` before deriving the id. Must match the jurisdiction the id was originally created under, if any.
	 */
	jurisdiction?: DOJurisdictions;
	/**
	 * Derive the id via `idFromName(name)`. Takes precedence over {@link id} when both are set.
	 */
	name?: string;
	/**
	 * Derive the id via `idFromString(id)` — where `id` is a hex `DurableObjectId.toString()`.
	 */
	id?: string;
}

function scopedNamespace<T extends Rpc.DurableObjectBranded | undefined>(namespace: DurableObjectNamespace<T>, jurisdiction?: DOJurisdictions) {
	return jurisdiction ? namespace.jurisdiction(jurisdiction) : namespace;
}

/**
 * Resolve a {@link DOLocator} to a concrete `DurableObjectId` on the given namespace.
 */
export function deriveId<T extends Rpc.DurableObjectBranded | undefined>(namespace: DurableObjectNamespace<T>, locator: DOLocator): DurableObjectId {
	const scoped = scopedNamespace(namespace, locator.jurisdiction);
	return locator.name !== undefined ? scoped.idFromName(locator.name) : scoped.idFromString(locator.id!);
}

export function getStub<T extends Rpc.DurableObjectBranded | undefined>(namespace: DurableObjectNamespace<T>, locator: DOLocator) {
	return scopedNamespace(namespace, locator.jurisdiction).get(deriveId(namespace, locator));
}

/**
 * Property names that must resolve on the underlying stub rather than being treated as a forwarded RPC method — id/name accessors and promise-interop hooks. Everything else accessed on the wrapper is a callable Durable Object RPC method.
 */
const WIRE_PASSTHROUGH = new Set<string>(['id', 'name', 'then', 'catch', 'finally']);

/**
 * Like {@link getStub}, but wraps the stub so method arguments are {@link fromWire}'d before reaching the real Durable Object and results are {@link toWire}'d on the way back. Proxy entrypoints use this (they're only ever reached over the wire-limited `remote: true` binding); the customer's own deployed path uses the plain {@link getStub}, since direct RPC structured-clones those types natively.
 */
export function getWireStub<T extends Rpc.DurableObjectBranded | undefined>(namespace: DurableObjectNamespace<T>, locator: DOLocator): DurableObjectStub<T> {
	const stub = getStub(namespace, locator);
	return new Proxy(stub, {
		get(target, prop, receiver) {
			if (typeof prop === 'string' && !WIRE_PASSTHROUGH.has(prop)) {
				// Call the method directly on the stub — Cloudflare RPC stubs intercept property access as remote method names, so `.apply`/`.call` don't work and the member-access-plus-call must stay atomic.
				return (...args: unknown[]) => Promise.resolve((target as unknown as Record<string, (...methodArgs: unknown[]) => unknown>)[prop]!(...args.map(fromWire))).then(toWire);
			}
			return Reflect.get(target, prop, receiver);
		},
	});
}

/**
 * Mint a fresh unique id (optionally under a jurisdiction) and return its string form. For callers that need a brand-new DO id — e.g. a session token — but can't run `newUniqueId()` under a jurisdiction in local `workerd`.
 */
export function mintUniqueId<T extends Rpc.DurableObjectBranded | undefined>(namespace: DurableObjectNamespace<T>, jurisdiction?: DOJurisdictions): string {
	return scopedNamespace(namespace, jurisdiction).newUniqueId().toString();
}
