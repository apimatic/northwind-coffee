# Northwind Coffee: notes for coding agents

A coffee store on Cloudflare Workers: Hono + `hono/jsx` SSR, D1, Workers Static Assets, zod. See `README.md` for
features and setup.

## Commands

- `npm run dev`: local server on http://localhost:8787 (needs `.dev.vars`, see `.dev.vars.example`)
- `npm run typecheck`: TypeScript for the Worker/tests (`tsconfig.json`) and scripts/e2e (`tsconfig.node.json`)
- `npm run lint`: Biome lint + Prettier check (`npm run format` fixes formatting)
- `npm test`: Vitest in workerd via `@cloudflare/vitest-plugin`; each test file gets fresh D1 storage with migrations
- `npm run e2e`: Playwright against a fresh `wrangler dev` on port 8788 (axe checks, no console errors allowed)
- `npm run build:dry-run`: confirms the bundle builds for Workers
- `npm run cf-typegen`: regenerate `worker-configuration.d.ts` after changing `wrangler.jsonc`

**Run `npm run typecheck`, `npm run lint` and `npm test` before committing.** Run `npm run e2e` when you change pages,
forms or routes.

## Layering rules

- `src/routes/*`: thin. Parse and validate input with zod, call services, render a view or redirect. No SQL, no
  business rules.
- `src/services/*`: all business logic (catalog, basket, orders, identity). Services take a `D1Database` and plain
  values, never a Hono context.
- `src/db/*`: SQL only, always parameterised (`?1`, `?2` with `.bind()`). Never build SQL from user input. Use
  `db.batch()` when several writes must succeed or fail together.
- `src/views/*`: `hono/jsx` components; no data access.
- `src/lib/*`: small shared helpers (money, password hashing, CSRF, cookies, logging).
- Middleware lives in `src/middleware/`. The app is assembled in `src/index.tsx`.

## Conventions

- **Money is integer cents** everywhere (DB columns `*_cents`, TypeScript `Cents`). Use `src/lib/money.ts` for line
  totals, sums and display formatting. Never use floating-point amounts.
- Every state-changing form posts `_csrf` (render `<CsrfField token={ctx.csrfToken} />`); the CSRF middleware rejects
  anything else. JSON API routes are read-only.
- Form validation errors re-render the form with status 200 and field messages (`fieldErrors()`); real errors use
  404/403/500 pages from `src/views/errors.tsx`.
- Log with `src/lib/log.ts` (one JSON object per line). Never log secrets, passwords, tokens or hashes.
- No `nodejs_compat`: Worker code must use Web APIs only (WebCrypto, `fetch`, `URL`, …). Node APIs are fine only in
  `scripts/`, `e2e/` and config files.
- Secrets live in `.dev.vars` locally (git-ignored) and in `wrangler secret put` in production. Never commit them.
- Accessibility: every input has a label, images have `alt` (empty when decorative), keep visible focus styles.

## Database migrations

- Schema changes go in a new file in `migrations/` named `NNNN_description.sql` (next number). Never edit a migration
  that has been applied anywhere; add a new one.
- Apply locally with `npm run db:migrate:local`. Tests apply migrations automatically (`test/setup.ts`).
- Seed/reference data also goes in migrations (see `0002_seed_catalog.sql`). Users are created with
  `scripts/create-user.ts` (password from the `NW_PASSWORD` env var).

## Tests

- Route tests use the `Browser` helper in `test/helpers.ts` (keeps cookies, reads CSRF tokens from pages) and call the
  app inside workerd. Add a test for every new route, service rule or authorization check.
- Test files are isolated from each other; tests within a file share a database, so use unique emails
  (`uniqueEmail()`) and restore any shared data you change.
