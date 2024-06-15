# AGENTS.md

This file provides guidance to coding agents when working with code in this repository. It is agent-agnostic; nested `AGENTS.md` files in subdirectories add area-specific rules and take precedence within their subtree.

## What this is

**Encryption as a Service (EaaS)** — a pass-through crypto API inspired by HashiCorp Vault's Transit engine (pre-BSL). It never stores customer plaintext; data lives only long enough to run the operation. Key material is held in Bitwarden Secrets Manager; crypto uses `node:crypto`, Web Crypto, and `@noble/post-quantum` for PQC. Everything runs on Cloudflare Workers/Durable Objects/Workflows/D1/Analytics Engine. License: AGPL-3.0-only.

## Monorepo layout

npm workspaces (`shared/*`, `snippets/*`, `workers/*`). Each workspace is imported by its **package name**, not a relative path:

| Path                   | Package       | What it is                                                                                                   |
| ---------------------- | ------------- | ------------------------------------------------------------------------------------------------------------ |
| `shared/db`            | `db`          | Drizzle schemas + DB helpers for D1, Durable Object SQLite, and Analytics Engine. See `shared/db/AGENTS.md`. |
| `shared/helpers`       | `helpers`     | Crypto/UUID/API-key utilities.                                                                               |
| `shared/types`         | `types`       | Shared type defs + Zod schemas (Bitwarden, crypto catalog, tenants).                                         |
| `workers/api`          | `api`         | The Hono crypto API. See `workers/api/AGENTS.md`.                                                            |
| `workers/customer`     | `customer`    | Qwik City customer dashboard. See `workers/customer/AGENTS.md`.                                              |
| `workers/admin`        | `admin`       | Qwik City internal admin dashboard. See `workers/admin/AGENTS.md`.                                           |
| `snippets/image_proxy` | `image_proxy` | Small standalone image-proxy Worker snippet.                                                                 |

## Commands

Always inspect the nearest `package.json` scripts and prefer them over ad-hoc `tsc`/`vite`/`wrangler`/`eslint` invocations. Target a workspace with `npm -w <package> run <script>` (e.g. `npm -w api run build:types:tsc`).

**Repo-wide (run from root):**

- `npm run fmt` / `npm run fmt:fix` — Prettier check / write (config: `@demosjarco/prettier-config`, tabs).
- `npm run lint` / `npm run lint:fix` — ESLint across `**/*.*ts*`.
- `npm run clean` — clears `.wrangler` state and tsbuildinfo.

**Per workspace:**

- `npm -w <pkg> run lint` — lint one workspace.
- `npm -w <pkg> run build:types:tsc` — typecheck (no emit).
- `npm -w <pkg> run build:types:cf` — regenerate `worker-configuration.d.ts` from `wrangler.jsonc` bindings (run after changing bindings).
- `npm -w api run start` / `npm -w customer run start` / `npm -w admin run start` — local dev servers.

**Gotcha:** `db`, `helpers`, and `types` resolve to their `./dist` output via package `exports`. After editing a shared package, run its `npm -w <pkg> run build` before typechecking/running a consumer, or the consumer will see stale/missing types.

There is currently **no automated test suite**; validation is via typecheck, lint, and manual/local Wrangler runs.

## Global conventions

These apply everywhere. Framework-specific rules live in the nested files.

**File extensions**

- `.mts` for TypeScript modules (shared libs, helpers, Worker logic) — the default.
- `.ts` only when a platform forces it (Worker entry points, some generated files).
- `.tsx` for Qwik/JSX. `.mjs` for JS config files (ESLint, Prettier, Vite).

**Imports & path aliases**

- Cross-workspace: import by package name and subpath export — `db/wae`, `db/core`, `db/cache`, `db/schemas/root`, `helpers`, `helpers/noise`, `types/bw`, `types/crypto`. Do **not** use `~shared/*` (removed).
- Within a worker: `~/*` → `./src/*`, and (in `api`) `~do/*` → `./do/*`, `~wf/*` → `./wf/*`.
- Use `import type` for type-only imports.
- Dynamic imports (`await import(...)`, `Promise.all([...])` for parallel) are used in exactly two places, not as a general preference:
  - The root-most Cloudflare Worker file — the one referenced by `main` in `wrangler.json`/`wrangler.jsonc` — when it exports more than one handler type, and/or Durable Object(s), and/or Workflow(s).
  - In a Qwik file, when a library is only needed in server-side logic and/or would break client-side because it depends on something unavailable there.

**Code style**

- OOP where it fits: group logic into classes with static utilities + instance methods.
- Avoid `while` loops — use `for...of`, `map`, `filter`, `reduce`.
- Prefer promise chains (`.then/.catch/.finally`) for granular error handling; fall back to `try/catch` only when chains get unwieldy.
- **Never `void` an async call** in a Worker or SSR context — either `await` it or hand it to `ctx.waitUntil()` / `event.waitUntil()`. `void expr` silently drops the work when the request ends.
- Never log secrets — redact tokens/keys and strip sensitive headers (`authorization`, `cookie`, `x-api-key`).

**Zod** (both `zod/v4` and `zod/mini` are in play)

- Alias by version when importing directly from `zod/*`: `import * as zm from 'zod/mini'`, `import * as z4 from 'zod/v4'`, `import { z as z3 } from 'zod/v3'`. When `z` is re-exported by a framework (Qwik's `zod$`, Hono validators, `@hono/zod-openapi`), import it as plain `z` — the upstream version is unknown, so aliasing would mislead.
- Prefer `zod/mini`. Call `.trim()` **first** in any string chain, then format/length checks, then `.transform()` last.
- Use native Zod validators over hand-rolled regex (ISO datetime, base64url, etc.). Version availability: `.hex()`/`.uuidv7()` are `zm`/`z4` only (not z3); `.base64()`/`.base64url()` exist everywhere. Use `.trim()`/`.toLowerCase()`/`.toUpperCase()` (native `ZodString`, before `.refine()`) rather than `.transform()`.

## Contribution policy

AI-assisted work is welcome but requires careful human review — low-quality/"slop" output is rejected (see `CONTRIBUTING.md`). Hold generated code to the same standards as the rest of the repo.
