import { env } from "cloudflare:workers";
import { describe, expect, it } from "vitest";
import { listPaymentsForOrder, listRefundsForOrder } from "../src/db/payments";
import { getOrder } from "../src/services/orders";
import { type FakePayPal, installFakePayPal } from "./fake-paypal";
import { Browser, checkoutKeyFrom, createTestUser, validAddress } from "./helpers";

/** A signed-in customer with a new $22.50 order (3 x $7.50). */
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

async function adminBrowser(): Promise<Browser> {
  const admin = await createTestUser("admin");
  const browser = new Browser();
  await browser.signIn(admin.email);
  return browser;
}

/** Clicks "Pay with PayPal"; returns the PayPal order id from the approval redirect. */
async function startPayment(browser: Browser, orderId: number): Promise<string> {
  const response = await browser.post(`/orders/${orderId}/pay`);
  expect(response.status).toBe(303);
  const location = new URL(response.headers.get("location") ?? "");
  expect(location.origin).toBe("https://www.sandbox.paypal.com");
  const token = location.searchParams.get("token");
  if (!token) throw new Error("no token in approval link");
  return token;
}

/** The buyer comes back from PayPal; returns the `payment` outcome from the redirect. */
async function returnFromPayPal(browser: Browser, orderId: number, token: string): Promise<string | null> {
  const { response } = await browser.get(`/orders/${orderId}/paypal/return?token=${token}&PayerID=FAKEPAYER1`);
  expect(response.status).toBe(303);
  const location = new URL(response.headers.get("location") ?? "", "https://northwind.test");
  expect(location.pathname).toBe(`/orders/${orderId}`);
  return location.searchParams.get("payment");
}

async function paidOrder(paypal: FakePayPal): Promise<{ browser: Browser; orderId: number }> {
  const { browser, orderId } = await customerWithOrder();
  const token = await startPayment(browser, orderId);
  paypal.approve(token);
  expect(await returnFromPayPal(browser, orderId, token)).toBe("paid");
  return { browser, orderId };
}

async function orderStatus(orderId: number): Promise<string | undefined> {
  return (await getOrder(env.DB, orderId))?.status;
}

async function refundForm(admin: Browser, orderId: number): Promise<string> {
  const { html } = await admin.get(`/admin/orders/${orderId}`);
  const key = /name="refundKey" value="([^"]+)"/.exec(html)?.[1];
  if (!key) throw new Error("refund form not found");
  return key;
}

