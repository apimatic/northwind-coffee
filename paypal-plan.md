# PayPal checkout: plan and contract sheet

Scope: after placing an order, a customer pays with PayPal (approve on PayPal, return to the store, capture).
An order becomes `paid` only once PayPal reports a **COMPLETED** capture. Payment status is shown on the
customer order page and in admin. Staff refund a paid order from the admin order page, in full or in part.

## Environment and toolchain (surveyed)

- Runtime: Cloudflare Workers (workerd), **no `nodejs_compat`**; ESM only (`"type": "module"`, bundler resolution).
  One dialect, so `instanceof` on SDK error classes is reliable.
- `tsconfig`: `strict`, `verbatimModuleSyntax` (type-only names via `import type`), `noUncheckedIndexedAccess`; no
  `exactOptionalPropertyTypes` (still: omit absent optionals rather than assign `undefined`).
- SDK: `paypal` 2.29.0 installed from `git+https://github.com/context-plugins/paypal-typescript-sdk#main`, built
  (`dist/esm`). Map at `node_modules/paypal/sdk-map.md`, pages under `map/operations/`.
- Commands: `npm run typecheck`, `npm run lint`, `npm test`, `npm run e2e`, `npm run build:dry-run`,
  `npm run cf-typegen`.
- Baseline on the untouched tree: typecheck OK; lint fails only on the untracked local file
  `.claude/settings.local.json` (not ours; not in git); tests run separately.

## Host and credentials

| Fact                           | Value                                                                                                                                                                                                                                                                                                                                                                               |
| ------------------------------ | ----------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| Host                           | `PAYPAL_API_BASE` (secret / `.dev.vars`) — the egress gateway. Passed as `serverOptions: { baseUrl }`. Never `api-m.sandbox.paypal.com` directly                                                                                                                                                                                                                                    |
| Environment intent             | new non-secret var `PAYPAL_ENV` in `wrangler.jsonc` = `"sandbox"` (`"live"` later). Decides the allowed PayPal approval host (`www.sandbox.paypal.com` / `www.paypal.com`) and the CSP `form-action` entry                                                                                                                                                                          |
| Credential                     | `oauth2: { clientId: PAYPAL_CLIENT_ID, clientSecret: PAYPAL_CLIENT_SECRET }`. Token endpoint = base + `/v1/oauth2/token` (follows the override)                                                                                                                                                                                                                                     |
| Startup check                  | factory throws if any of the three secrets is empty, if `PAYPAL_API_BASE` is not `https:`, or if `PAYPAL_ENV` is not `sandbox`/`live`                                                                                                                                                                                                                                               |
| Smoke (2026-11-23, scratchpad) | token + `getOrder` (404 `error2`) + `createOrder` (200, `PAYER_ACTION_REQUIRED`, `payer-action` link on `www.sandbox.paypal.com`) + replay of `createOrder` with the same `PayPal-Request-Id` returned **the same order id** + `captureOrder` unapproved → 422 `ORDER_NOT_APPROVED` + `getCapturedPayment`/`refundCapturedPayment` on unknown id → 404. All through the gateway: OK |
| Smoke finding                  | `captureOrder` **without a body** → **415 UNSUPPORTED_MEDIA_TYPE**. Must send `body: {}`                                                                                                                                                                                                                                                                                            |

## Client construction (src/lib/paypal.ts)

