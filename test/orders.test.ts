import { describe, expect, it } from "vitest";
import { Browser, checkoutKeyFrom, createTestUser, validAddress } from "./helpers";

async function customerWithOrder(): Promise<{ browser: Browser; orderId: number }> {
  const user = await createTestUser();
  const browser = new Browser();
  await browser.signIn(user.email);
  await browser.addToBasket(9, 3);
  const { html } = await browser.get("/checkout");
  const response = await browser.post("/checkout", { checkoutKey: checkoutKeyFrom(html), ...validAddress });
  const orderId = Number(/\/orders\/(\d+)/.exec(response.headers.get("location") ?? "")?.[1]);
  return { browser, orderId };
}

describe("orders", () => {
  it("requires sign-in for the order list and detail", async () => {
    const anon = new Browser();
    for (const path of ["/orders", "/orders/1"]) {
      const { response } = await anon.get(path);
      expect(response.status).toBe(303);
      expect(response.headers.get("location")).toBe(`/account/login?returnUrl=${encodeURIComponent(path)}`);
    }
  });

  it("shows the buyer's own order with the Pay with PayPal button", async () => {
    const { browser, orderId } = await customerWithOrder();
    const { response, html } = await browser.get(`/orders/${orderId}?placed=1`);
    expect(response.status).toBe(200);
    expect(html).toContain(`Order #${orderId}`);
    expect(html).toContain("Thank you! Your order has been placed.");
    expect(html).toContain('data-testid="payment-note"');
    expect(html).toContain(`action="/orders/${orderId}/pay"`);
    expect(html).toContain("Not paid");
    expect(html).toContain("Awaiting payment");
    expect(html).toContain("$22.50");
  });

  it("lists only the buyer's own orders", async () => {
    const a = await customerWithOrder();
    const b = await customerWithOrder();
    const { html } = await a.browser.get("/orders");
    expect(html).toContain(`href="/orders/${a.orderId}"`);
    expect(html).not.toContain(`href="/orders/${b.orderId}"`);
  });

  it("returns 404 for another buyer's order", async () => {
    const a = await customerWithOrder();
    const b = await customerWithOrder();
    const { response, html } = await a.browser.get(`/orders/${b.orderId}`);
    expect(response.status).toBe(404);
    expect(html).toContain("Page not found");
    expect(html).not.toContain(validAddress.line1);
  });

  it("returns 404 for unknown or malformed order ids", async () => {
    const { browser } = await customerWithOrder();
    expect((await browser.get("/orders/999999")).response.status).toBe(404);
    expect((await browser.get("/orders/abc")).response.status).toBe(404);
  });

  it("shows an empty state when there are no orders", async () => {
    const user = await createTestUser();
    const browser = new Browser();
    await browser.signIn(user.email);
    const { html } = await browser.get("/orders");
    expect(html).toContain("You haven&#39;t placed any orders yet.");
  });
});
