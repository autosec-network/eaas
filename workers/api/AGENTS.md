# AGENTS.md — `api` worker

The Hono crypto API. Read the root `AGENTS.md` and `shared/db/AGENTS.md` first. Path aliases here: `~/*` → `src`, `~do/*` → `do`, `~wf/*` → `wf`.

## Shape

- **Entry** `src/index.ts` — a `WorkerEntrypoint`. Its `fetch` builds the Hono app per-request, wires middleware, and mounts `src/base.mjs`. It also **re-exports every Durable Object and Workflow class** (workerd only discovers them from the `main` file / `wrangler.jsonc`).
- **Routing** `src/base.mts` mounts versioned sub-apps: `app.route('/v0', api0)`. Each API version is a folder under `src/v0/` (`apikeys/`, `keyrings/`, `stats/`, `random.mts`, `extras.mts`). Versioning is intentional — breaking changes ship as a new `vN`, never mutate an existing one.
- **Durable Objects** `do/` — `TenantD0` + `TenantD0Logs` (per-tenant SQLite), `UserD0`, `BitwardenSession`. All extend `do/BaseD0.mts`, which owns the Drizzle instance, runs `_migrate()` under `blockConcurrencyWhile`, and exposes `sqlExec`, `optimize`, `getBookmark`/`restoreToBookmark`, and `nuke`.
- **Workflows** `wf/` — e.g. `DataKeyRotation`. See rules below.
- **Static API docs** `staticApi.mts` / `apiGateway.mts` generate the OpenAPI/Scalar docs into `dist/` (`npm -w api run build:static`, `publish:static`).

## Request lifecycle

Middleware in `src/index.ts` sets up context vars **before** routing: `contextStorage`, browser-cache decision (from `Cache-Control`), then three DB handles on the context — `a_db` (Analytics Engine), `r_db` (root D1), and later `t_db` (tenant DO, set during auth). CORS/timing/logger follow. The `logger` middleware is dev-only (`c.env.NODE_ENV === 'development'`).

**Auth** (`verifyToken` in `base.mts`): bearer API keys of the form `version.ak_id_base64url.ak_secret_base64url`. It resolves the tenant from root D1, opens the tenant DO DB, `timingSafeEqual`-checks the secret hash (sha256/384/512 by version), and loads per-keyring permissions onto `c.var.permissions`. Some routes are exempted via `except([...])` (e.g. `random`, `hash`, `stats`, `apikeys` which self-auth).

Env/bindings you'll touch: `CF_ACCOUNT_ID`, `CF_API_TOKEN`, `DB_ROOT` (D1), `TENANT_D0`/`USER_D0`/`USER_SESSION` (DO namespaces, with `.jurisdiction(...)`), Bitwarden `*_BW_SM_*` vars, `SQL_TTL`, `NODE_ENV`, `ENVIRONMENT`. Regenerate `worker-configuration.d.ts` with `npm -w api run build:types:cf` after editing `wrangler.jsonc`.

## Errors — RFC 9457 only

All error responses use RFC 9457 Problem Details (`application/problem+json`) via `~/errors.mjs`. Never emit ad-hoc `c.json({ success: false, errors })` or plain `application/json` errors.

```ts
import { problemJson, problemJsonValidation, problemResponse } from '~/errors.mjs';

return problemJson(c, 403, { detail: 'Access denied' });
return problemJson(c, 500, { detail: 'Operation failed', errors: [error] });
return problemJsonValidation(c, result.error); // in zValidator/defaultHook
return problemJsonValidation(c, result.error, 404, "API version doesn't exist");

createRoute({ responses: { 403: problemResponse('Access denied.'), 500: problemResponse('Internal server error.') } });
```

The `type` URI deep-links into the Scalar docs (`https://api.eaas.autosec.network/`) and is derived from the route's tag + method. `app.onError` in `base.mts` catches thrown errors globally, so route handlers can just `throw`. Zod errors are auto-run through `prettifyError()`; multi-issue errors become an `AggregateError`-style entry.

## Hono middleware

Use `await next()` (never `return await next()`) when continuing the chain — Hono builds `c.res` behind the scenes. Only `return c.json(...)` to short-circuit. You may need `// @ts-expect-error` above `await next()` middleware to suppress the "not all code paths return" error. If middleware needs a copy of the incoming request, always use `cloneRawRequest(c.req)` (from `hono/utils/request` — see [Hono docs](https://hono.dev/docs/api/request#clonerawrequest)), never `request.clone()`: it clones the raw `Request` and works even after the body has already been consumed by a validator or another `HonoRequest` method, whereas `.clone()` fails once the body stream is exhausted.

## Workflows (Cloudflare Workflows)

- First step always parses `event.payload` with a Zod schema; on failure `throw new NonRetryableError(message)` — **only the first arg**, the second (name) breaks CF's error handling.
- Keep steps **granular** (one unit of work / API call each), **idempotent** (rely only on serialized step outputs, never external mutable state), **async and awaited**, and returning **serializable** data or void. Don't nest steps. Max 1024 steps/instance — paginate by re-creating the workflow with cursor/progress in params.
- A step's returned serializable state is capped at 1MB. To move more, return a `ReadableStream` instead — either the `.body` straight off a `fetch` response, or fake one by constructing a `new Response(data)` and returning its `.body`.
- Anything a step returns is persisted **in plaintext**, regardless of `sensitive` config. `sensitive: 'output'` only redacts the value in the Cloudflare dashboard logs view — it does not encrypt or omit it from storage. For genuinely sensitive data, prefer breaking granularity (do the sensitive work inline in a step without returning the sensitive value) over returning it plaintext, even with `sensitive: 'output'` set.
- Parallelize independent steps with `Promise.all`. Let step return values carry status/timing/counts instead of `console.log` (which isn't easily visible).
- Match `retries` `delay`/`backoff` to the target service's limits: Cloudflare & Bitwarden APIs → 1-minute `constant`; D1 & PQC container ops → 3-minute `exponential`. Use `timeout` for CPU limits (30s default, up to 5min for heavy PQC like SLH-DSA).