- Built once per isolate (module-level cache keyed by base URL + client id), never per request.
- `new PaypalClient({ serverOptions: { baseUrl }, oauth2, retry: { timeout: 10_000, maxRetries: 1, statusCodesToRetry: [401, 408, 429, 500, 502, 503, 504], onRetry }, logging: { level: "off" }, fetch: (request) => fetch(request) })`.
  - `fetch` late-binds the global so tests can stub `globalThis.fetch`; it forwards the `Request` (signal kept).
  - **Retry policy ("making a write safe", option 1).** `httpMethodsToRetry` = the default gate **plus `POST`**, so
    a brief 429 or 5xx on createOrder, captureOrder, refundCapturedPayment (and the token request) is retried once
    instead of reaching the shopper. Safe because every write carries the `PayPal-Request-Id` stored on its claim
    (DUPLICATE CLAIMS), and an SDK retry re-sends the same `Request` — same `PayPal-Request-Id`, same
    `Idempotency-Key` — which PayPal deduplicates (keys kept 6 h for orders/captures, 45 days for refunds; replay
    verified live for createOrder, documented for the others). `maxRetries` = 1; statuses = SDK default
    (408, 429, 500, 502, 503, 504) plus `401` (a 401 drops the cached token; the retry gets a fresh one).
    `Retry-After` is honoured; a wait longer than the operation's deadline is cut short by the deadline signal (the
    write is then settled by the re-read like any lost answer).
  - **Lost answers are not re-sent by the SDK.** The SDK's gate also retries faults (connection, timeout) and has no
    statuses-only switch, so `onRetry` — which runs before each retry and ends the call with whatever it throws —
    rethrows a fault on any non-GET request unchanged. A write whose answer was lost goes to the UNKNOWN OUTCOMES
    re-read exactly as before; GET faults are still retried once. `onRetry` logs `{"event":"paypal_retry",…}`.
  - **Conflicts are not refusals.** A replayed write can meet the original still in progress. A 409, or a 4xx whose
    issue is `PREVIOUS_REQUEST_IN_PROGRESS`/`DUPLICATE_REQUEST_ID`, is classified `conflict` (not retried, not
    "definitely not applied"): createOrder keeps its claim (503 "still processing"), capture and refund are settled
    by the re-read, so a refund's amount is never released while PayPal may still make it. (PayPal's exact answer to
    a replay of an in-flight request is UNVERIFIED in the SDK reference; this rule is the conservative reading.)
  - **Timeouts.** `retry.timeout` = 10 s bounds one attempt up to its headers only. Every operation also runs under
    a deadline signal (`paypalDeadline`), which bounds all its attempts, retry waits and the token request:
    `budgetMs` = 25 s for the operation's own calls, `rereadBudgetMs` = 10 s for the re-read after an unknown write
    (a fresh budget, so a write that ran out of time can still be settled). Worst case per request ≈ 35 s.
    Our deadline aborts with `PaypalDeadlineError`, which the SDK hands back unwrapped (outside its error family);
    `classifyPaypalError` maps it to `no_response` (unknown on a write).
  - The browser's own disconnect signal is deliberately **not** linked into writes: once a capture or refund is sent,
    the Worker keeps going so it can record the outcome.
  - Logging: explicitly `"off"` so `PAYPAL_CLIENT_LOG` cannot switch it on; no request bodies logged. Our own log
    lines carry PayPal's correlation id — `debug_id` from the error body, else the `Paypal-Debug-Id` response
    header — never tokens/secrets/bodies.
- No pagination, no streaming needed; no hooks, circuit breaker or rate limiter (traffic is one call per user action).
- `Error` model is imported as `import type { Error as PaypalApiErrorBody } from "paypal"` if needed.

## Contract sheet (all from map pages + model files; no open lookups)

All operations: `op(request, options?)`, flat request, return `ApiPromise<T, E>`, auth `oauth2`, server `default`.
Every non-GET gets a per-call SDK `Idempotency-Key` (not shared across our own retries).

### `client.orders.createOrder(request: Orders.CreateOrderRequest)` → `Order`, error `Orders.CreateOrderError`

- Wire `POST /v2/checkout/orders`; body `application/json` required (`OrderRequest`).
- Fields: `payPalRequestId` header `PayPal-Request-Id` (server keeps keys 6 h) · `prefer` header default
  `"return=minimal"` (sent even if omitted) · `body` · (unused: `payPalMockResponse`, `payPalPartnerAttributionId`,
  `payPalClientMetadataId`, `payPalAuthAssertion`).
