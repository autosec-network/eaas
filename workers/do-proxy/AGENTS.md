# AGENTS.md — `do-proxy` worker

Read the root `AGENTS.md` first. Path alias here: `~/*` → `src`.

Local-dev-only RPC proxy in front of the Durable Objects owned by `api` and `customer`. See `README.md` for the full rationale and shape.

## When editing this worker

- Every proxy method must keep the exact name of the Durable Object method it forwards to, with a `DOLocator` (`src/helpers/locator.ts`) prepended as the first parameter and the DO method's own parameters following, unchanged.
- `alarm`/`connect`/`webSocketMessage`/`webSocketClose`/`webSocketError` are never proxied — Cloudflare's RPC layer excludes these from `DurableObjectStub<T>` entirely (they're reserved runtime lifecycle handlers), so `getStub(...).alarm()` etc. won't even type-check.
- If a Durable Object in `api`/`customer` gains, loses, or changes a public method, update the matching `declare class` in `src/types.ts` **and** the matching proxy entrypoint together — nothing regenerates these automatically (see the "Not yet wired up" caveat in `README.md` for why).
- **Never add a `paths` remap to `tsconfig.json`** (no `~/*` alias like the other workers use) — use relative imports (`../helpers/locator`, `../types`) instead. `api` and `customer` both consume this worker's entrypoint types via a direct relative import straight into `src/index.ts` (see their own `src/types.ts`), not via `wrangler types` RPC introspection — a `~/*` alias here would resolve against whichever worker's tsconfig is doing the compiling, not `do-proxy`'s own, silently corrupting the types. For the same reason, don't add a generated `worker-configuration.d.ts`/`Cloudflare.Env` merge here either — pull ambient Workers runtime types (`DurableObjectNamespace`, `ExecutionContext`, `cloudflare:workers`, etc.) straight from `@cloudflare/workers-types` (already in `tsconfig.json`'s `types`), since `Cloudflare.Env` is a single global ambient namespace and a locally-generated one here would collide with the consuming worker's own.
- `src/index.ts`'s exports are the only thing that matters for consumers — don't remove or rename an entrypoint export without checking `api`'s and `customer`'s `src/types.ts` for a matching import.
