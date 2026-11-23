import { env } from "cloudflare:workers";
import { PaypalClient } from "paypal";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { getPayment, listRefunds } from "../src/db/payments";
import { parseDecimalAmount, toDecimalAmount } from "../src/lib/money";
import type { Paypal } from "../src/lib/paypal";
import { getOrder } from "../src/services/orders";
import { capturePaypalPayment, refundPaypalPayment } from "../src/services/payments";
import { Browser, checkoutKeyFrom, createTestUser, validAddress } from "./helpers";

// ---------------------------------------------------------------------------------------------------------------
// A fake PayPal behind the gateway, on the fetch seam. Bodies are wire-shaped (snake_case), as PayPal sends them.

const GATEWAY = "https://paypal-gateway.test/s/with";
const APPROVAL_HOST = "https://www.sandbox.paypal.com";

interface PaypalCall {
  method: string;
  path: string;
  headers: Headers;
  body: string | undefined;
  json: Record<string, unknown> | undefined;
  signal: AbortSignal;
}

type Responder = (call: PaypalCall) => Response | Promise<Response>;

function json(status: number, body: unknown): Response {
  return new Response(JSON.stringify(body), { status, headers: { "content-type": "application/json" } });
}

function paypalError(status: number, issue: string, description: string): Response {
  return json(status, {
    name: "UNPROCESSABLE_ENTITY",
    message: "The requested action could not be performed.",
    debug_id: "dbg-test-1",
    details: [{ issue, description }],
  });
}

class FakePaypal {
  readonly calls: PaypalCall[] = [];
  private readonly routes: { method: string; pattern: RegExp; responders: Responder[] }[] = [];

  /** Answers matching requests with each responder in turn (the last one repeats). */
  on(method: string, pattern: RegExp, ...responders: Responder[]): this {
    this.routes.unshift({ method, pattern, responders });
    return this;
  }

  callsTo(method: string, pattern: RegExp): PaypalCall[] {
    return this.calls.filter((c) => c.method === method && pattern.test(c.path));
  }

  readonly fetch = async (input: RequestInfo | URL, init?: RequestInit): Promise<Response> => {
    const request = new Request(input, init);
    const url = new URL(request.url);
    if (!url.href.startsWith(GATEWAY)) throw new Error(`unexpected host in test: ${url.origin}`);
    const body = request.body === null ? undefined : new TextDecoder().decode(await request.clone().arrayBuffer());
    const path = url.pathname.slice(new URL(GATEWAY).pathname.length);
    let parsed: Record<string, unknown> | undefined;
    if (body && request.headers.get("content-type")?.includes("json")) parsed = JSON.parse(body);
    const call: PaypalCall = {
      method: request.method,
      path,
      headers: request.headers,
      body,
      json: parsed,
      signal: request.signal,
    };
    this.calls.push(call);
    const route = this.routes.find((r) => r.method === request.method && r.pattern.test(path));
    if (!route) return json(500, { name: "INTERNAL_SERVER_ERROR", message: `no fake for ${request.method} ${path}` });
    const responder = route.responders.length > 1 ? route.responders.shift() : route.responders[0];
    if (!responder) throw new Error("no responder");
    return responder(call);
  };
}

let fake: FakePaypal;
let sequence = 0;

beforeEach(() => {
  fake = new FakePaypal();
  fake.on("POST", /^\/v1\/oauth2\/token$/, () =>
    json(200, { access_token: "test-access-token", token_type: "Bearer", expires_in: 3600 }),
  );
  vi.spyOn(globalThis, "fetch").mockImplementation(fake.fetch);
});

afterEach(() => {
  vi.restoreAllMocks();
});

function nextId(prefix: string): string {
  sequence += 1;
  return `${prefix}${Date.now().toString(36).toUpperCase()}${sequence}`;
}

function createdOrder(id: string): Response {
  return json(200, {
    id,
    status: "PAYER_ACTION_REQUIRED",
    links: [
      { href: `https://api.sandbox.paypal.com/v2/checkout/orders/${id}`, rel: "self", method: "GET" },
      { href: `${APPROVAL_HOST}/checkoutnow?token=${id}`, rel: "payer-action", method: "GET" },
    ],
  });
}

function capturedOrder(id: string, capture: { id: string; status: string; value: string }): Response {
  return json(201, {
    id,
    status: capture.status === "COMPLETED" ? "COMPLETED" : "COMPLETED",
    purchase_units: [
      {
        reference_id: "default",
        payments: {
          captures: [
            { id: capture.id, status: capture.status, amount: { currency_code: "USD", value: capture.value } },
          ],
        },
      },
    ],
  });
}

// ---------------------------------------------------------------------------------------------------------------
// Store helpers

/** A signed-in customer with an order of 3 × $7.50 = $22.50. */
async function customerWithOrder(): Promise<{ browser: Browser; orderId: number }> {
  const user = await createTestUser();
  const browser = new Browser();
  await browser.signIn(user.email);
  await browser.addToBasket(9, 3);
  const { html } = await browser.get("/checkout");
  const response = await browser.post("/checkout", { checkoutKey: checkoutKeyFrom(html), ...validAddress });
  const orderId = Number(/\/orders\/(\d+)/.exec(response.headers.get("location") ?? "")?.[1]);
  await browser.get(`/orders/${orderId}`);
  return { browser, orderId };
}