describe("PayPal checkout", () => {
  it("creates a PayPal order through the gateway and redirects the buyer to approve it", async () => {
    const paypal = installFakePayPal();
    const { browser, orderId } = await customerWithOrder();
    const token = await startPayment(browser, orderId);

    const [create] = paypal.calls("POST", /^\/v2\/checkout\/orders$/);
    expect(create?.requestId).toMatch(/^[0-9a-f-]{36}$/);
    const body = create?.body as {
      purchase_units: { amount: unknown }[];
      payment_source: { paypal: { experience_context: Record<string, string> } };
    };
    expect(body.purchase_units[0]?.amount).toEqual({ currency_code: "USD", value: "22.50" });
    const context = body.payment_source.paypal.experience_context;
    expect(context.return_url).toBe(`https://northwind.test/orders/${orderId}/paypal/return`);
    expect(context.cancel_url).toBe(`https://northwind.test/orders/${orderId}/paypal/cancel`);
    expect(context.user_action).toBe("PAY_NOW");
    // Every call went to the egress gateway (the fake fails on any other host).
    expect(paypal.requests.every((r) => r.path.startsWith("/v"))).toBe(true);

    const payments = await listPaymentsForOrder(env.DB, orderId);
    expect(payments.map((p) => [p.provider_order_id, p.status, p.amount_cents])).toEqual([[token, "created", 2250]]);
    // Approving isn't paying.
    expect(await orderStatus(orderId)).toBe("awaiting_payment");
  });

  it("marks the order paid only after PayPal captures the payment", async () => {
    const paypal = installFakePayPal();
    const { browser, orderId } = await customerWithOrder();
    const token = await startPayment(browser, orderId);
    paypal.approve(token);

    expect(await returnFromPayPal(browser, orderId, token)).toBe("paid");
    expect(await orderStatus(orderId)).toBe("paid");
    expect(paypal.captures.size).toBe(1);

    const { html } = await browser.get(`/orders/${orderId}?payment=paid`);
    expect(html).toContain("Thank you! PayPal has confirmed your payment.");
    expect(html).toContain("Paid with PayPal");
    expect(html).not.toContain(`action="/orders/${orderId}/pay"`);
    expect((await browser.get("/orders")).html).toMatch(/status-paid">Paid</);
  });

  it("does not capture twice when the buyer refreshes the return page", async () => {
    const paypal = installFakePayPal();
    const { browser, orderId } = await paidOrder(paypal);
    const token = paypal.lastOrderId;
    expect(await returnFromPayPal(browser, orderId, token)).toBe("paid");
    expect(paypal.calls("POST", /\/capture$/)).toHaveLength(1);
  });

  it("does not mark the order paid when the buyer returns without approving", async () => {
    const paypal = installFakePayPal();
    const { browser, orderId } = await customerWithOrder();
    const token = await startPayment(browser, orderId);

    expect(await returnFromPayPal(browser, orderId, token)).toBe("not_approved");
    expect(await orderStatus(orderId)).toBe("awaiting_payment");
    // The attempt is released, so approving and returning later still works.
    paypal.approve(token);
    expect(await returnFromPayPal(browser, orderId, token)).toBe("paid");
  });

  it("keeps the order unpaid while PayPal's capture is pending, then admin can sync it", async () => {
    const paypal = installFakePayPal();
    paypal.captureStatus = "PENDING";
    const { browser, orderId } = await customerWithOrder();
    const token = await startPayment(browser, orderId);
    paypal.approve(token);

    expect(await returnFromPayPal(browser, orderId, token)).toBe("pending");
    expect(await orderStatus(orderId)).toBe("awaiting_payment");
    const page = await browser.get(`/orders/${orderId}`);
    expect(page.html).toContain("Processing at PayPal");
    expect(page.html).not.toContain(`action="/orders/${orderId}/pay"`);

    const admin = await adminBrowser();
    const detail = await admin.get(`/admin/orders/${orderId}`);
    expect(detail.html).toContain("Check with PayPal");
    expect(detail.html).not.toContain("Cancel order");
    // Still pending at PayPal: nothing changes.
    let sync = await admin.post(`/admin/orders/${orderId}/payment-sync`);
    expect(sync.headers.get("location")).toBe(`/admin/orders/${orderId}?notice=sync_unchanged`);

    paypal.settle("COMPLETED");
    sync = await admin.post(`/admin/orders/${orderId}/payment-sync`);
    expect(sync.headers.get("location")).toBe(`/admin/orders/${orderId}?notice=synced`);
    expect(await orderStatus(orderId)).toBe("paid");
  });

  it("records a declined capture and lets the buyer try again", async () => {
    const paypal = installFakePayPal();
    const { browser, orderId } = await customerWithOrder();
    const first = await startPayment(browser, orderId);
    paypal.approve(first);
    paypal.declineNextCapture = true;

    expect(await returnFromPayPal(browser, orderId, first)).toBe("declined");
    expect(await orderStatus(orderId)).toBe("awaiting_payment");
    const page = await browser.get(`/orders/${orderId}?payment=declined`);
    expect(page.html).toContain("Payment declined");
    expect(page.html).toContain("Not paid (last attempt declined)");

    const second = await startPayment(browser, orderId);
    expect(second).not.toBe(first);
    paypal.approve(second);
    expect(await returnFromPayPal(browser, orderId, second)).toBe("paid");
  });

  it("sends a JSON content type on every POST to PayPal, including the bodyless capture", async () => {
    const paypal = installFakePayPal();
    await paidOrder(paypal);
    const posts = paypal.requests.filter((r) => r.method === "POST" && r.path.startsWith("/v2/"));
    expect(posts.map((r) => r.path)).toEqual([expect.stringMatching(/orders$/), expect.stringMatching(/capture$/)]);
    for (const post of posts) expect(post.contentType, post.path).toBe("application/json");
  });

  for (const rejection of [
    { status: 415, name: "UNSUPPORTED_MEDIA_TYPE" },
    { status: 400, name: "INVALID_REQUEST" },
  ]) {
    it(`doesn't call a capture PayPal rejected with ${rejection.status} a decline, and lets it be retried`, async () => {
      const paypal = installFakePayPal();
      const { browser, orderId } = await customerWithOrder();
      const token = await startPayment(browser, orderId);
      paypal.approve(token);
      paypal.rejectNextCaptureWith = rejection;

      expect(await returnFromPayPal(browser, orderId, token)).toBe("not_captured");
      expect(await orderStatus(orderId)).toBe("awaiting_payment");
      const [payment] = await listPaymentsForOrder(env.DB, orderId);
      expect(payment?.status).toBe("created");
      const page = await browser.get(`/orders/${orderId}?payment=not_captured`);
      expect(page.html).toContain("Payment not taken");
      expect(page.html).not.toContain("Payment declined");
      expect(page.html).not.toContain("last attempt declined");

      // The buyer's existing approval is captured on retry, with a fresh idempotency key.
      expect(await returnFromPayPal(browser, orderId, token)).toBe("paid");
      const captureCalls = paypal.calls("POST", /\/capture$/);
      expect(captureCalls).toHaveLength(2);
      expect(captureCalls[1]?.requestId).not.toBe(captureCalls[0]?.requestId);
      expect(paypal.captures.size).toBe(1);
    });
  }

  it("retries a capture whose response was lost with the same idempotency key, capturing once", async () => {
    const paypal = installFakePayPal();
    const { browser, orderId } = await customerWithOrder();
    const token = await startPayment(browser, orderId);
    paypal.approve(token);
    paypal.loseNextResponseFor = "capture";

    expect(await returnFromPayPal(browser, orderId, token)).toBe("error");
    expect(await orderStatus(orderId)).toBe("awaiting_payment");
    const page = await browser.get(`/orders/${orderId}?payment=error`);
    expect(page.html).toContain("Check payment status");
    expect(page.html).not.toContain(`action="/orders/${orderId}/pay"`);

    // An admin can't cancel while the capture's outcome is unknown.
    const admin = await adminBrowser();
    await admin.get(`/admin/orders/${orderId}`);
    const cancel = await admin.post(`/admin/orders/${orderId}/cancel`);
    expect(cancel.headers.get("location")).toBe(`/admin/orders/${orderId}?notice=not_cancellable`);

    expect(await returnFromPayPal(browser, orderId, token)).toBe("paid");
    const captureCalls = paypal.calls("POST", /\/capture$/);
    expect(captureCalls).toHaveLength(2);
    expect(captureCalls[1]?.requestId).toBe(captureCalls[0]?.requestId);
    expect(paypal.captures.size).toBe(1);
    expect(await orderStatus(orderId)).toBe("paid");
  });

  it("never marks the order paid if the captured amount doesn't match the order total", async () => {
    const paypal = installFakePayPal();
    paypal.captureValueOverride = "1.00";
    const { browser, orderId } = await customerWithOrder();
    const token = await startPayment(browser, orderId);
    paypal.approve(token);
    expect(await returnFromPayPal(browser, orderId, token)).toBe("error");
    expect(await orderStatus(orderId)).toBe("awaiting_payment");
    expect(await returnFromPayPal(browser, orderId, token)).toBe("error");
  });

  it("does not capture if the order was cancelled while the buyer was on PayPal", async () => {
    const paypal = installFakePayPal();
    const { browser, orderId } = await customerWithOrder();
    const token = await startPayment(browser, orderId);
    paypal.approve(token);

    const admin = await adminBrowser();
    await admin.get(`/admin/orders/${orderId}`);
    await admin.post(`/admin/orders/${orderId}/cancel`);
    expect(await orderStatus(orderId)).toBe("cancelled");

    expect(await returnFromPayPal(browser, orderId, token)).toBe("not_payable");
    expect(paypal.calls("POST", /\/capture$/)).toHaveLength(0);
    expect(await orderStatus(orderId)).toBe("cancelled");
  });

  it("handles the buyer cancelling on PayPal", async () => {
    const paypal = installFakePayPal();
    const { browser, orderId } = await customerWithOrder();
    const token = await startPayment(browser, orderId);
    const { response } = await browser.get(`/orders/${orderId}/paypal/cancel?token=${token}`);
    expect(response.headers.get("location")).toBe(`/orders/${orderId}?payment=cancelled`);
    expect((await listPaymentsForOrder(env.DB, orderId))[0]?.status).toBe("voided");
    const page = await browser.get(`/orders/${orderId}?payment=cancelled`);
    expect(page.html).toContain("You cancelled on PayPal, so you haven&#39;t been charged.");
    expect(page.html).toContain(`action="/orders/${orderId}/pay"`);
    expect(paypal.calls("POST", /\/capture$/)).toHaveLength(0);
  });

  it("rejects unknown tokens and tokens from another order", async () => {
    const paypal = installFakePayPal();
    const a = await customerWithOrder();
    const b = await customerWithOrder();
    const tokenB = await startPayment(b.browser, b.orderId);
    paypal.approve(tokenB);

    expect(await returnFromPayPal(a.browser, a.orderId, "NOTAREALTOKEN123")).toBe("unknown");
    expect(await returnFromPayPal(a.browser, a.orderId, tokenB)).toBe("unknown");
    expect(await returnFromPayPal(a.browser, a.orderId, "bad<token>")).toBe("unknown");
    expect(paypal.calls("POST", /\/capture$/)).toHaveLength(0);
    expect(await orderStatus(b.orderId)).toBe("awaiting_payment");
  });

  it("returns 404 for another buyer's order on every payment route", async () => {
    installFakePayPal();
    const a = await customerWithOrder();
    const b = await customerWithOrder();
    expect((await a.browser.post(`/orders/${b.orderId}/pay`)).status).toBe(404);
    expect((await a.browser.get(`/orders/${b.orderId}/paypal/return?token=ABCDEFGH12345`)).response.status).toBe(404);
    expect((await a.browser.get(`/orders/${b.orderId}/paypal/cancel?token=ABCDEFGH12345`)).response.status).toBe(404);
  });

  it("requires sign-in and a CSRF token to start a payment", async () => {
    const paypal = installFakePayPal();
    const { browser, orderId } = await customerWithOrder();
    const forged = await browser.post(`/orders/${orderId}/pay`, { _csrf: "forged" });
    expect(forged.status).toBe(403);
    const anon = new Browser();
    await anon.get("/");
    const response = await anon.post(`/orders/${orderId}/pay`);
    expect(response.status).toBe(303);
    expect(response.headers.get("location")).toMatch(/^\/account\/login/);
    expect(paypal.requests).toHaveLength(0);
  });

  it("doesn't start a payment for an order that is already paid or cancelled", async () => {
    const paypal = installFakePayPal();
    const { browser, orderId } = await paidOrder(paypal);
    const response = await browser.post(`/orders/${orderId}/pay`);
    expect(response.headers.get("location")).toBe(`/orders/${orderId}?payment=not_payable`);
    expect(paypal.calls("POST", /^\/v2\/checkout\/orders$/)).toHaveLength(1);
  });

  it("shows a friendly error when PayPal is unavailable", async () => {
    const paypal = installFakePayPal();
    paypal.failNextCreate = true;
    const { browser, orderId } = await customerWithOrder();
    const response = await browser.post(`/orders/${orderId}/pay`);
    expect(response.headers.get("location")).toBe(`/orders/${orderId}?payment=provider_error`);
    expect(await listPaymentsForOrder(env.DB, orderId)).toHaveLength(0);
    const page = await browser.get(`/orders/${orderId}?payment=provider_error`);
    expect(page.html).toContain("We couldn&#39;t connect to PayPal.");
  });

  it("ignores unknown payment notices", async () => {
    installFakePayPal();
    const { browser, orderId } = await customerWithOrder();
    const page = await browser.get(`/orders/${orderId}?payment=%3Cscript%3E`);
    expect(page.response.status).toBe(200);
    expect(page.html).not.toContain('data-testid="payment-notice"');
  });
});

describe("admin payment status and refunds", () => {
  it("shows payment details and prevents cancelling a paid order", async () => {
    const paypal = installFakePayPal();
    const { orderId } = await paidOrder(paypal);
    const admin = await adminBrowser();
    const { html } = await admin.get(`/admin/orders/${orderId}`);
    expect(html).toContain("Paid with PayPal");
    expect(html).toContain([...paypal.captures.keys()][0]);
    expect(html).not.toContain("Cancel order");
    expect(html).toMatch(/name="amount"[^>]*value="22.50"/);

    const cancel = await admin.post(`/admin/orders/${orderId}/cancel`);
    expect(cancel.headers.get("location")).toBe(`/admin/orders/${orderId}?notice=not_cancellable`);
    expect(await orderStatus(orderId)).toBe("paid");

    const list = await admin.get("/admin/orders?status=paid");
    expect(list.html).toContain(`/admin/orders/${orderId}"`);
  });

  it("refunds part, then the rest, of a paid order", async () => {
    const paypal = installFakePayPal();
    const { browser: customer, orderId } = await paidOrder(paypal);
    const admin = await adminBrowser();

    let key = await refundForm(admin, orderId);
    let response = await admin.post(`/admin/orders/${orderId}/refund`, {
      refundKey: key,
      amount: "5.00",
      note: "Damaged bag",
    });
    expect(response.status).toBe(303);
    expect(response.headers.get("location")).toBe(`/admin/orders/${orderId}?notice=refunded`);
    expect(await orderStatus(orderId)).toBe("partially_refunded");

    const [refundCall] = paypal.calls("POST", /\/refund$/);
    expect(refundCall?.requestId).toBe(key);
    expect(refundCall?.body).toEqual({ amount: { currency_code: "USD", value: "5.00" }, note_to_payer: "Damaged bag" });

    let page = await admin.get(`/admin/orders/${orderId}?notice=refunded`);
    expect(page.html).toContain("Partially refunded ($5.00 of $22.50)");
    expect(page.html).toMatch(/data-testid="payment-refundable">\$17.50/);
    expect(page.html).toMatch(/name="amount"[^>]*value="17.50"/);
    expect(page.html).toContain("Damaged bag");

    const buyerView = await customer.get(`/orders/${orderId}`);
    expect(buyerView.html).toContain("Partially refunded ($5.00 of $22.50)");

    key = await refundForm(admin, orderId);
    response = await admin.post(`/admin/orders/${orderId}/refund`, { refundKey: key, amount: "17.50" });
    expect(response.headers.get("location")).toBe(`/admin/orders/${orderId}?notice=refunded`);
    expect(await orderStatus(orderId)).toBe("refunded");

    page = await admin.get(`/admin/orders/${orderId}`);
    expect(page.html).toContain("Refunded in full ($22.50)");
    expect(page.html).not.toContain('name="refundKey"');
    expect(page.html.match(/data-testid="refund-row"/g)).toHaveLength(2);
  });

  it("validates the refund amount without calling PayPal", async () => {
    const paypal = installFakePayPal();
    const { orderId } = await paidOrder(paypal);
    const admin = await adminBrowser();
    const key = await refundForm(admin, orderId);

    for (const [amount, message] of [
      ["", "Enter the amount to refund."],
      ["abc", "Enter an amount greater than zero, like 12.50."],
      ["0", "Enter an amount greater than zero, like 12.50."],
      ["1.234", "Enter an amount greater than zero, like 12.50."],
      ["-5", "Enter an amount greater than zero, like 12.50."],
      ["22.51", "Enter at most $22.50, the amount not yet refunded."],
    ] as const) {
      const response = await admin.post(`/admin/orders/${orderId}/refund`, { refundKey: key, amount });
      expect(response.status, amount).toBe(200);
      expect(await response.text(), amount).toContain(message);
    }
    expect(paypal.calls("POST", /\/refund$/)).toHaveLength(0);
    expect(await orderStatus(orderId)).toBe("paid");
  });

  it("never refunds twice when the same refund form is submitted again", async () => {
    const paypal = installFakePayPal();
    const { orderId } = await paidOrder(paypal);
    const admin = await adminBrowser();
    const key = await refundForm(admin, orderId);
    await admin.post(`/admin/orders/${orderId}/refund`, { refundKey: key, amount: "10.00" });
    const again = await admin.post(`/admin/orders/${orderId}/refund`, { refundKey: key, amount: "10.00" });
    expect(again.headers.get("location")).toBe(`/admin/orders/${orderId}?notice=refunded`);
    expect(paypal.refunds.size).toBe(1);
    expect(await listRefundsForOrder(env.DB, orderId)).toHaveLength(1);
  });

  it("retries a refund whose response was lost with the same key, refunding once", async () => {
    const paypal = installFakePayPal();
    const { orderId } = await paidOrder(paypal);
    const admin = await adminBrowser();
    const key = await refundForm(admin, orderId);
    paypal.loseNextResponseFor = "refund";

    const first = await admin.post(`/admin/orders/${orderId}/refund`, { refundKey: key, amount: "22.50" });
    expect(first.status).toBe(200);
    const html = await first.text();
    expect(html).toContain("We couldn&#39;t confirm the refund with PayPal.");
    expect(await orderStatus(orderId)).toBe("paid");
    // The unconfirmed refund still reserves the amount: no second refund can be started.
    const page = await admin.get(`/admin/orders/${orderId}`);
    expect(page.html).not.toContain('name="refundKey"');
    expect(page.html).toContain("Check with PayPal");

    const retry = await admin.post(`/admin/orders/${orderId}/payment-sync`);
    expect(retry.headers.get("location")).toBe(`/admin/orders/${orderId}?notice=synced`);
    expect(paypal.refunds.size).toBe(1);
    expect(paypal.calls("POST", /\/refund$/).map((c) => c.requestId)).toEqual([key, key]);
    expect(await orderStatus(orderId)).toBe("refunded");
  });

  it("reports a refund PayPal refuses and keeps the amount refundable", async () => {
    const paypal = installFakePayPal();
    const { orderId } = await paidOrder(paypal);
    const admin = await adminBrowser();
    const key = await refundForm(admin, orderId);
    paypal.refuseNextRefund = "REFUND_NOT_ALLOWED";

    const response = await admin.post(`/admin/orders/${orderId}/refund`, { refundKey: key, amount: "5.00" });
    expect(response.status).toBe(200);
    const html = await response.text();
    expect(html).toContain("PayPal refused the refund (REFUND_NOT_ALLOWED). No money was returned.");
    expect(html).not.toContain(`name="refundKey" value="${key}"`);
    expect(await orderStatus(orderId)).toBe("paid");
    expect((await admin.get(`/admin/orders/${orderId}`)).html).toMatch(/data-testid="payment-refundable">\$22.50/);
  });

  it("tracks a pending refund until PayPal completes it", async () => {
    const paypal = installFakePayPal();
    paypal.refundStatus = "PENDING";
    const { orderId } = await paidOrder(paypal);
    const admin = await adminBrowser();
    const key = await refundForm(admin, orderId);

    const response = await admin.post(`/admin/orders/${orderId}/refund`, { refundKey: key, amount: "22.50" });
    expect(response.headers.get("location")).toBe(`/admin/orders/${orderId}?notice=refund_pending`);
    expect(await orderStatus(orderId)).toBe("paid");

    paypal.settle();
    await admin.post(`/admin/orders/${orderId}/payment-sync`);
    expect(await orderStatus(orderId)).toBe("refunded");
  });

  it("forbids customers from refunding or syncing", async () => {
    const paypal = installFakePayPal();
    const { browser, orderId } = await paidOrder(paypal);
    const refund = await browser.post(`/admin/orders/${orderId}/refund`, {
      refundKey: crypto.randomUUID(),
      amount: "22.50",
    });
    expect(refund.status).toBe(403);
    expect((await browser.post(`/admin/orders/${orderId}/payment-sync`)).status).toBe(403);
    expect(paypal.calls("POST", /\/refund$/)).toHaveLength(0);
    expect(await orderStatus(orderId)).toBe("paid");
  });

  it("rejects refunds for unpaid or unknown orders", async () => {
    const paypal = installFakePayPal();
    const { orderId } = await customerWithOrder();
    const admin = await adminBrowser();
    const page = await admin.get(`/admin/orders/${orderId}`);
    expect(page.html).not.toContain('name="refundKey"');
    const response = await admin.post(`/admin/orders/${orderId}/refund`, {
      refundKey: crypto.randomUUID(),
      amount: "1.00",
    });
    expect(response.headers.get("location")).toBe(`/admin/orders/${orderId}?notice=not_refundable`);
    const unknown = await admin.post("/admin/orders/999999/refund", { refundKey: crypto.randomUUID(), amount: "1.00" });
    expect(unknown.status).toBe(404);
    expect(paypal.calls("POST", /\/refund$/)).toHaveLength(0);
  });
});
