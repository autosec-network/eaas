# AGENTS.md — `admin` worker

Qwik City **internal admin** dashboard, SSR on Cloudflare Workers. Read the root `AGENTS.md` and `shared/db/AGENTS.md` first.

`workers/customer/AGENTS.md` is the canonical Qwik conventions reference for this repo — routing (`routes/` pages vs `components/` reusables), request/header access (`platform.request ?? request`), streaming/deferred `routeLoader$` + `<Resource>`, the `@auth/qwik` + custom `D0Adapter` auth flow, jurisdiction-aware Durable Objects, Flexbox-only styling, `<time>`/timezone handling, etc. Everything there applies identically here unless called out as customer-specific (e.g. i18n). Don't duplicate it — when it's updated, `admin` (and any other Qwik worker added later) inherits the change automatically.

## Admin-specific

- **No i18n.** This is an internal tool; there are no `messages/` locale files and no `translate` step. Write copy directly in components.
- **Environment-scoped routes.** Routes live under `src/routes/[environment]/` — the admin operates against a selected environment (e.g. dev vs prod data), so pages and loaders key off that `[environment]` param. Route-scoped DB helpers sit next to their routes (`routes/[environment]/users/db-helpers.ts`).
- Surfaces the internals other workers hide: tenants, users, their sessions/alarms/properties, and tenant assignment (`components/assign-tenant-modal/`).
- **Dual-load resources that exist in two places.** Anything backed by a Cloudflare resource (Durable Objects, KV, R2, etc.) also has a row in the root D1 lookup table (`r_db`). When a page or loader surfaces one of these, load it from **both** sources — the root lookup table and the Cloudflare API for that resource type (e.g. the DO namespace API) — rather than trusting the lookup table alone. Admin's job is to catch drift between them (an orphaned lookup row with no live DO, a DO with no lookup row, mismatched jurisdiction/state) and surface it in the UI; where the fix is unambiguous (e.g. deleting the orphaned row, re-registering the DO), offer a repair action instead of just flagging it.

## Dev

`npm -w admin run start` (Vite SSR, port 5172). `npm -w admin run build:types` runs `wrangler types` + `tsc`.