/** Customer order sent to PayPal and approved there; returns the PayPal order id. */
async function approvedOrder(): Promise<{ browser: Browser; orderId: number; paypalOrderId: string }> {
  const { browser, orderId } = await customerWithOrder();
  const paypalOrderId = nextId("PPO");
  fake.on("POST", /^\/v2\/checkout\/orders$/, () => createdOrder(paypalOrderId));
  const pay = await browser.post(`/orders/${orderId}/pay`);
  expect(pay.status).toBe(303);
  const back = await browser.get(`/orders/${orderId}/paypal/return?token=${paypalOrderId}&PayerID=BUYER1`);
  expect(back.response.headers.get("location")).toBe(`/orders/${orderId}/paypal/confirm`);
  await browser.get(`/orders/${orderId}/paypal/confirm`);
  return { browser, orderId, paypalOrderId };
}

/** A paid order ($22.50 captured as captureId). */
async function paidOrder(): Promise<{ orderId: number; paypalOrderId: string; captureId: string }> {
  const { browser, orderId, paypalOrderId } = await approvedOrder();
  const captureId = nextId("CAP");
  fake.on("POST", /\/capture$/, () =>
    capturedOrder(paypalOrderId, { id: captureId, status: "COMPLETED", value: "22.50" }),
  );
  const response = await browser.post(`/orders/${orderId}/paypal/capture`);
  expect(response.headers.get("location")).toBe(`/orders/${orderId}?notice=paid`);
  return { orderId, paypalOrderId, captureId };
}

async function adminOn(orderId: number): Promise<{ admin: Browser; refundKey: string }> {
  const user = await createTestUser("admin");
  const admin = new Browser();
  await admin.signIn(user.email);
  const { html } = await admin.get(`/admin/orders/${orderId}`);
  // Only paid orders render the refund form.
  return { admin, refundKey: html.includes('name="refundKey"') ? refundKeyFrom(html) : "" };
}

function refundKeyFrom(html: string): string {
  const match = /name="refundKey" value="([^"]+)"/.exec(html);
  if (!match?.[1]) throw new Error("refund key not found");
  return match[1];
}

// ---------------------------------------------------------------------------------------------------------------

describe("money conversion for PayPal", () => {
  it("converts cents and decimal strings with integer math", () => {
    expect(toDecimalAmount(2250)).toBe("22.50");
    expect(toDecimalAmount(5)).toBe("0.05");
    expect(toDecimalAmount(0)).toBe("0.00");
    expect(parseDecimalAmount("22.50")).toBe(2250);
    expect(parseDecimalAmount("22.5")).toBe(2250);
    expect(parseDecimalAmount("22")).toBe(2200);
    expect(parseDecimalAmount("0.07")).toBe(7);
    for (const bad of ["", "1.234", "-1", "1e3", "abc", "1,00"]) expect(parseDecimalAmount(bad)).toBeNull();
  });
});

