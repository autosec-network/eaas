# AGENTS.md — `api` worker

The Hono crypto API. Read the root `AGENTS.md` and `shared/db/AGENTS.md` first. Path aliases here: `~/*` → `src`, `~do/*` → `do`, `~wf/*` → `wf`.

## Shape

- **Entry** `src/index.ts` — an `ExportedHandler`. Its `fetch` builds the Hono app per-request, wires middleware, and mounts `src/base`; its `queue` dynamically imports `src/queue`. It also **re-exports every Durable Object and Workflow class** (workerd only discovers them from the `main` file / `wrangler.jsonc`).
- **Routing** `src/base.ts` mounts versioned sub-apps: `app.route('/v0', api0)`. Each API version is a folder under `src/v0/` (`apikeys/`, `keyrings/`, `stats/`, `random.ts`, `extras.ts`). Versioning is intentional — breaking changes ship as a new `vN`, never mutate an existing one.
- **Durable Objects** `do/` — `TenantD0` + `TenantD0Logs` (per-tenant SQLite), `UserD0`, `BitwardenSession`. All extend `do/BaseD0.ts`, which owns the Drizzle instance, runs `_migrate()` under `blockConcurrencyWhile`, and exposes `sqlExec`, `optimize`, `getBookmark`/`restoreToBookmark`, and `nuke`.
- **Workflows** `wf/` — e.g. `DataKeyRotation`. See rules below.
- **Queue consumer** `src/queue.ts` — `main` handles the `eaas-logs-*` batch. See below.
- **Static API docs** `staticApi.ts` / `apiGateway.ts` generate the OpenAPI/Scalar docs into `dist/` (`npm -w api run build:static`, `publish:static`).

## Tenant audit logging goes through a queue

Nothing writes a row into a tenant's `TenantD0Logs` directly. Every worker — `admin`, `customer`, and this one — is a **producer** onto `eaas-logs-dev`/`eaas-logs-prod`, and this worker's `queue()` handler is the **only consumer** and therefore the only writer.

