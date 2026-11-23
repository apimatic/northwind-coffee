# Northwind Coffee

A small, complete online coffee store running on [Cloudflare Workers](https://developers.cloudflare.com/workers/).
It follows the shape of Microsoft's [eShopOnWeb](https://github.com/dotnet-architecture/eShopOnWeb) reference app
(catalog, basket, checkout, orders, identity, admin, read-only public API), rewritten in TypeScript.

- **Catalog** (`/`): 16 products across 4 brands and 4 types, filter by brand and type, 10 per page.
- **Basket** (`/basket`): anonymous basket keyed by a cookie; update quantities, remove lines. The unit price is captured
  when an item is added. Signing in or registering merges the anonymous basket into the user's basket.
- **Checkout** (`/checkout`, sign-in required): shipping address, order summary, **Place order**. Lines (name, picture,
  unit price) are snapshotted into the order; the basket is emptied. Resubmitting the same checkout form never creates a
  second order.
- **Orders** (`/orders`, `/orders/:id`): a buyer sees only their own orders. New orders are `awaiting_payment`.
- **PayPal payments**: on an unpaid order the buyer clicks **Pay with PayPal**, approves on PayPal and is sent back to
  `/orders/:id/paypal/return`, where the store captures the payment. The order becomes `paid` only once PayPal reports
  the capture `COMPLETED` for exactly the order total. Pending captures stay unpaid until PayPal completes them. See
  [Payments](#payments).
- **Identity**: register, sign in, sign out. PBKDF2-SHA256 (100,000 iterations, per-user salt) via WebCrypto;
  server-side sessions in D1; `HttpOnly; Secure; SameSite=Lax` cookies.
- **Admin** (`/admin`, role `admin`): all orders (newest first, status filter), order detail with payment status,
  PayPal attempts and refunds, **Refund** (full or partial), **Check with PayPal** (re-checks anything still pending),
  **Cancel order** (only from `awaiting_payment` with no capture in progress), read-only catalog.
- **Public API**: `GET /api/catalog-items` (`pageIndex`, `pageSize`, `catalogBrandId`, `catalogTypeId`),
  `GET /api/catalog-items/:id`, `GET /api/catalog-brands`, `GET /api/catalog-types`.
- **Health**: `GET /healthz` returns `{ "ok": true }` after a D1 query.

All money is stored and computed as **integer cents** (USD).

## Payments

PayPal Orders v2 with `intent: CAPTURE`, server side only (no PayPal JavaScript; the CSP allows forms to redirect to
`www.paypal.com` and `www.sandbox.paypal.com`). Every PayPal REST call goes to `PAYPAL_API_BASE`, our egress gateway,
never to `api-m.paypal.com` directly; whether that reaches the sandbox or live PayPal is decided by the gateway and the
credentials.

- `payments` (migration `0003`) has one row per PayPal attempt: `created` → `capturing` → `captured` / `pending` /
  `failed`, or `voided` if the buyer cancels on PayPal. The capture is claimed in D1 before PayPal is called, so an
  order can't be cancelled or captured twice while a capture is in flight. A capture whose outcome is unknown (timeout,
  5xx) is retried with the same `PayPal-Request-Id`, so PayPal never captures twice.
- `refunds` reserve their amount before PayPal is called, so concurrent refunds can't exceed the captured amount. Each
  refund form carries its own idempotency key. Order status follows completed refunds: `partially_refunded`, then
  `refunded`.
- There are no webhooks yet: pending captures/refunds, and calls whose outcome was unknown, are re-checked when the buyer
  returns or when staff click **Check with PayPal**. Refunds made directly in the PayPal dashboard are not reflected.
- Logs: `{"event":"payment",…}` and `{"event":"payment_error",…}` with PayPal's `debug_id`; never tokens or secrets.

## Stack

Cloudflare Workers (TypeScript `strict`, ES modules, no `nodejs_compat`), [Hono](https://hono.dev) with `hono/jsx`
server-side rendering, D1 with `wrangler d1 migrations`, Workers Static Assets (`public/`), zod for input validation.
Tests: Vitest with `@cloudflare/vitest-plugin` (runs inside workerd), Playwright + `@axe-core/playwright` end to end.
Biome (lint) and Prettier (format). GitHub Actions CI.

## Setup

Requirements: Node.js 22.12 or later (CI uses Node 24), npm.

```sh
npm install
cp .dev.vars.example .dev.vars      # then put a random value of 32+ characters in CSRF_SECRET
npm run db:migrate:local            # creates the local D1 database (schema + catalog seed)
npm run dev                         # http://localhost:8787
```

`.dev.vars` is git-ignored. It also needs `PAYPAL_CLIENT_ID`, `PAYPAL_CLIENT_SECRET` and `PAYPAL_API_BASE` (see
`.dev.vars.example`). In production, set each secret with `npx wrangler secret put <NAME>`.

### Seeding users

Customers can register in the app. To create an admin (or any user) use `scripts/create-user.ts`. The password is read
from the `NW_PASSWORD` environment variable, never from the command line:

```sh
# bash
NW_PASSWORD='choose-a-strong-password' npm run create-user -- --email admin@example.com --role admin --local
# PowerShell
$env:NW_PASSWORD = 'choose-a-strong-password'; npm run create-user -- --email admin@example.com --role admin --local
```

Use `--remote` for the deployed database, and `--update` to reset an existing user's password and role.

## Commands

| Command                                          | What it does                                                   |
| ------------------------------------------------ | -------------------------------------------------------------- |
| `npm run dev`                                    | Local dev server (`wrangler dev`) with local D1                |
| `npm run typecheck`                              | `tsc` for the Worker + tests, and for scripts/e2e/config       |
| `npm run lint`                                   | Biome lint and Prettier check                                  |
| `npm run format`                                 | Prettier write                                                 |
| `npm test`                                       | Unit and route tests in workerd (Vitest)                       |
| `npm run e2e`                                    | Playwright end-to-end + axe against a fresh `wrangler dev`     |
| `npm run screenshots`                            | Full-page screenshots of every page at 1440 px and 390 px      |
| `npm run build:dry-run`                          | `wrangler deploy --dry-run --outdir dist` (bundle check only)  |
| `npm run db:migrate:local` / `db:migrate:remote` | Apply D1 migrations                                            |
| `npm run create-user -- --email … --role …`      | Create a user (password from `NW_PASSWORD`)                    |
| `npm run cf-typegen`                             | Regenerate `worker-configuration.d.ts` after changing bindings |

First-time e2e setup: `npx playwright install chromium`. The e2e server (`e2e/server.ts`) wipes
`.wrangler/e2e-state`, applies migrations, creates an e2e admin and starts `wrangler dev` on port 8788.

## Architecture

```
 Browser ──HTTP──▶ Cloudflare Worker (src/index.tsx, Hono)
                   │
                   ├─ static files (public/) served by Workers Static Assets (ASSETS)
                   │
                   ├─ middleware   request log · security headers · identity (session / anonymous cookie) · CSRF
                   │
                   ├─ src/routes/     thin: parse input (zod) → call a service → render a view or redirect
                   │    shop.tsx (catalog, basket) · orders.tsx (checkout, orders) · account.tsx · admin.tsx · api.ts
                   │
                   ├─ src/views/      hono/jsx server-rendered pages (layout, components, one file per area)
                   │
                   ├─ src/services/   all business logic: catalog · basket · orders · identity
                   │
                   ├─ src/db/         SQL only, parameterised statements, one file per aggregate
                   │
                   └─ src/lib/        money (integer cents) · password (PBKDF2) · csrf · cookies · log · encoding
                                         │
                                         ▼
                                     D1 (DB) ── migrations/
```

Each request logs one JSON line, `{"event":"request","method","path","status","ms"}`. Unhandled errors log
`{"event":"error",…}` with the stack and render a friendly 500 page. With `observability.enabled`, these appear in
Workers Logs.

## Deploying

Apply migrations with `npm run db:migrate:remote` **before** deploying code that needs them, set the secrets
(`CSRF_SECRET`, `PAYPAL_CLIENT_ID`, `PAYPAL_CLIENT_SECRET`, `PAYPAL_API_BASE`) with `npx wrangler secret put`, then
`npx wrangler deploy`.
