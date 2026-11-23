import { env } from "cloudflare:workers";
import { describe, expect, it } from "vitest";
import { getOrder } from "../src/services/orders";
import { Browser, checkoutKeyFrom, createTestUser, validAddress } from "./helpers";

async function placeOrderAsNewCustomer(): Promise<{ email: string; orderId: number; browser: Browser }> {
  const user = await createTestUser();
  const browser = new Browser();
  await browser.signIn(user.email);
  await browser.addToBasket(14);
  const { html } = await browser.get("/checkout");
  const response = await browser.post("/checkout", { checkoutKey: checkoutKeyFrom(html), ...validAddress });
  const orderId = Number(/\/orders\/(\d+)/.exec(response.headers.get("location") ?? "")?.[1]);
  return { email: user.email, orderId, browser };
}

async function adminBrowser(): Promise<Browser> {
  const admin = await createTestUser("admin");
  const browser = new Browser();
  await browser.signIn(admin.email);
  return browser;
}

describe("admin authorization", () => {
  it("redirects anonymous visitors to sign in", async () => {
    const { response } = await new Browser().get("/admin/orders");
    expect(response.status).toBe(303);
    expect(response.headers.get("location")).toBe("/account/login?returnUrl=%2Fadmin%2Forders");
  });

  it("forbids customers from every admin page and action", async () => {
    const { browser, orderId } = await placeOrderAsNewCustomer();
    for (const path of ["/admin", "/admin/orders", `/admin/orders/${orderId}`, "/admin/catalog"]) {
      const { response } = await browser.get(path);
      expect(response.status, path).toBe(403);
    }
    await browser.get("/");
    const cancel = await browser.post(`/admin/orders/${orderId}/cancel`);
    expect(cancel.status).toBe(403);
    expect((await getOrder(env.DB, orderId))?.status).toBe("awaiting_payment");
  });

  it("hides the Admin link from customers and shows it to admins", async () => {
    const { browser } = await placeOrderAsNewCustomer();
    expect((await browser.get("/")).html).not.toContain('href="/admin"');
    const admin = await adminBrowser();
    expect((await admin.get("/")).html).toContain('href="/admin"');
  });
});

describe("admin orders", () => {
  it("lists all buyers' orders, newest first", async () => {
    const first = await placeOrderAsNewCustomer();
    const second = await placeOrderAsNewCustomer();
    const admin = await adminBrowser();
    const { response, html } = await admin.get("/admin/orders");
    expect(response.status).toBe(200);
    expect(html).toContain(first.email);
    expect(html).toContain(second.email);
    expect(html.indexOf(`/admin/orders/${second.orderId}"`)).toBeLessThan(
      html.indexOf(`/admin/orders/${first.orderId}"`),
    );
  });

  it("filters by status", async () => {
    const kept = await placeOrderAsNewCustomer();
    const cancelled = await placeOrderAsNewCustomer();
    const admin = await adminBrowser();
    await admin.get(`/admin/orders/${cancelled.orderId}`);
    await admin.post(`/admin/orders/${cancelled.orderId}/cancel`);

    const awaiting = (await admin.get("/admin/orders?status=awaiting_payment")).html;
    expect(awaiting).toContain(`/admin/orders/${kept.orderId}"`);
    expect(awaiting).not.toContain(`/admin/orders/${cancelled.orderId}"`);

    const onlyCancelled = (await admin.get("/admin/orders?status=cancelled")).html;
    expect(onlyCancelled).toContain(`/admin/orders/${cancelled.orderId}"`);
    expect(onlyCancelled).not.toContain(`/admin/orders/${kept.orderId}"`);

    // Unknown statuses are ignored (all orders shown).
    const all = (await admin.get("/admin/orders?status=bogus")).html;
    expect(all).toContain(`/admin/orders/${kept.orderId}"`);
    expect(all).toContain(`/admin/orders/${cancelled.orderId}"`);
  });

  it("cancels an order awaiting payment, only once", async () => {
    const { orderId, browser: customer } = await placeOrderAsNewCustomer();
    const admin = await adminBrowser();
    const detail = await admin.get(`/admin/orders/${orderId}`);
    expect(detail.html).toContain("Cancel order");

    const response = await admin.post(`/admin/orders/${orderId}/cancel`);
    expect(response.status).toBe(303);
    expect(response.headers.get("location")).toBe(`/admin/orders/${orderId}?notice=cancelled`);
    expect((await getOrder(env.DB, orderId))?.status).toBe("cancelled");

    const after = await admin.get(`/admin/orders/${orderId}?notice=cancelled`);
    expect(after.html).toContain("The order was cancelled.");
    expect(after.html).not.toContain("Cancel order");

    const again = await admin.post(`/admin/orders/${orderId}/cancel`);
    expect(again.headers.get("location")).toBe(`/admin/orders/${orderId}?notice=not_cancellable`);

    // The buyer sees the new status and no payment note.
    const buyerView = await customer.get(`/orders/${orderId}`);
    expect(buyerView.html).toContain("Cancelled");
    expect(buyerView.html).not.toContain('data-testid="payment-note"');
  });

  it("returns 404 for unknown orders", async () => {
    const admin = await adminBrowser();
    expect((await admin.get("/admin/orders/999999")).response.status).toBe(404);
    expect((await admin.post("/admin/orders/999999/cancel")).status).toBe(404);
  });

  it("shows the read-only catalog", async () => {
    const admin = await adminBrowser();
    const { response, html } = await admin.get("/admin/catalog");
    expect(response.status).toBe(200);
    expect(html).toContain("16 products");
    expect(html).toContain("Conical Burr Grinder");
    expect(html).not.toMatch(/<form[^>]*method="post"[^>]*action="\/admin\/catalog/);
  });
});