describe("starting a PayPal checkout", () => {
  it("claims the checkout, creates the PayPal order through the gateway and redirects to PayPal", async () => {
    const { browser, orderId } = await customerWithOrder();
    const paypalOrderId = nextId("PPO");
    let claimWhenSent: Awaited<ReturnType<typeof getPayment>> = null;
    fake.on("POST", /^\/v2\/checkout\/orders$/, async () => {
      claimWhenSent = await getPayment(env.DB, orderId);
      return createdOrder(paypalOrderId);
    });

    const response = await browser.post(`/orders/${orderId}/pay`);

    expect(response.status).toBe(303);
    expect(response.headers.get("location")).toBe(`${APPROVAL_HOST}/checkoutnow?token=${paypalOrderId}`);
    expect(claimWhenSent).toMatchObject({ state: "creating", amount_cents: 2250 });

    const [create] = fake.callsTo("POST", /^\/v2\/checkout\/orders$/);
    expect(create).toBeDefined();
    if (!create) return;
    expect(create.headers.get("authorization")).toBe("Bearer test-access-token");
    expect(create.headers.get("paypal-request-id")).toBe((await getPayment(env.DB, orderId))?.request_id);
    // Only keys a row of the contract sheet requires (the experience context also carries the SDK's own defaults).
    expect(Object.keys(create.json ?? {}).sort()).toEqual(["intent", "payment_source", "purchase_units"]);
    expect(create.json?.intent).toBe("CAPTURE");
    expect(create.json?.purchase_units).toEqual([{ amount: { currency_code: "USD", value: "22.50" } }]);
    const source = create.json?.payment_source as
      { paypal: { experience_context: Record<string, unknown> } } | undefined;
    const context = source?.paypal.experience_context ?? {};
    expect(context.return_url).toBe(`https://northwind.test/orders/${orderId}/paypal/return`);
    expect(context.cancel_url).toBe(`https://northwind.test/orders/${orderId}?notice=paypal_cancelled`);
    for (const header of ["paypal-mock-response", "paypal-partner-attribution-id", "paypal-auth-assertion"]) {
      expect(create.headers.get(header)).toBeNull();
    }

    const payment = await getPayment(env.DB, orderId);
    expect(payment).toMatchObject({ state: "awaiting_approval", paypal_order_id: paypalOrderId });
    const page = await browser.get(`/orders/${orderId}`);
    expect(page.html).toContain("Waiting for PayPal approval");
  });

  it("sends a second click to the same PayPal order instead of creating another", async () => {
    const { browser, orderId } = await customerWithOrder();
    const paypalOrderId = nextId("PPO");
    fake.on("POST", /^\/v2\/checkout\/orders$/, () => createdOrder(paypalOrderId));
    fake.on("GET", new RegExp(`^/v2/checkout/orders/${paypalOrderId}$`), () => createdOrder(paypalOrderId));

    await browser.post(`/orders/${orderId}/pay`);
    const second = await browser.post(`/orders/${orderId}/pay`);

    expect(second.headers.get("location")).toBe(`${APPROVAL_HOST}/checkoutnow?token=${paypalOrderId}`);
    expect(fake.callsTo("POST", /^\/v2\/checkout\/orders$/)).toHaveLength(1);
  });

  it("concurrent clicks share one claim and one PayPal-Request-Id", async () => {
    const { browser, orderId } = await customerWithOrder();
    const paypalOrderId = nextId("PPO");
    fake.on("POST", /^\/v2\/checkout\/orders$/, () => createdOrder(paypalOrderId));
    fake.on("GET", new RegExp(`^/v2/checkout/orders/${paypalOrderId}$`), () => createdOrder(paypalOrderId));

    const responses = await Promise.all([
      browser.post(`/orders/${orderId}/pay`),
      browser.post(`/orders/${orderId}/pay`),
    ]);

    for (const r of responses) expect(r.status).toBe(303);
    const keys = new Set(
      fake.callsTo("POST", /^\/v2\/checkout\/orders$/).map((c) => c.headers.get("paypal-request-id")),
    );
    expect(keys.size).toBe(1);
  });

  it("createOrder connection failure keeps the claim and replays with the same PayPal-Request-Id", async () => {
    const { browser, orderId } = await customerWithOrder();
    const paypalOrderId = nextId("PPO");
    fake.on(
      "POST",
      /^\/v2\/checkout\/orders$/,
      () => {
        throw new TypeError("network connection lost");
      },
      () => createdOrder(paypalOrderId),
    );

    const first = await browser.post(`/orders/${orderId}/pay`);
    expect(first.status).toBe(502);
    expect(await first.text()).toContain("you won&#39;t be charged twice");
    const claim = await getPayment(env.DB, orderId);
    expect(claim?.state).toBe("creating");

    const second = await browser.post(`/orders/${orderId}/pay`);
    expect(second.headers.get("location")).toBe(`${APPROVAL_HOST}/checkoutnow?token=${paypalOrderId}`);
    const sent = fake.callsTo("POST", /^\/v2\/checkout\/orders$/).map((c) => c.headers.get("paypal-request-id"));
    expect(sent).toEqual([claim?.request_id, claim?.request_id]);
  });

  it("returns PayPal's 4xx and reason, and releases the claim", async () => {
    const { browser, orderId } = await customerWithOrder();
    fake.on("POST", /^\/v2\/checkout\/orders$/, () =>
      paypalError(422, "CURRENCY_NOT_SUPPORTED", "Currency code is not supported for this merchant."),
    );

    const response = await browser.post(`/orders/${orderId}/pay`);

    expect(response.status).toBe(422);
    expect(await response.text()).toContain("Currency code is not supported for this merchant.");
    expect(await getPayment(env.DB, orderId)).toBeNull();
  });

  it("answers 502 with a fixed message when PayPal refuses our credentials", async () => {
    const { browser, orderId } = await customerWithOrder();
    fake.on("POST", /^\/v2\/checkout\/orders$/, () => paypalError(401, "INVALID_TOKEN", "secret detail"));

    const response = await browser.post(`/orders/${orderId}/pay`);

    expect(response.status).toBe(502);
    const html = await response.text();
    expect(html).toContain("store configuration problem");
    expect(html).not.toContain("secret detail");
  });

  it("refuses an approval link on an unexpected host", async () => {
    const { browser, orderId } = await customerWithOrder();
    const paypalOrderId = nextId("PPO");
    fake.on("POST", /^\/v2\/checkout\/orders$/, () =>
      json(200, {
        id: paypalOrderId,
        status: "PAYER_ACTION_REQUIRED",
        links: [{ href: "https://evil.example/checkoutnow", rel: "payer-action", method: "GET" }],
      }),
    );

    const response = await browser.post(`/orders/${orderId}/pay`);

    expect(response.status).toBe(502);
    expect(response.headers.get("location")).toBeNull();
  });

  it("does not let a customer pay someone else's order", async () => {
    const { orderId } = await customerWithOrder();
    const other = await customerWithOrder();
    const response = await other.browser.post(`/orders/${orderId}/pay`);
    expect(response.status).toBe(404);
    expect(fake.callsTo("POST", /^\/v2\/checkout\/orders$/)).toHaveLength(0);
  });

  it("allows PayPal as a form-action target in the CSP", async () => {
    const { browser, orderId } = await customerWithOrder();
    const { response } = await browser.get(`/orders/${orderId}`);
    expect(response.headers.get("content-security-policy")).toContain("form-action 'self' https://*.paypal.com");
  });
});