- `OrderRequest`: `intent: CheckoutPaymentIntent` (required; `"CAPTURE"`), `purchaseUnits: PurchaseUnitRequest[]`
  (required), `paymentSource?: PaymentSource`.
  - `PurchaseUnitRequest.amount: AmountWithBreakdown` (required) = `{ currencyCode: string; value: string }`.
  - `PaymentSource.paypal?: PayPalWallet` → `experienceContext?: PayPalWalletExperienceContext` →
    `returnUrl?: string`, `cancelUrl?: string`. SDK fills defaults on encode: `shippingPreference: GET_FROM_FILE`,
    `contactPreference: NO_CONTACT_INFO`, `landingPage: NO_PREFERENCE`, `userAction: CONTINUE`,
    `paymentMethodPreference: UNRESTRICTED`.
- Error arms: `"error"` 400 `Error` · `"error2"` 401 · `"error3"` 422 · `"error4"` default · `"undeclared"`.
- Use from response: `id` (required by us — guard `undefined`), `links[]` rel `"payer-action"` (`href`), `status`.

### `client.orders.getOrder(request: Orders.GetOrderRequest)` → `Order`, error `Orders.GetOrderError`

- Wire `GET /v2/checkout/orders/{id}`; no body. Fields: `id` path (required) · (unused: `fields`, mock, assertion).
- Error arms: `"error"` 401 · `"error2"` 404 · `"error3"` default · `"undeclared"`.
- Use: `status: OrderStatus` (`CREATED|SAVED|APPROVED|VOIDED|COMPLETED|PAYER_ACTION_REQUIRED`, open enum),
  `links`, `purchaseUnits[].payments.captures[]` (`OrdersCapture`: `id?`, `status?: CaptureStatus`, `amount?: Money`),
  `purchaseUnits[].payments.refunds[]` (`Refund`: `id?`, `status?`, `amount?`, `customId?`).

### `client.orders.captureOrder(request: Orders.CaptureOrderRequest)` → `Order`, error `Orders.CaptureOrderError`

- Wire `POST /v2/checkout/orders/{id}/capture`; body optional `OrderCaptureRequest` (`paymentSource?` only).
- Fields: `id` path · `payPalRequestId` header · `prefer` header default `"return=minimal"` · `body` · (unused: mock,
  `payPalClientMetadataId`, assertion).
- Error arms: `"error"` 400 · `"error2"` 401 · `"error3"` 403 · `"error4"` 404 · `"error5"` 422 · `"error6"` 500 ·
  `"error7"` default · `"undeclared"`.
- `CaptureStatus`: `COMPLETED|DECLINED|PARTIALLY_REFUNDED|PENDING|REFUNDED|FAILED` (open enum).

### `client.payments.getCapturedPayment(request: Payments.GetCapturedPaymentRequest)` → `CapturedPayment`

- Wire `GET /v2/payments/captures/{capture_id}`. Fields: `captureId` path (wire `capture_id`).
- Error `Payments.GetCapturedPaymentError`: `"error"` 401 · `"error2"` 403 · `"error3"` 404 · `"error500"` 500 (no
  body) · `"error4"` default · `"undeclared"`.
- Use: `status`, `amount`. (Used to settle a capture that came back `PENDING`.)

### `client.payments.refundCapturedPayment(request: Payments.RefundCapturedPaymentRequest)` → `Refund`

- Wire `POST /v2/payments/captures/{capture_id}/refund`; body optional `RefundRequest`.
- Fields: `captureId` path (`capture_id`) · `payPalRequestId` header · `prefer` default `"return=minimal"` · `body` ·
  (unused: mock, assertion).
- `RefundRequest`: `amount?: Money` (`{ currencyCode; value }`), `customId?`, `invoiceId?`, `noteToPayer?`,
  `paymentInstruction?`.
- Error `Payments.RefundCapturedPaymentError`: `"error"` 400 · `"error2"` 401 · `"error3"` 403 · `"error4"` 404 ·
  `"error5"` 409 · `"error6"` 422 · `"error500"` 500 (no body) · `"error7"` default · `"undeclared"`.
- `RefundStatus`: `CANCELLED|FAILED|PENDING|COMPLETED` (open enum). Use `id`, `status`.

### `Error` (PayPal error body) — `name: string`, `message: string`, `debugId: string` (required),

