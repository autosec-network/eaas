# AGENTS.md — `admin` worker

Qwik City **internal admin** dashboard, SSR on Cloudflare Workers. Read the root `AGENTS.md` and `shared/db/AGENTS.md` first.

For all shared Qwik conventions — routing (`routes/` pages vs `components/` reusables), streaming/deferred `routeLoader$` + `<Resource>`, the `@auth/qwik` + custom `D0Adapter` auth flow, jurisdiction-aware Durable Objects, Flexbox-only styling, and `<time>`/timezone handling — follow **`workers/customer/AGENTS.md`**. They apply identically here.

## Admin-specific

- **No i18n.** This is an internal tool; there are no `messages/` locale files and no `translate` step. Write copy directly in components.
- **Environment-scoped routes.** Routes live under `src/routes/[environment]/` — the admin operates against a selected environment (e.g. dev vs prod data), so pages and loaders key off that `[environment]` param. Route-scoped DB helpers sit next to their routes (`routes/[environment]/users/db-helpers.ts`).
- Surfaces the internals other workers hide: tenants, users, their sessions/alarms/properties, and tenant assignment (`components/assign-tenant-modal/`).

## Dev

`npm -w admin run start` (Vite SSR, port 5172). `npm -w admin run build:types` runs `wrangler types` + `tsc`.