describe("returning from PayPal and capturing", () => {
  it("ignores a return with a PayPal token that is not this order's", async () => {
    const { browser, orderId } = await approvedOrder();
    const back = await browser.get(`/orders/${orderId}/paypal/return?token=SOMEONE-ELSES`);
    expect(back.response.headers.get("location")).toBe(`/orders/${orderId}`);
  });

  it("captures once, with the capture claim in place, and only then marks the order paid", async () => {
    const { browser, orderId, paypalOrderId } = await approvedOrder();
    const captureId = nextId("CAP");
    let stateWhenSent: string | undefined;
    let orderStatusWhenSent: string | undefined;
    fake.on("POST", /\/capture$/, async () => {
      stateWhenSent = (await getPayment(env.DB, orderId))?.state;
      orderStatusWhenSent = (await getOrder(env.DB, orderId))?.status;
      return capturedOrder(paypalOrderId, { id: captureId, status: "COMPLETED", value: "22.50" });
    });

    const confirm = await browser.get(`/orders/${orderId}/paypal/confirm`);
    expect(confirm.html).toContain("Pay $22.50 now");
    const response = await browser.post(`/orders/${orderId}/paypal/capture`);

    expect(response.headers.get("location")).toBe(`/orders/${orderId}?notice=paid`);
    expect(stateWhenSent).toBe("capturing");
    expect(orderStatusWhenSent).toBe("awaiting_payment");
    const [capture] = fake.callsTo("POST", /\/capture$/);
    const payment = await getPayment(env.DB, orderId);
    expect(capture?.path).toBe(`/v2/checkout/orders/${paypalOrderId}/capture`);
    expect(capture?.headers.get("paypal-request-id")).toBe(`${payment?.request_id}:capture`);
    expect(capture?.headers.get("prefer")).toBe("return=representation");
    expect(capture?.body).toBe("{}");
    expect(payment).toMatchObject({ state: "completed", capture_id: captureId, captured_cents: 2250 });
    expect((await getOrder(env.DB, orderId))?.status).toBe("paid");

    const page = await browser.get(`/orders/${orderId}?notice=paid`);
    expect(page.html).toContain("Thank you! Your payment is complete.");
    expect(page.html).toMatch(/data-testid="payment-status">Paid with PayPal</);
    expect(page.html).not.toContain('data-testid="pay-with-paypal"');

    // A second submit does not capture again.
    const again = await browser.post(`/orders/${orderId}/paypal/capture`);
    expect(again.headers.get("location")).toBe(`/orders/${orderId}?notice=paid`);
    expect(fake.callsTo("POST", /\/capture$/)).toHaveLength(1);
  });

  it("capture timeout re-reads the PayPal order and records the capture", async () => {
    const { browser, orderId, paypalOrderId } = await approvedOrder();
    const captureId = nextId("CAP");
    fake.on("POST", /\/capture$/, () => {
      throw new TypeError("connection reset");
    });
    fake.on("GET", new RegExp(`^/v2/checkout/orders/${paypalOrderId}$`), () =>
      capturedOrder(paypalOrderId, { id: captureId, status: "COMPLETED", value: "22.50" }),
    );

    const response = await browser.post(`/orders/${orderId}/paypal/capture`);

    expect(fake.callsTo("GET", new RegExp(`/${paypalOrderId}$`)).length).toBeGreaterThanOrEqual(1);
    expect(response.headers.get("location")).toBe(`/orders/${orderId}?notice=paid`);
    expect((await getOrder(env.DB, orderId))?.status).toBe("paid");
  });

  it("releases the capture claim when the re-read shows PayPal never captured", async () => {
    const { browser, orderId, paypalOrderId } = await approvedOrder();
    fake.on("POST", /\/capture$/, () => {
      throw new TypeError("connection reset");
    });
    fake.on("GET", new RegExp(`^/v2/checkout/orders/${paypalOrderId}$`), () =>
      json(200, { id: paypalOrderId, status: "APPROVED" }),
    );

    const response = await browser.post(`/orders/${orderId}/paypal/capture`);

    expect(response.headers.get("location")).toBe(`/orders/${orderId}?notice=confirming`);
    expect((await getPayment(env.DB, orderId))?.state).toBe("awaiting_approval");
    expect((await getOrder(env.DB, orderId))?.status).toBe("awaiting_payment");
  });

  it("keeps an unknown capture as 'confirming', never failed, when PayPal can't be re-read", async () => {
    const { browser, orderId } = await approvedOrder();
    fake.on("POST", /\/capture$/, () => {
      throw new TypeError("connection reset");
    });
    fake.on("GET", /^\/v2\/checkout\/orders\//, () => {
      throw new TypeError("still down");
    });

    const response = await browser.post(`/orders/${orderId}/paypal/capture`);

    expect(response.headers.get("location")).toBe(`/orders/${orderId}?notice=confirming`);
    expect((await getPayment(env.DB, orderId))?.state).toBe("capturing");
    const page = await browser.get(`/orders/${orderId}?notice=confirming`);
    expect(page.html).toContain("Confirming payment with PayPal");
  });

  it("shows PayPal's decline reason with its 4xx and lets the buyer go back to PayPal", async () => {
    const { browser, orderId } = await approvedOrder();
    fake.on("POST", /\/capture$/, () =>
      paypalError(422, "INSTRUMENT_DECLINED", "The instrument presented was either declined or expired."),
    );

    const response = await browser.post(`/orders/${orderId}/paypal/capture`);

    expect(response.status).toBe(422);
    const html = await response.text();
    expect(html).toContain("The instrument presented was either declined or expired.");
    expect(html).toContain("Go back to PayPal");
    expect((await getPayment(env.DB, orderId))?.state).toBe("awaiting_approval");
    expect((await getOrder(env.DB, orderId))?.status).toBe("awaiting_payment");
  });

  it("capture refused for our credentials: 502, no re-read, claim released", async () => {
    const { browser, orderId, paypalOrderId } = await approvedOrder();
    fake.on("POST", /\/capture$/, () => paypalError(403, "PERMISSION_DENIED", "internal detail"));

    const response = await browser.post(`/orders/${orderId}/paypal/capture`);

    expect(response.status).toBe(502);
    expect(await response.text()).not.toContain("internal detail");
    expect(fake.callsTo("GET", new RegExp(`/${paypalOrderId}$`))).toHaveLength(0);
    expect((await getPayment(env.DB, orderId))?.state).toBe("awaiting_approval");
  });

  it("does not mark a PENDING capture paid until PayPal completes it", async () => {
    const { browser, orderId, paypalOrderId } = await approvedOrder();
    const captureId = nextId("CAP");
    fake.on("POST", /\/capture$/, () =>
      capturedOrder(paypalOrderId, { id: captureId, status: "PENDING", value: "22.50" }),
    );

    const response = await browser.post(`/orders/${orderId}/paypal/capture`);
    expect(response.headers.get("location")).toBe(`/orders/${orderId}?notice=pending`);
    expect((await getOrder(env.DB, orderId))?.status).toBe("awaiting_payment");

    fake.on("GET", new RegExp(`^/v2/payments/captures/${captureId}$`), () =>
      json(200, { id: captureId, status: "COMPLETED", amount: { currency_code: "USD", value: "22.50" } }),
    );
    const page = await browser.get(`/orders/${orderId}`);
    expect(page.html).toMatch(/data-testid="payment-status">Paid with PayPal</);
    expect((await getOrder(env.DB, orderId))?.status).toBe("paid");
  });

  it("does not mark paid when PayPal captured a different amount", async () => {
    const { browser, orderId, paypalOrderId } = await approvedOrder();
    fake.on("POST", /\/capture$/, () =>
      capturedOrder(paypalOrderId, { id: nextId("CAP"), status: "COMPLETED", value: "1.00" }),
    );

    await browser.post(`/orders/${orderId}/paypal/capture`);

    expect((await getOrder(env.DB, orderId))?.status).toBe("awaiting_payment");
    const { admin } = await adminOn(orderId);
    const { html } = await admin.get(`/admin/orders/${orderId}`);
    expect(html).toContain("PayPal captured a different amount from the order total.");
  });

  it("an admin cannot cancel a paid order", async () => {
    const { orderId } = await paidOrder();
    const { admin } = await adminOn(orderId);
    const response = await admin.post(`/admin/orders/${orderId}/cancel`);
    expect(response.headers.get("location")).toBe(`/admin/orders/${orderId}?notice=not_cancellable`);
    expect((await getOrder(env.DB, orderId))?.status).toBe("paid");
  });

  it("refuses to capture after the order was cancelled", async () => {
    const { browser, orderId } = await approvedOrder();
    const { admin } = await adminOn(orderId);
    await admin.post(`/admin/orders/${orderId}/cancel`);
    const response = await browser.post(`/orders/${orderId}/paypal/capture`);
    expect(response.headers.get("location")).toBe(`/orders/${orderId}`);
    expect(fake.callsTo("POST", /\/capture$/)).toHaveLength(0);
  });
});