`details?: { issue: string; description?: string; field?; value?; location? }[]`.

### Response mode

All calls `await`ed (throwing). Errors translated in one place (`src/lib/paypal.ts` `classifyPaypalError`), by
`err.kind` then `err.status`; arm tags never switched on across operations. The reason is read from a declared arm's
`body`, or — for the always-present `"undeclared"` arm (an undeclared status, or a `default`-arm body that does not
fit PayPal's `Error` schema, e.g. a gateway error without `debug_id`) — from `rawBody` parsed as JSON when it is
JSON. `DecodeError` on 2xx = unknown outcome on writes; `DecodeError` on an error status keeps that status (generic
reason). Anything outside the SDK family except our deadline (a bug, `ConfigurationError`, a foreign abort) is
rethrown to the app's 500 handler.
Guard required members after each call: `Order.id` (create), capture `id`/`status`/`amount` (capture),
`Refund.id`/`status` (refund).

## 1b.1 DURABLE WRITES

### DUPLICATE CLAIMS

| Write                   | Where the claim is stored                                                                                                         | What rejects the second one                                                                                                               | Where that rejection is caught                                                                                                                                     | Where in the code                                                                                                                   |
| ----------------------- | --------------------------------------------------------------------------------------------------------------------------------- | ----------------------------------------------------------------------------------------------------------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------ | ----------------------------------------------------------------------------------------------------------------------------------- |
| `createOrder`           | `paypal_payments` row inserted (state `creating`, `request_id` = new UUID) before the call                                        | `paypal_payments.order_id` PRIMARY KEY (one PayPal checkout per store order)                                                              | `isUniqueViolation` in `startPaypalCheckout`; loser reuses the winner's row (redirect to its approval link, or replays `createOrder` with the stored `request_id`) | claim: `db/payments.ts` `insertPaymentClaim`; call: `services/payments.ts` `startPaypalCheckout` → `createPaypalOrder`              |
| `captureOrder`          | `paypal_payments.state` `awaiting_approval` → `capturing` conditional UPDATE (also requires `orders.status = 'awaiting_payment'`) | `UPDATE … WHERE order_id = ?1 AND state = 'awaiting_approval' AND paypal_order_id = ?2 AND EXISTS(order awaiting_payment)` changes 0 rows | `services/payments.ts` `capturePaypalPayment` (changes === 0 → reread own row)                                                                                     | claim: `db/payments.ts` `claimCapture`; call: `capturePaypalPayment`; `PayPal-Request-Id` = `${request_id}:capture`                 |
| `refundCapturedPayment` | `paypal_refunds` row (state `requested`) inserted before the call, keyed by the admin form's `refundKey`                          | `UNIQUE (order_id, refund_key)`                                                                                                           | `isUniqueViolation` in `refundPaypalPayment`; loser reports the existing refund row                                                                                | claim: `db/payments.ts` `insertRefundClaim`; call: `services/payments.ts` `refundPaypalPayment`; `PayPal-Request-Id` = `refund_key` |

Release on refusal: createOrder 4xx → claim row deleted; capture 4xx → back to `awaiting_approval`; refund 4xx →
row `failed` (excluded from the refundable sum).

### UNKNOWN OUTCOMES

| Write                   | The operation you re-read with                                                                                                                  | The reference you search by                                                                    | Where in the code                                                                                                             | The test that fails the connection                                                                                   |
| ----------------------- | ----------------------------------------------------------------------------------------------------------------------------------------------- | ---------------------------------------------------------------------------------------------- | ----------------------------------------------------------------------------------------------------------------------------- | -------------------------------------------------------------------------------------------------------------------- |
| `createOrder`           | `createOrder` **replayed with the same `PayPal-Request-Id`** (smoke-verified: returns the same order). There is no list/search-orders operation | `paypal_payments.request_id`                                                                   | `services/payments.ts` `createPaypalOrder` (row stays `creating`; next "Pay with PayPal" replays)                             | `test/payments.test.ts` "createOrder connection failure keeps the claim and replays with the same PayPal-Request-Id" |
| `captureOrder`          | `getOrder(paypal_order_id)`                                                                                                                     | PayPal order id; capture found in `purchaseUnits[].payments.captures[]`                        | `services/payments.ts` `settleCaptureFromPaypal` (called from `capturePaypalPayment` catch and from `reconcilePayment`)       | `test/payments.test.ts` "capture timeout re-reads the PayPal order and records the capture"                          |
| `refundCapturedPayment` | `getOrder(paypal_order_id)`                                                                                                                     | `Refund.customId` = `northwind-refund-<refund row id>` in `purchaseUnits[].payments.refunds[]` | `services/payments.ts` `settleRefundFromPaypal` (from `refundPaypalPayment` catch and the admin "Check refund status" action) | `test/payments.test.ts` "refund connection failure re-reads the order and settles by custom id"                      |

Never-sent failures (`AuthError` — logged with the token endpoint's status from `cause` —, `EncodeError`, and a
`ConnectionError`/`TimeoutError` whose `uri` is the token endpoint, which the SDK passes through unwrapped): no
re-read; claim released (create: row deleted; capture: back to
`awaiting_approval`; refund: `failed`). Tests (`test/payments.test.ts`): "refused credentials: 502, no re-read, and the amount is released" (refund: API
401, then token endpoint refused → `AuthError`) and "capture refused for our credentials: 502, no re-read, claim
released", plus "treats a connection failure on the token request as never sent: no re-read, amount released".
Our own deadline running out mid-write is unknown: "bounds a hung capture with the operation deadline and settles it
by re-reading PayPal" and "keeps the capture claim when the re-read also runs out of time". Not found on re-read (or re-read fails): state stays `creating` / `capturing` / `unknown` — shown as
"being confirmed", never as failed.

**Recovering an unknown refund.** "Check refund status" (`recheckRefund`) re-reads the PayPal order first. Only when
that read succeeds and shows no refund with our `custom_id` is the refund re-sent, with its **original**
`PayPal-Request-Id` (PayPal keeps refund keys 45 days; we replay only within 44), so PayPal returns the original
refund if it made one. A replay answered with anything but an explicit 4xx refusal (429, credentials, not sent)
leaves the refund unknown with its amount reserved; a failed re-read never triggers a replay.

**Recovery matrix** (`test/recovery.test.ts`, against the stateful stand-in `test/paypal-sim.ts`, which deduplicates
on `PayPal-Request-Id`, records the `Idempotency-Key`, and counts effects). For createOrder, captureOrder and
refundCapturedPayment each: a single 429, 503 or 504-after-PayPal-acted is invisible (first call succeeds, the SDK sent
the same request twice, one effect, no re-read); a sustained 429/503 is reported and the next attempt recovers; a
lost answer (timeout before/after PayPal acted, connection lost after it acted) is sent once by the SDK and settled
by the re-read; a 409 after a 504 is settled by the re-read and never releases a refund's amount. Retry-After is
honoured, and one longer than the deadline ends the call within it. Edge cases: a refund replay after re-reads that
missed it, a replay that stays rate-limited, a re-read that fails (no replay), a re-read retried on 429, and a capture
whose answer and re-reads all time out. Every case ends with one PayPal order / one charge / one refund.

## 1b.2 CROSS-OPERATION INVARIANTS

| Invariant                                                                                | Where the legal set comes from                                             | Enforced where                                                                                                                                   | The test that proves it                                                     |
| ---------------------------------------------------------------------------------------- | -------------------------------------------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------ | --------------------------------------------------------------------------- |
| Refund amount ∈ (0, captured − refunds not failed]                                       | `paypal_payments.captured_cents` and `paypal_refunds` (this app's records) | parsed in route (zod, > 0, 2 dp); atomically in `insertRefundClaim` (INSERT … SELECT … WHERE remaining ≥ amount) — no claim exists when rejected | "rejects a refund larger than the refundable amount without calling PayPal" |
| Refund only for this store order's own completed capture                                 | `paypal_payments` row for the order, state `completed`, `capture_id` set   | `refundPaypalPayment` before claim                                                                                                               | "refuses to refund an unpaid order without calling PayPal"                  |
| Capture only for the PayPal order we created for this store order, and only by its buyer | `paypal_payments.paypal_order_id` for the order; `orders.buyer_user_id`    | return route checks `token` query == stored `paypal_order_id`; order loaded with `getOrderForUser`; claim UPDATE includes `paypal_order_id`      | "ignores a return with a PayPal token that is not this order's"             |
| Approval redirect host                                                                   | `PAYPAL_ENV` → `www.sandbox.paypal.com` / `www.paypal.com`                 | `approvalUrlFrom` in `lib/paypal.ts`                                                                                                             | "refuses an approval link on an unexpected host"                            |
| Captured amount/currency == order total                                                  | `orders.total_cents`, `orders.currency`                                    | `settleCapture` — mismatch is logged as an error and the order is **not** marked paid                                                            | "does not mark paid when PayPal captured a different amount"                |

## 1b.3 OPTIONAL FIELDS

createOrder:

| Field                                                                                                                                                       | What requires it                                               | Set it?                      |
| ----------------------------------------------------------------------------------------------------------------------------------------------------------- | -------------------------------------------------------------- | ---------------------------- |
| `payPalRequestId`                                                                                                                                           | DUPLICATE CLAIMS + UNKNOWN OUTCOMES (createOrder replay)       | ✅ `request_id`              |
| `prefer`                                                                                                                                                    | nothing (minimal returns `id`, `status`, `links` — all we use) | ❌ (SDK still sends default) |
| `paymentSource.paypal.experienceContext.returnUrl` / `cancelUrl`                                                                                            | task: "approve on PayPal and come back to the store"           | ✅                           |
| `purchaseUnits[].referenceId/customId/invoiceId/description/items/shipping/softDescriptor/payee`                                                            | nothing                                                        | ❌                           |
| `experienceContext.brandName/locale/shippingPreference/userAction/landingPage/…`                                                                            | nothing (SDK fills its defaults)                               | ❌                           |
| `payPalMockResponse`, `payPalPartnerAttributionId`, `payPalClientMetadataId`, `payPalAuthAssertion`, `processingInstruction`, `payer`, `applicationContext` | nothing                                                        | ❌                           |

captureOrder:

| Field                                 | What requires it                                                                                  | Set it?                      |
| ------------------------------------- | ------------------------------------------------------------------------------------------------- | ---------------------------- |
| `payPalRequestId`                     | DUPLICATE CLAIMS (capture claim) — same key across our own retries                                | ✅ `${request_id}:capture`   |
| `prefer`                              | we must read capture `id`/`status`/`amount` from the response (UNKNOWN OUTCOMES / invariant rows) | ✅ `"return=representation"` |
| `body`                                | smoke: omitting it → 415                                                                          | ✅ `{}`                      |
| mock, client-metadata, auth-assertion | nothing                                                                                           | ❌                           |

refundCapturedPayment:

| Field                                                                      | What requires it                                                | Set it?                    |
| -------------------------------------------------------------------------- | --------------------------------------------------------------- | -------------------------- |
| `payPalRequestId`                                                          | DUPLICATE CLAIMS (refund claim)                                 | ✅ `refund_key`            |
| `body.amount`                                                              | task: "in full or in part" (full = remaining refundable amount) | ✅                         |
| `body.customId`                                                            | UNKNOWN OUTCOMES refund row (search reference)                  | ✅ `northwind-refund-<id>` |
| `body.noteToPayer/invoiceId/paymentInstruction`, `prefer`, mock, assertion | nothing                                                         | ❌                         |

getOrder / getCapturedPayment: only the path id.

Test: the outgoing createOrder/capture/refund requests carry no key we set without a row (body keys and our headers).

## 1b.4 WHEN THE API SAYS NO

Same mapping for createOrder (customer "Pay with PayPal"), captureOrder (customer "Pay now"), refund (admin form):

| status                                        | your app answers               | the caller reads                                                                                 | test                                                                                   |
| --------------------------------------------- | ------------------------------ | ------------------------------------------------------------------------------------------------ | -------------------------------------------------------------------------------------- |
| 4xx other than 401/403/429                    | the same 4xx, page re-rendered | PayPal's reason: `details[0].description` ?? `message` (+ issue code), declared body or raw JSON | fake 422 with a reason; assert status 422 and reason in page; off-schema 409 body test |
| 401 / 403                                     | 502                            | "PayPal is not available right now (store configuration)."                                       | fake 401; assert 502 + fixed message                                                   |
| 429                                           | 503                            | "PayPal is busy right now. Please try again in a minute."                                        | —                                                                                      |
| 5xx                                           | 502                            | "PayPal had a problem. Please try again." (refund/capture: treated as unknown → re-read first)   | bodiless 500 on capture → re-read, debug id from header                                |
| no response, on a write                       | per UNKNOWN OUTCOMES           | "We're confirming the payment with PayPal" — never "failed"                                      | connection-failure tests above                                                         |
| no response, on a read                        | 502                            | "We couldn't reach PayPal."                                                                      | —                                                                                      |
| AuthError / EncodeError / token-request fault | 502                            | config message (auth/encode) or "couldn't reach PayPal" (token fault); nothing sent              | refused-credentials and token-connection tests                                         |

## Data model (migration 0003_paypal_payments.sql)

- `paypal_payments(order_id PK → orders, request_id UNIQUE, paypal_order_id UNIQUE NULL, state CHECK in
creating|awaiting_approval|capturing|completed|pending|declined, amount_cents, currency, capture_id, captured_cents,
failure_reason, created_at, updated_at)`.
- `paypal_refunds(id PK, order_id → orders, refund_key, amount_cents > 0, currency, state CHECK in
requested|pending|completed|failed|unknown, paypal_refund_id, failure_reason, requested_by_user_id, created_at,
updated_at, UNIQUE(order_id, refund_key))`.
- `orders.status` gains `paid` (set in the same batch that records a COMPLETED capture). Cancel is refused while a
  payment row is `capturing|pending|completed`.

## Flow

1. Order page (awaiting payment): "Pay with PayPal" POST `/orders/:id/pay` → claim → `createOrder` → 303 to the
   `payer-action` link (host allow-listed). CSP `form-action` gains the PayPal approval origin for this env.
2. PayPal returns to GET `/orders/:id/paypal/return?token=…` → validate token → confirm page with "Pay $X now"
   (POST `/orders/:id/paypal/capture`, CSRF). `cancelUrl` = `/orders/:id?paypal=cancelled`.
3. Capture → COMPLETED → order `paid`; PENDING → payment `pending` (re-checked with `getCapturedPayment` when the
   page is viewed); DECLINED/FAILED → `declined`, customer can try again (new PayPal order).
4. Admin order page: payment panel (status, PayPal ids, captured, refunded, refund list) + refund form (amount,
   blank = full remaining; hidden `refundKey`). Unknown refunds get "Check refund status".

## Assumptions & Blockers

- Minor: currency is USD only (store default); amounts are converted cents ↔ `"12.34"` with integer math.
- Minor: SDK default `shippingPreference: GET_FROM_FILE` lets the buyer pick a PayPal address; the store keeps its
  own ship-to. Not changed (nothing in the task requires it) — flagged to the user.
- Minor: no webhooks in scope; PENDING captures and unknown outcomes settle on page view / admin action.
- To raise with the user (not blocking the build): deploying sandbox credentials to a worker that "goes live to real
  customers" means real customers cannot actually pay; live credentials + `PAYPAL_ENV=live` + live gateway are needed.

## REQUIRED READING

- MUST load `typescript-getting-started` — loaded.
- MUST load `typescript-error-handling` — loaded (error translation, DecodeError/unknown outcomes).
- MUST load `typescript-client-initialization` — loaded (one client per isolate, credential check).
- MUST load `typescript-configuration-resilience` — loaded (retry gate, logging off, fetch seam).
- MUST load `typescript-testing` — loaded (fake fetch, token request first, wire-shaped stubs).
