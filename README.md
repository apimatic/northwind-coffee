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
- **PayPal checkout**: on an order awaiting payment, **Pay with PayPal** creates a PayPal order and sends the buyer to
  PayPal to approve it; PayPal sends them back to a confirm page, and **Pay now** captures the payment. The order
  becomes `paid` only when PayPal reports the capture `COMPLETED` for exactly the order total. The order page and admin
  show the payment status. Admins refund paid orders from the admin order page, in full or in part.
- **Identity**: register, sign in, sign out. PBKDF2-SHA256 (100,000 iterations, per-user salt) via WebCrypto;
  server-side sessions in D1; `HttpOnly; Secure; SameSite=Lax` cookies.
- **Admin** (`/admin`, role `admin`): all orders (newest first, status filter), order detail with payment details,
  PayPal refunds and **Cancel order** (only from `awaiting_payment`, and not once a PayPal capture has started),
  read-only catalog.
- **Public API**: `GET /api/catalog-items` (`pageIndex`, `pageSize`, `catalogBrandId`, `catalogTypeId`),
  `GET /api/catalog-items/:id`, `GET /api/catalog-brands`, `GET /api/catalog-types`.
- **Health**: `GET /healthz` returns `{ "ok": true }` after a D1 query.

All money is stored and computed as **integer cents** (USD).

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

`.dev.vars` is git-ignored. In production, set the secret with `npx wrangler secret put CSRF_SECRET`.

### PayPal

PayPal needs `PAYPAL_CLIENT_ID`, `PAYPAL_CLIENT_SECRET` and `PAYPAL_API_BASE` in `.dev.vars` (secrets in production).
Every PayPal REST call, including the OAuth token request, goes to `PAYPAL_API_BASE` (our egress gateway), never
straight to `api-m.paypal.com`. `PAYPAL_ENV` in `wrangler.jsonc` (`sandbox` or `live`) must match those credentials:
it decides which PayPal approval host buyers may be redirected to. The integration uses the APIMatic-generated
`paypal` TypeScript SDK (installed from GitHub); the contract notes are in `paypal-plan.md`.

How the payment is kept safe against double clicks and lost answers:

- One PayPal checkout per order (`paypal_payments.order_id` is the key), created with a stored `PayPal-Request-Id`,
  so a retried **Pay with PayPal** gets the same PayPal order back.
- The capture is claimed (`state = 'capturing'`) before PayPal is called, so it runs once. If PayPal's answer is lost,
  the PayPal order is re-read; until PayPal confirms, the page says the payment is being confirmed, never that it
  failed. Pending captures are re-checked when the order page is viewed.
- Each refund is claimed (`paypal_refunds`, unique per refund form) with the refundable amount checked in the same
  statement, and carries `custom_id = northwind-refund-<id>` so an unconfirmed refund can be found on the PayPal
  order (**Check refund status**) If PayPal has no record of it, the check re-sends it with the original
  `PayPal-Request-Id`, so PayPal never refunds it twice.
- Timeouts and retries: each PayPal attempt times out after 10 s, and each operation's calls share a 25 s deadline
  (plus 10 s to re-read PayPal after a lost answer). A 429 or 5xx is retried once, writes included (honouring
  `Retry-After`), so a brief PayPal hiccup never reaches the shopper: the retry is the same request with the same
  `PayPal-Request-Id`, which PayPal deduplicates. A write whose answer was lost (connection dropped, timeout) is not
  re-sent; it is settled by re-reading PayPal. A 409 "still in progress" is never taken as a refusal. Retries log
  `{"event":"paypal_retry",…}`.

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
                   ├─ src/services/   all business logic: catalog · basket · orders · payments (PayPal) · identity
                   │
                   ├─ src/db/         SQL only, parameterised statements, one file per aggregate
                   │
                   └─ src/lib/        money (integer cents) · password (PBKDF2) · csrf · cookies · log · encoding
                                         │            · paypal (client, error translation)
                                         ▼                         │
                                     D1 (DB) ── migrations/        ▼
                                                     PAYPAL_API_BASE (egress gateway) ──▶ PayPal REST API
```

Each request logs one JSON line, `{"event":"request","method","path","status","ms"}`. Each PayPal call outcome logs
`{"event":"paypal","op","orderId","outcome",…}` with PayPal's `debugId` on errors (never tokens or bodies). Unhandled errors log
`{"event":"error",…}` with the stack and render a friendly 500 page. With `observability.enabled`, these appear in
Workers Logs.

## Deploying

The Worker `northwind-with-apimatic` uses the D1 database named in `wrangler.jsonc`. Apply migrations with
`npm run db:migrate:remote`, set the secrets (`CSRF_SECRET`, `PAYPAL_CLIENT_ID`, `PAYPAL_CLIENT_SECRET`,
`PAYPAL_API_BASE`) with `npx wrangler secret put <NAME>`, check `PAYPAL_ENV`, then `npx wrangler deploy`.