describe("refunds", () => {
  it("refunds part of a paid order with the claim in place, then the rest", async () => {
    const { orderId, captureId } = await paidOrder();
    const { admin, refundKey } = await adminOn(orderId);
    let claimsWhenSent: Awaited<ReturnType<typeof listRefunds>> = [];
    fake.on(
      "POST",
      new RegExp(`^/v2/payments/captures/${captureId}/refund$`),
      async () => {
        claimsWhenSent = await listRefunds(env.DB, orderId);
        return json(201, { id: "REF-PART", status: "COMPLETED" });
      },
      () => json(201, { id: "REF-REST", status: "COMPLETED" }),
    );

    const partial = await admin.post(`/admin/orders/${orderId}/refund`, { refundKey, amount: "5.00" });

    expect(partial.headers.get("location")).toBe(`/admin/orders/${orderId}?notice=refunded`);
    expect(claimsWhenSent).toMatchObject([{ state: "requested", amount_cents: 500 }]);
    const [call] = fake.callsTo("POST", /\/refund$/);
    expect(call?.headers.get("paypal-request-id")).toBe(refundKey);
    expect(call?.json).toEqual({
      amount: { currency_code: "USD", value: "5.00" },
      custom_id: `northwind-refund-${claimsWhenSent[0]?.id}`,
    });

    const page = await admin.get(`/admin/orders/${orderId}?notice=refunded`);
    expect(page.html).toContain("PayPal completed the refund.");
    expect(page.html).toMatch(/data-testid="admin-payment-status">Partially refunded</);
    expect(page.html).toMatch(/data-testid="admin-refundable">\$17.50</);

    // Empty amount refunds everything still refundable.
    const rest = await admin.post(`/admin/orders/${orderId}/refund`, {
      refundKey: refundKeyFrom(page.html),
      amount: "",
    });
    expect(rest.headers.get("location")).toBe(`/admin/orders/${orderId}?notice=refunded`);
    expect(fake.callsTo("POST", /\/refund$/)[1]?.json?.amount).toEqual({ currency_code: "USD", value: "17.50" });
    const after = await admin.get(`/admin/orders/${orderId}`);
    expect(after.html).toMatch(/data-testid="admin-payment-status">Refunded</);
    expect(after.html).not.toContain('data-testid="refund-submit"');

    const customerView = (await listRefunds(env.DB, orderId)).map((r) => r.state);
    expect(customerView).toEqual(["completed", "completed"]);
  });

  it("does not refund twice when the same refund form is submitted again", async () => {
    const { orderId, captureId } = await paidOrder();
    const { admin, refundKey } = await adminOn(orderId);
    fake.on("POST", new RegExp(`/captures/${captureId}/refund$`), () =>
      json(201, { id: "REF-1", status: "COMPLETED" }),
    );

    await admin.post(`/admin/orders/${orderId}/refund`, { refundKey, amount: "2.00" });
    const again = await admin.post(`/admin/orders/${orderId}/refund`, { refundKey, amount: "2.00" });

    expect(again.headers.get("location")).toBe(`/admin/orders/${orderId}?notice=refund_duplicate`);
    expect(fake.callsTo("POST", /\/refund$/)).toHaveLength(1);
  });

  it("rejects a refund larger than the refundable amount without calling PayPal", async () => {
    const { orderId } = await paidOrder();
    const { admin, refundKey } = await adminOn(orderId);

    const response = await admin.post(`/admin/orders/${orderId}/refund`, { refundKey, amount: "22.51" });

    expect(response.status).toBe(200);
    expect(await response.text()).toContain("more than can still be refunded ($22.50)");
    expect(fake.callsTo("POST", /\/refund$/)).toHaveLength(0);
    expect(await listRefunds(env.DB, orderId)).toEqual([]);
  });

  it("rejects an invalid amount without calling PayPal", async () => {
    const { orderId } = await paidOrder();
    const { admin, refundKey } = await adminOn(orderId);
    for (const amount of ["0", "-3", "abc", "1.005"]) {
      const response = await admin.post(`/admin/orders/${orderId}/refund`, { refundKey, amount });
      expect(response.status, amount).toBe(200);
      expect(await response.text()).toContain("Enter an amount like 12.50");
    }
    expect(fake.callsTo("POST", /\/refund$/)).toHaveLength(0);
  });

  it("refuses to refund an unpaid order without calling PayPal", async () => {
    const { orderId } = await customerWithOrder();
    const user = await createTestUser("admin");
    const admin = new Browser();
    await admin.signIn(user.email);
    await admin.get(`/admin/orders/${orderId}`);

    const response = await admin.post(`/admin/orders/${orderId}/refund`, {
      refundKey: crypto.randomUUID(),
      amount: "",
    });

    expect(response.status).toBe(409);
    expect(fake.callsTo("POST", /\/refund$/)).toHaveLength(0);
  });

  it("forbids customers from refunding", async () => {
    const { browser, orderId } = await customerWithOrder();
    const response = await browser.post(`/admin/orders/${orderId}/refund`, { refundKey: crypto.randomUUID() });
    expect(response.status).toBe(403);
  });

  it("returns PayPal's 4xx and reason, and makes the amount refundable again", async () => {
    const { orderId, captureId } = await paidOrder();
    const { admin, refundKey } = await adminOn(orderId);
    fake.on("POST", new RegExp(`/captures/${captureId}/refund$`), () =>
      paypalError(
        422,
        "REFUND_TIME_LIMIT_EXCEEDED",
        "You are over the time limit to perform a refund on this capture.",
      ),
    );

    const response = await admin.post(`/admin/orders/${orderId}/refund`, { refundKey, amount: "4.00" });

    expect(response.status).toBe(422);
    expect(await response.text()).toContain("You are over the time limit to perform a refund on this capture.");
    expect(await listRefunds(env.DB, orderId)).toMatchObject([{ state: "failed" }]);
    const page = await admin.get(`/admin/orders/${orderId}`);
    expect(page.html).toMatch(/data-testid="admin-refundable">\$22.50</);
  });

  it("refund connection failure re-reads the order and settles by custom id", async () => {
    const { orderId, paypalOrderId, captureId } = await paidOrder();
    const { admin, refundKey } = await adminOn(orderId);
    fake.on("POST", new RegExp(`/captures/${captureId}/refund$`), () => {
      throw new TypeError("connection reset");
    });
    fake.on("GET", new RegExp(`^/v2/checkout/orders/${paypalOrderId}$`), async () => {
      const [claim] = await listRefunds(env.DB, orderId);
      return json(200, {
        id: paypalOrderId,
        status: "COMPLETED",
        purchase_units: [
          {
            payments: {
              refunds: [
                { id: "REF-OTHER", status: "COMPLETED", custom_id: "northwind-refund-0" },
                { id: "REF-FOUND", status: "COMPLETED", custom_id: `northwind-refund-${claim?.id}` },
              ],
            },
          },
        ],
      });
    });

    const response = await admin.post(`/admin/orders/${orderId}/refund`, { refundKey, amount: "3.00" });

    expect(fake.callsTo("GET", new RegExp(`/${paypalOrderId}$`))).toHaveLength(1);
    expect(response.headers.get("location")).toBe(`/admin/orders/${orderId}?notice=refunded`);
    expect(await listRefunds(env.DB, orderId)).toMatchObject([{ state: "completed", paypal_refund_id: "REF-FOUND" }]);
  });

  it("keeps an unconfirmed refund as unknown (amount reserved) until a re-check finds it", async () => {
    const { orderId, paypalOrderId, captureId } = await paidOrder();
    const { admin, refundKey } = await adminOn(orderId);
    fake.on("POST", new RegExp(`/captures/${captureId}/refund$`), () => {
      throw new TypeError("connection reset");
    });
    fake.on(
      "GET",
      new RegExp(`^/v2/checkout/orders/${paypalOrderId}$`),
      () => json(200, { id: paypalOrderId, status: "COMPLETED" }),
      async () => {
        const [claim] = await listRefunds(env.DB, orderId);
        return json(200, {
          id: paypalOrderId,
          status: "COMPLETED",
          purchase_units: [
            {
              payments: {
                refunds: [{ id: "REF-LATE", status: "COMPLETED", custom_id: `northwind-refund-${claim?.id}` }],
              },
            },
          ],
        });
      },
    );

    const response = await admin.post(`/admin/orders/${orderId}/refund`, { refundKey, amount: "6.00" });
    expect(response.headers.get("location")).toBe(`/admin/orders/${orderId}?notice=refund_unknown`);
    const [refund] = await listRefunds(env.DB, orderId);
    expect(refund?.state).toBe("unknown");
    const page = await admin.get(`/admin/orders/${orderId}`);
    expect(page.html).toMatch(/data-testid="admin-refundable">\$16.50</);
    expect(page.html).toContain("Check refund status");

    const check = await admin.post(`/admin/orders/${orderId}/refunds/${refund?.id}/check`);
    expect(check.headers.get("location")).toBe(`/admin/orders/${orderId}?notice=refunded`);
    expect(await listRefunds(env.DB, orderId)).toMatchObject([{ state: "completed", paypal_refund_id: "REF-LATE" }]);
  });

  it("refused credentials: 502, no re-read, and the amount is released", async () => {
    const { orderId, paypalOrderId, captureId } = await paidOrder();
    const { admin, refundKey } = await adminOn(orderId);
    fake.on("POST", new RegExp(`/captures/${captureId}/refund$`), () =>
      paypalError(401, "INVALID_TOKEN", "Token signature verification failed"),
    );

    const response = await admin.post(`/admin/orders/${orderId}/refund`, { refundKey, amount: "1.00" });

    expect(response.status).toBe(502);
    expect(await response.text()).toContain("store configuration problem");
    expect(fake.callsTo("GET", new RegExp(`/${paypalOrderId}$`))).toHaveLength(0);
    expect(await listRefunds(env.DB, orderId)).toMatchObject([{ state: "failed" }]);

    // The 401 dropped the cached token. Now the token endpoint itself refuses: nothing is sent, nothing re-read.
    fake.on("POST", /^\/v1\/oauth2\/token$/, () => json(401, { error: "invalid_client" }));
    const page = await admin.get(`/admin/orders/${orderId}`);
    const second = await admin.post(`/admin/orders/${orderId}/refund`, {
      refundKey: refundKeyFrom(page.html),
      amount: "1.00",
    });

    expect(second.status).toBe(502);
    // The first refund's 401 was retried once (with a fresh token) before giving up; the second never left.
    expect(fake.callsTo("POST", /\/refund$/)).toHaveLength(2);
    expect(fake.callsTo("GET", new RegExp(`/${paypalOrderId}$`))).toHaveLength(0);
    expect((await listRefunds(env.DB, orderId)).map((r) => r.state)).toEqual(["failed", "failed"]);
  });
});