- **Message shape** is `TenantLogQueueMessageSchema` (`types/tenants/logging`), a `zod/mini` schema. Never hand-write a type for it — derive off the schema with `zm.input<typeof TenantLogQueueMessageSchema>` (producer side, pre-parse) / `zm.output<…>` (consumer side, aliased as `TenantLogQueueMessage`), and `Omit`/extend from there if you need more. It's plain JSON on the wire (`contentType: 'json'`), so ids stay hex strings and `timestamp` stays an ISO string. It carries `t_id` + `jurisdiction` alongside the row's own columns, because the logs DO's id is never persisted anywhere — it's always derived as `idFromName('<hyphenated t_id>_logs')` on the matching jurisdictional (sub)namespace.
- **Producing** happens in each worker, deliberately not behind a shared helper — every worker reaches the incoming request differently (Qwik's `platform.request ?? request`, Hono's `c.req.raw`, a queue batch with no request at all). Build the input object, `parseAsync` it, then `send`/`sendBatch`. Mint the row's UUIDv7 from the same `Date` you put in `timestamp`, so ordering reflects when the event happened rather than when it was written, and pull `ray_id` off `CF-Ray` by splitting on `-` (only the id half is hex).
    - Buffer the messages and `sendBatch` at the end if the operation can still roll the tenant back (see `customer`'s onboarding action) — a message already on the queue lands _after_ a rollback that nuked the logs DO, and would resurrect it. Row ordering survives buffering because the ids are minted when the events happen, not when they're enqueued.
- **Consuming** (`src/queue.ts`'s `main`, dynamically imported from the entry's `queue()`): the batch is split per tenant (keyed on `t_id` _and_ jurisdiction), and each tenant's DO is written independently of the others. Within one tenant, every log is its own `insert()` — the DO caps bound parameters **per statement**, not per batch — and they all go through a single `batch()`, which the DO runs as one `ctx.storage.transaction()`. Each tenant's messages are acked as that tenant's transaction commits, not after the slowest tenant in the batch, so one unreachable DO redelivers only its own logs. Unparseable messages are acked rather than retried.
- `drizzleD0` swallows `sqlExec` failures into an empty result set by default. The consumer passes `{ throwOnError: true }` — without it, a failed write is indistinguishable from a successful one and every message would be acked.

## Request lifecycle

Middleware in `src/index.ts` sets up context vars **before** routing: `contextStorage`, browser-cache decision (from `Cache-Control`), then three DB handles on the context — `a_db` (Analytics Engine), `r_db` (root D1), and later `t_db` (tenant DO, set during auth). CORS/timing/logger follow. The `logger` middleware is dev-only (`c.env.NODE_ENV === 'development'`).

**Auth** (`verifyToken` in `base.ts`): bearer API keys of the form `ase_version.ak_id_base64url.ak_secret_base64url`. It resolves the tenant from root D1, opens the tenant DO DB, `timingSafeEqual`-checks the secret hash (sha256/384/512 by version), and loads per-keyring permissions onto `c.var.permissions`. Some routes are exempted via `except([...])` (e.g. `random`, `hash`, `stats`, `apikeys` which self-auth).

Env/bindings you'll touch: `CF_ACCOUNT_ID`, `CF_API_TOKEN`, `DB_ROOT` (D1), `TENANT_D0`/`USER_D0`/`USER_SESSION` (DO namespaces, with `.jurisdiction(...)`), Bitwarden `*_BW_SM_*` vars, `SQL_TTL`, `NODE_ENV`, `ENVIRONMENT`. Regenerate `worker-configuration.d.ts` with `npm -w api run build:types:cf` after editing `wrangler.jsonc`.

## Errors — RFC 9457 only

All error responses use RFC 9457 Problem Details (`application/problem+json`) via `~/errors`. Never emit ad-hoc `c.json({ success: false, errors })` or plain `application/json` errors.

```ts
import { problemJson, problemJsonValidation, problemResponse } from '~/errors';

return problemJson(c, 403, { detail: 'Access denied' });
return problemJson(c, 500, { detail: 'Operation failed', errors: [error] });
return problemJsonValidation(c, result.error); // in zValidator/defaultHook
return problemJsonValidation(c, result.error, 404, "API version doesn't exist");

createRoute({ responses: { 403: problemResponse('Access denied.'), 500: problemResponse('Internal server error.') } });
```

The `type` URI deep-links into the Scalar docs (`https://api.eaas.autosec.network/`) and is derived from the route's tag + method. `app.onError` in `base.ts` catches thrown errors globally, so route handlers can just `throw`. Zod errors are auto-run through `prettifyError()`; multi-issue errors become an `AggregateError`-style entry.

## Hono middleware

Use `await next()` (never `return await next()`) when continuing the chain — Hono builds `c.res` behind the scenes. Only `return c.json(...)` to short-circuit. You may need `// @ts-expect-error` above `await next()` middleware to suppress the "not all code paths return" error. If middleware needs a copy of the incoming request, always use `cloneRawRequest(c.req)` (from `hono/utils/request` — see [Hono docs](https://hono.dev/docs/api/request#clonerawrequest)), never `request.clone()`: it clones the raw `Request` and works even after the body has already been consumed by a validator or another `HonoRequest` method, whereas `.clone()` fails once the body stream is exhausted.

## Workflows (Cloudflare Workflows)

- First step always parses `event.payload` with a Zod schema; on failure `throw new NonRetryableError(message)` — **only the first arg**, the second (name) breaks CF's error handling.
- Keep steps **granular** (one unit of work / API call each), **idempotent** (rely only on serialized step outputs, never external mutable state), **async and awaited**, and returning **serializable** data or void. Don't nest steps. Max 1024 steps/instance — paginate by re-creating the workflow with cursor/progress in params.
- A step's returned serializable state is capped at 1MB. To move more, return a `ReadableStream` instead — either the `.body` straight off a `fetch` response, or fake one by constructing a `new Response(data)` and returning its `.body`.
- Anything a step returns is persisted **in plaintext**, regardless of `sensitive` config. `sensitive: 'output'` only redacts the value in the Cloudflare dashboard logs view — it does not encrypt or omit it from storage. For genuinely sensitive data, prefer breaking granularity (do the sensitive work inline in a step without returning the sensitive value) over returning it plaintext, even with `sensitive: 'output'` set.
- Parallelize independent steps with `Promise.all`. Let step return values carry status/timing/counts instead of `console.log` (which isn't easily visible).
- Match `retries` `delay`/`backoff` to the target service's limits: Cloudflare & Bitwarden APIs → 1-minute `constant`; D1 & PQC container ops → 3-minute `exponential`. Use `timeout` for CPU limits (30s default, up to 5min for heavy PQC like SLH-DSA).
- `retries.delay` doesn't have to be a fixed duration/ms — it accepts a function `({ ctx, error }) => WorkflowDelayDuration | number | Promise<...>` ([dynamic retry delays](https://developers.cloudflare.com/changelog/post/2026-07-09-dynamic-retry-delays/)). `ctx.attempt` gives the attempt number and `error` the thrown error, so you can honor an upstream service's own throttle window instead of guessing a static one — e.g. parse a `Retry-After`/rate-limit-reset response header and return the exact wait time. When set, `delay` is a function for **every** attempt of that step, so still clamp it against a sane floor (the service's documented minimum) in case the header is missing or already in the past; `backoff` is meaningless once `delay` is a function and should be omitted.
    - Durable Object RPC only propagates an error's `name`/`message` to the caller — custom properties set on the Error instance are dropped ([RPC error handling](https://developers.cloudflare.com/workers/runtime-apis/rpc/error-handling/)). If a DO method needs to hand retry-relevant data (e.g. rate-limit headers) back through a thrown error, encode it into the message itself and provide a paired parser, rather than attaching it as an Error property. See `BitwardenSession.ts`'s `extractBitwardenRateLimit`, used by `DataKeyRotation`'s `bitwardenCallRetry.retries.delay` to size retries off Bitwarden's `x-rate-limit-reset` header.
