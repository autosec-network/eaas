# AGENTS.md — `workers/`

Read the root `AGENTS.md` first. This file covers rules that apply across every worker in this directory; worker-specific rules live in each worker's own `AGENTS.md`.

## Regenerate types after touching a worker's `wrangler.jsonc`

Whenever a worker's `wrangler.jsonc` changes — a binding added, removed, renamed, or its `script_name`/`entrypoint` changed — regenerate that worker's generated types before relying on them:

```
npm -w <pkg> run build:types:cf
```

This applies to every worker that consumes **generated** types (`admin`, `api`, `customer` — anything with a committed `worker-configuration.d.ts` and a `build:types:cf` script). It does **not** apply to `do-proxy`, which deliberately does not use generated types at all — it pulls ambient Workers types straight from `@cloudflare/workers-types` instead, specifically to avoid a `Cloudflare.Env`/`paths` namespace collision when its own types get consumed by other workers. See `do-proxy/AGENTS.md` for why.

If a change touches a binding that another worker cross-references (e.g. a Durable Object `script_name`, or a service binding to `do-proxy`), regenerate types for every affected worker, not just the one whose `wrangler.jsonc` you edited.

## Detecting local vs. deployed at runtime

Determine whether a worker is running locally by checking for the absence of the `GIT_HASH` binding on `env` — local dev never has it, only deployed environments do (it's injected at publish time). e.g. `const isLocal = !('GIT_HASH' in platform.env);` (see `admin/src/routes/layout.tsx`). Don't invent a separate `NODE_ENV`-style flag for this.

## `.nuke()` on a Durable Object always throws/rejects

Calling `.nuke(reason)` on a DO stub always causes that call's promise to reject with `Error: nuked: <reason>` (or bare `nuked` when no reason is passed — see `BaseD0.nuke`'s `this.ctx.abort(\`nuked${reason ? \`: ${reason}\` : ''}\`)`) — even when the nuke succeeded. That rejection is not itself a failure signal. Anywhere a nuke is awaited — directly, or alongside other cleanup work via `Promise.allSettled([...stub.nuke(...), ...])`— and the outcome is inspected afterward (a`.then`/`.catch`chain, a settled-results filter, a`finally`block that runs more code after the nuke), the expected rejection must be excluded before deciding whether a *real* error occurred. Check`error instanceof Error && error.message.startsWith('nuked')`, not an exact match — don't let it trip an `AggregateError`/failure path, silently skip cleanup code that was chained after the nuke, or (worst case, inside a `finally`) clobber a genuine error/success from the corresponding `try` block.

`admin` has a shared `isNukedError()` helper for this in `admin/src/routes/[environment]/tenants/tenant-ops.ts` — reuse it (import across route files, as `user-ops.ts` and the sessions route already do) rather than re-deriving the check. Fixed instances: `purgeTenant` and `deleteByoBwSecret` in `tenant-ops.ts`, `purgeUser` in `user-ops.ts`, `useNukeOrphanedDo` in `tenants/index.tsx`, `useEndSessions` in `users/[uid]/sessions/index.tsx`. This applies wherever `.nuke()` is called across workers (`admin`, `customer`, `api`, `do-proxy`), not just those call sites — `customer` and `api` currently fire nukes off via `ctx.waitUntil()` without inspecting the result, which sidesteps this specific bug but still logs a spurious rejection on every successful nuke.

## Durable Object jurisdictions don't exist locally

`namespace.jurisdiction(...)` (and any `idFromName`/`idFromString`/`newUniqueId`/`get` on a jurisdictional sub-namespace) **throws in local `workerd`** — `"Jurisdiction restrictions are not implemented in workerd."`. So local code must never compute a jurisdictional `DurableObjectId` itself. When a DO is reached through `do-proxy` (which runs `remote: true` on real Cloudflare infrastructure), pass the **raw** jurisdiction string plus a `name` or `id` in the `DOLocator` and let the proxy do the `.jurisdiction()` + `idFrom*` there. See `customer/src/helpers/do-proxy.ts` (`resolveDoStub`) and `do-proxy/src/helpers/locator.ts`. The same goes for **new** ids, ephemeral ones included: a `newUniqueId()` minted against the locally simulated namespace is rejected by the deployed namespace the proxy resolves against (`idFromString` throws `"Invalid Durable Object ID. The ID does not match this Durable Object class."`). Whenever a proxy is in play, mint/resolve on the proxy (`newUniqueId`/`resolveId`) — never locally.
