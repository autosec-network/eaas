# `do-proxy`

A local-dev-only utility worker. It has no logic of its own — it exposes one `WorkerEntrypoint` per Durable Object class owned by `api` and `customer`, and every method on those entrypoints just forwards the call to the real Durable Object stub.

## Why this exists

Wrangler's `remote: true` isn't supported on Durable Object bindings for local dev, so a locally-run `wrangler dev` can't talk to a Durable Object that only exists on a deployed (remote) Worker. Service bindings between Workers _do_ support `remote: true`, though — so this worker sits in front of the real DO bindings (as a normal, non-remote binding, since it itself always runs deployed) and re-exposes each DO's public methods over RPC. A local `wrangler dev` session can then reach it with a `remote: true` service binding instead of trying to bind the Durable Object directly.

## Shape

- `src/index.ts` — the `main` file; re-exports every entrypoint below (workerd only discovers exports from `main`) plus a default export that just 404s (this worker is only meant to be reached via RPC, never HTTP).
- `src/entrypoints/*.ts` — one `WorkerEntrypoint` per Durable Object (`BitwardenSessionProxy`, `TenantD0Proxy`, `TenantD0LogsProxy`, `UserD0Proxy`, `UserSessionProxy`). Every method has the same name and parameters as the Durable Object method it proxies, except the **first parameter is always a `DOLocator`** (`{ id, jurisdiction? }`, see `src/helpers/locator.ts`) that says which DO instance to route the call to.
- `src/helpers/locator.ts` — `getStub(namespace, locator)` resolves a `DOLocator` to a `DurableObjectStub`, applying `.jurisdiction(...)` first when one is given.
- `src/types.ts` — `EnvVars`, plus hand-typed mirrors of the public method surface of `api`'s and `customer`'s Durable Objects. This worker can't import those classes directly (they're not published as workspace packages), so these are maintained by hand instead of via `wrangler types` (same idea as the `declare class` stubs `wrangler types` generates for any other cross-service DO binding). **Keep these in sync manually** when the source DOs' public methods change.

## Why it targets `prod`, and why "dev" is unused right now

`wrangler.jsonc` here binds directly to the `-prod` Durable Objects of `api`/`customer`, not `-dev`. The service is still v0 — nothing has actually shipped to a separate dev tier yet, so all real testing (including local `wrangler dev` sessions) happens against `prod` data. `customer`'s and `api`'s own `wrangler.jsonc` mirror this: the service bindings to `do-proxy` live under their `env.prod`, not the top-level (`dev`) config, since that's the environment local dev actually runs against for now. The top-level `dev` config is a placeholder for v1, when a real separate dev tier exists — the bindings should move (or get duplicated) to the top level then.

## Wiring

`customer` and `api` both have `remote: true` service bindings to this worker's entrypoints under their `env.prod` (see each worker's `wrangler.jsonc` and `src/types.ts`) — one per Durable Object each of them uses, including their own locally-owned ones (not just cross-worker ones), per the "why it targets `prod`" rationale above.

- **`customer`** actively routes through these bindings. Its `~/helpers/do-proxy.ts` `resolveDoStub(...)` wraps every `namespace.get(doId)` call site: when running locally (no `GIT_HASH` binding) with the matching `*_PROXY` binding present, it returns a stub-shaped `Proxy` that forwards each RPC method call through the proxy `WorkerEntrypoint` (prepending a `DOLocator` built from the id); when deployed, it returns the real stub untouched, so production behaviour is unchanged. `drizzleD0(...)` DB wrappers ride on the same wrapped stub (via its forwarded `sqlExec`).
- **`api`** only has the bindings typed and reachable — no code calls through them yet.
