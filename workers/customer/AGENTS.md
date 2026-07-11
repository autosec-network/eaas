# AGENTS.md — `customer` worker

Qwik City customer dashboard, SSR on Cloudflare Workers. Read the root `AGENTS.md` and `shared/db/AGENTS.md` first. This file is the canonical **Qwik conventions** reference; `workers/admin/AGENTS.md` points back here.

## Layout & routing rules

- **`src/routes/`** holds only page files (`index.tsx`), layouts, and route-scoped server code (loaders, actions, `plugin@*.ts`). Qwik City conventions are in use: route groups `(team)`, `(user)`, dynamic segments `[tenantId]`, and `@preauth` / `@auth` named-layout suffixes for auth gating.
- **`src/components/`** holds every reusable component, one folder per component (`components/sidebar/tenant-selector/tenant-selector.tsx`). Never put reusable components under `routes/`.

## Streaming/deferred `routeLoader$`

`routeLoader$` blocks page render until it resolves. For loaders doing async I/O, **return an async function** so Qwik streams the shell immediately, and consume it with `<Resource>`:

```tsx
export const useData = routeLoader$(async (event) => {
  await event.resolveValue(useDependency);          // sync setup stays in the outer fn
  const db = event.sharedMap.get('db') as Db;
  return async () => await db.select().from(table);  // async I/O moves inside
});

export default component$(() => {
  const data = useData();
  return <Resource value={data} onPending={() => <div>Loading…</div>} onResolved={(rows) => /* … */} />;
});
```

- **Use** for DB/fetch/external-API loaders. **Don't use** for synchronous loaders (`locale()`, env, header parsing), for auth/security loaders that must finish before render, or for loaders other loaders `resolveValue()` depend on.
- Keep sync setup (URL params, `resolveValue`, `sharedMap` reads) in the outer function; only async I/O goes in the returned function. Pass resolved data into helpers as params instead of reading a loader signal directly.

## Requests & headers

In `routeLoader$`/`routeAction$`/`plugin@*.ts` handlers, Qwik's `request` param is not always the real incoming request. Use `(platform.request ?? request)` whenever reading headers (`Cf-Ray`, `Cf-Connecting-IP`, `User-Agent`, etc.) or `cf` properties — see `plugin@auth.ts`, `layout.tsx`, `helpers/d0-adapter.ts` for existing usage.

## Auth & data access

Auth uses `@auth/qwik` wired through `src/routes/plugin@auth.ts`, with a **custom `D0Adapter`** (`src/helpers/d0-adapter.ts`) replacing `@auth/d1-adapter`. Sessions and users each live in their own Durable Object (`USER_SESSION` DO here, plus `USER_D0` / root D1 via the `db` package). DOs are **jurisdiction-aware** — an EU user's DO is created in the `eu` jurisdiction (decided from `cf.isEUCountry`), and jurisdiction is fixed at DB instantiation, so it can't change afterward. Deleting a session `nuke()`s its DO (across all jurisdictions if orphaned).

## Internationalization

All user-facing copy is translated. **Only edit `messages/en.json`** as the source of truth, then generate the other locales:

```
npm -w customer run translate      # inlang machine-translate en → de/es/fr/ro
```

Never hand-edit non-English locale files (`de/es/fr/ro.json`) — they're regenerated. Config lives in `project.inlang/`.

When deleting or rewriting a component/route, grep for every message key it referenced (`m.some_key()`). For each key with no remaining references anywhere in `src/`, delete it from `messages/en.json` yourself, then run `translate` so the deletion propagates to the other locale files — `en.json` is the source of truth `languageGenerate.ts` prunes stale keys _against_, it won't notice a key that's still sitting in `en.json` unused.

## UI conventions

- **Flexbox only — no CSS Grid.** Grid's wrapping behavior with dynamic content is unpredictable here; flexbox is the house standard. (Tailwind v4 + Flowbite are the styling stack.)
- **Timestamps:** render a semantic `<time>` with `dateTime`, show localized time via `useTimezone()`, and put the UTC value in the `title` tooltip. For datetime **inputs**, convert the user's local wall-clock input to a UTC `Date` server-side (`rawTimezone()`) before saving. Store UTC, display local.
- **Permission UIs:** give assignment a large dedicated surface (full-screen panel / large modal), separate global from per-resource permissions, and label each with a short description of what it grants.

## Dev

`npm -w customer run start` (Vite SSR). `npm -w customer run build:types` runs `wrangler types` + `tsc`. `build:translate` (`languageGenerate.ts`) compiles paraglide output.
