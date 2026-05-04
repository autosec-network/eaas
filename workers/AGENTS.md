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

## Durable Object jurisdictions don't exist locally

`namespace.jurisdiction(...)` (and any `idFromName`/`idFromString`/`newUniqueId`/`get` on a jurisdictional sub-namespace) **throws in local `workerd`** — `"Jurisdiction restrictions are not implemented in workerd."`. So local code must never compute a jurisdictional `DurableObjectId` itself. When a DO is reached through `do-proxy` (which runs `remote: true` on real Cloudflare infrastructure), pass the **raw** jurisdiction string plus a `name` or `id` in the `DOLocator` and let the proxy do the `.jurisdiction()` + `idFrom*` there. See `customer/src/helpers/do-proxy.ts` (`resolveDoStub`) and `do-proxy/src/helpers/locator.ts`. For genuinely ephemeral DOs (e.g. a throwaway `BitwardenSession`) it's fine to just drop the jurisdiction locally; for a brand-new persistent id, mint/resolve it on the proxy (`newUniqueId`/`resolveId`) rather than locally.