// ---------------------------------------------------------------------------------------------------------------
// Resilience: deadlines, the retry gate, token-request faults and error bodies outside PayPal's schema.

/** Answers only when the request is aborted (by the SDK's attempt timeout or our deadline). */
function hang(call: PaypalCall): Promise<Response> {
  return new Promise((_resolve, reject) => {
    call.signal.addEventListener("abort", () => reject(call.signal.reason), { once: true });
  });
}

/** A separate client (own token cache) with small budgets, for calling the payments service directly. */
function testPaypal(budgets: { budgetMs: number; rereadBudgetMs: number }): Paypal {
  const client = new PaypalClient({
    serverOptions: { baseUrl: GATEWAY },
    oauth2: { clientId: "test-client-id", clientSecret: "test-client-secret" },
    retry: { maxRetries: 0 },
    logging: { level: "off" },
    fetch: (request) => fake.fetch(request),
  });
  return { client, environment: "sandbox", ...budgets };
}

describe("resilience", () => {
  it("bounds a hung capture with the operation deadline and settles it by re-reading PayPal", async () => {
    const { orderId, paypalOrderId } = await approvedOrder();
    fake.on("POST", /\/capture$/, hang);
    fake.on("GET", new RegExp(`^/v2/checkout/orders/${paypalOrderId}$`), () =>
      json(200, { id: paypalOrderId, status: "APPROVED" }),
    );

    const started = Date.now();
    const result = await capturePaypalPayment(env.DB, testPaypal({ budgetMs: 200, rereadBudgetMs: 2000 }), orderId);

    expect(Date.now() - started).toBeLessThan(3000);
    expect(result).toEqual({ kind: "unknown" });
    // The re-read ran after the capture was abandoned, and showed PayPal never captured: claim released.
    expect(fake.callsTo("GET", new RegExp(`/${paypalOrderId}$`))).toHaveLength(1);
    expect((await getPayment(env.DB, orderId))?.state).toBe("awaiting_approval");
  });

  it("keeps the capture claim when the re-read also runs out of time", async () => {
    const { orderId } = await approvedOrder();
    fake.on("POST", /\/capture$/, hang);
    fake.on("GET", /^\/v2\/checkout\/orders\//, hang);

    const result = await capturePaypalPayment(env.DB, testPaypal({ budgetMs: 100, rereadBudgetMs: 100 }), orderId);

    expect(result).toEqual({ kind: "unknown" });
    expect((await getPayment(env.DB, orderId))?.state).toBe("capturing");
  });

  it("treats a connection failure on the token request as never sent: no re-read, amount released", async () => {
    const { orderId, paypalOrderId } = await paidOrder();
    fake.on("POST", /^\/v1\/oauth2\/token$/, () => {
      throw new TypeError("DNS lookup failed");
    });

    const result = await refundPaypalPayment(env.DB, testPaypal({ budgetMs: 5000, rereadBudgetMs: 5000 }), {
      orderId,
      refundKey: crypto.randomUUID(),
      amountCents: 500,
      requestedByUserId: 1,
    });

    expect(result).toMatchObject({ kind: "failed", failure: { kind: "not_sent", why: "unreachable" } });
    expect(fake.callsTo("POST", /\/refund$/)).toHaveLength(0);
    expect(fake.callsTo("GET", new RegExp(`/${paypalOrderId}$`))).toHaveLength(0);
    expect(await listRefunds(env.DB, orderId)).toMatchObject([{ state: "failed" }]);
  });

  it("a single 503 on Pay with PayPal is invisible: the SDK retries the same request and the buyer goes to PayPal", async () => {
    const { browser, orderId } = await customerWithOrder();
    const paypalOrderId = nextId("PPO");
    fake.on(
      "POST",
      /^\/v2\/checkout\/orders$/,
      () => json(503, { name: "SERVICE_UNAVAILABLE", message: "x" }),
      () => createdOrder(paypalOrderId),
    );

    const response = await browser.post(`/orders/${orderId}/pay`);

    expect(response.status).toBe(303);
    expect(response.headers.get("location")).toBe(`${APPROVAL_HOST}/checkoutnow?token=${paypalOrderId}`);
    const creates = fake.callsTo("POST", /^\/v2\/checkout\/orders$/);
    expect(creates).toHaveLength(2);
    // The SDK re-sent the very same request: same PayPal-Request-Id and same Idempotency-Key.
    expect(new Set(creates.map((c) => c.headers.get("paypal-request-id"))).size).toBe(1);
    expect(new Set(creates.map((c) => c.headers.get("idempotency-key"))).size).toBe(1);
  });

  it("a 503 that persists through the retry is reported, and the claim is kept for a replay", async () => {
    const { browser, orderId } = await customerWithOrder();
    fake.on("POST", /^\/v2\/checkout\/orders$/, () => json(503, { name: "SERVICE_UNAVAILABLE", message: "x" }));

    const response = await browser.post(`/orders/${orderId}/pay`);

    expect(response.status).toBe(502);
    expect(fake.callsTo("POST", /^\/v2\/checkout\/orders$/)).toHaveLength(2);
    expect((await getPayment(env.DB, orderId))?.state).toBe("creating");
  });

  it("a single 429 on Pay now is invisible: the capture is retried and the order is paid", async () => {
    const { browser, orderId, paypalOrderId } = await approvedOrder();
    const captureId = nextId("CAP");
    fake.on(
      "POST",
      /\/capture$/,
      () => paypalError(429, "RATE_LIMIT_REACHED", "Too many requests."),
      () => capturedOrder(paypalOrderId, { id: captureId, status: "COMPLETED", value: "22.50" }),
    );

    const response = await browser.post(`/orders/${orderId}/paypal/capture`);

    expect(response.headers.get("location")).toBe(`/orders/${orderId}?notice=paid`);
    expect(fake.callsTo("POST", /\/capture$/)).toHaveLength(2);
    expect((await getOrder(env.DB, orderId))?.status).toBe("paid");
  });

  it("retries an idempotent GET once on a 503", async () => {
    const { browser, orderId } = await customerWithOrder();
    const paypalOrderId = nextId("PPO");
    fake.on("POST", /^\/v2\/checkout\/orders$/, () => createdOrder(paypalOrderId));
    await browser.post(`/orders/${orderId}/pay`);
    fake.on(
      "GET",
      new RegExp(`^/v2/checkout/orders/${paypalOrderId}$`),
      () => json(503, { name: "SERVICE_UNAVAILABLE", message: "busy" }),
      () => createdOrder(paypalOrderId),
    );

    const again = await browser.post(`/orders/${orderId}/pay`);

    expect(fake.callsTo("GET", new RegExp(`/${paypalOrderId}$`))).toHaveLength(2);
    expect(again.headers.get("location")).toBe(`${APPROVAL_HOST}/checkoutnow?token=${paypalOrderId}`);
  });

  it("shows the reason from an error body outside PayPal's error schema (e.g. from the gateway)", async () => {
    const { browser, orderId } = await customerWithOrder();
    // 415 is not a declared createOrder status, and the body lacks debug_id, so it arrives as raw bytes.
    fake.on("POST", /^\/v2\/checkout\/orders$/, () =>
      json(415, { name: "UNSUPPORTED_MEDIA_TYPE", message: "Gateway refused this merchant request." }),
    );

    const response = await browser.post(`/orders/${orderId}/pay`);

    expect(response.status).toBe(415);
    expect(await response.text()).toContain("Gateway refused this merchant request.");
    expect(await getPayment(env.DB, orderId)).toBeNull();
  });

  it("logs PayPal's debug id from the response header when the error body is empty", async () => {
    const { browser, orderId, paypalOrderId } = await approvedOrder();
    const warnings: string[] = [];
    vi.spyOn(console, "warn").mockImplementation((line: unknown) => {
      warnings.push(String(line));
    });
    fake.on(
      "POST",
      /\/capture$/,
      () => new Response(null, { status: 500, headers: { "paypal-debug-id": "hdr-debug-1" } }),
    );
    fake.on("GET", new RegExp(`^/v2/checkout/orders/${paypalOrderId}$`), () =>
      json(200, { id: paypalOrderId, status: "APPROVED" }),
    );

    const response = await browser.post(`/orders/${orderId}/paypal/capture`);

    expect(response.headers.get("location")).toBe(`/orders/${orderId}?notice=confirming`);
    const line = warnings
      .filter((w) => w.startsWith("{"))
      .map((w) => JSON.parse(w))
      .find((w) => w.op === "capture_order");
    expect(line).toMatchObject({ event: "paypal", outcome: "server_error", status: 500, debugId: "hdr-debug-1" });
    expect(warnings.join("\n")).not.toContain("test-access-token");
  });
});
