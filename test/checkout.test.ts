import { env } from "cloudflare:workers";
import { describe, expect, it } from "vitest";
import { getBasket, userBuyerId } from "../src/services/basket";
import { getOrder, placeOrder } from "../src/services/orders";
import { Browser, checkoutKeyFrom, createTestUser, validAddress } from "./helpers";

async function orderCount(userId: number): Promise<number> {
  const row = await env.DB.prepare("SELECT COUNT(*) AS n FROM orders WHERE buyer_user_id = ?1")
    .bind(userId)
    .first<{ n: number }>();
  return row?.n ?? 0;
}

async function signedInWithBasket(): Promise<{ browser: Browser; user: { email: string; id: number } }> {
  const user = await createTestUser();
  const browser = new Browser();
  await browser.signIn(user.email);
  await browser.addToBasket(3, 2); // 2 x $21.00
  await browser.addToBasket(16, 1); // $54.00
  return { browser, user };
}

describe("checkout", () => {
  it("requires sign-in", async () => {
    const browser = new Browser();
    await browser.addToBasket(1);
    const { response } = await browser.get("/checkout");
    expect(response.status).toBe(303);
    expect(response.headers.get("location")).toBe("/account/login?returnUrl=%2Fcheckout");
  });

  it("redirects to the basket when the basket is empty", async () => {
    const user = await createTestUser();
    const browser = new Browser();
    await browser.signIn(user.email);
    const { response } = await browser.get("/checkout");
    expect(response.headers.get("location")).toBe("/basket");
  });

  it("shows the order summary and a checkout key", async () => {
    const { browser } = await signedInWithBasket();
    const { response, html } = await browser.get("/checkout");
    expect(response.status).toBe(200);
    expect(html).toContain("$96.00");
    expect(checkoutKeyFrom(html)).toMatch(/^[0-9a-f-]{36}$/);
  });

  it("places an order: snapshots lines, totals in cents, awaiting payment, empties the basket", async () => {
    const { browser, user } = await signedInWithBasket();
    // Simulate a price captured earlier than the current catalog price.
    await env.DB.prepare(
      `UPDATE basket_items SET unit_price_cents = 2000
       WHERE catalog_item_id = 3 AND basket_id = (SELECT id FROM baskets WHERE buyer_id = ?1)`,
    )
      .bind(userBuyerId(user.id))
      .run();

    const { html } = await browser.get("/checkout");
    const response = await browser.post("/checkout", { checkoutKey: checkoutKeyFrom(html), ...validAddress });
    expect(response.status).toBe(303);
    const location = response.headers.get("location") ?? "";
    expect(location).toMatch(/^\/orders\/\d+\?placed=1$/);
    const orderId = Number(/\/orders\/(\d+)/.exec(location)?.[1]);

    const order = await getOrder(env.DB, orderId);
    expect(order).toMatchObject({
      buyerUserId: user.id,
      status: "awaiting_payment",
      currency: "USD",
      totalCents: 2 * 2000 + 5400,
      shipTo: validAddress,
    });
    expect(order?.lines).toEqual([
      {
        catalogItemId: 3,
        productName: "Ethiopia Yirgacheffe Whole Bean, 12 oz",
        pictureUri: "/images/products/ethiopia-yirgacheffe-whole-bean.svg",
        unitPriceCents: 2000,
        quantity: 2,
        lineTotalCents: 4000,
      },
      {
        catalogItemId: 16,
        productName: "Gooseneck Kettle, 1 L",
        pictureUri: "/images/products/gooseneck-kettle.svg",
        unitPriceCents: 5400,
        quantity: 1,
        lineTotalCents: 5400,
      },
    ]);
    expect((await getBasket(env.DB, userBuyerId(user.id))).lines).toHaveLength(0);

    // The snapshot does not change when the catalog does.
    await env.DB.prepare("UPDATE catalog_items SET name = 'Renamed', price_cents = 1 WHERE id = 16").run();
    try {
      const after = await getOrder(env.DB, orderId);
      expect(after?.lines[1]).toMatchObject({ productName: "Gooseneck Kettle, 1 L", unitPriceCents: 5400 });
      expect(after?.totalCents).toBe(9400);
    } finally {
      await env.DB.prepare(
        "UPDATE catalog_items SET name = 'Gooseneck Kettle, 1 L', price_cents = 5400 WHERE id = 16",
      ).run();
    }
  });

  it("does not create a second order when the same form is submitted twice", async () => {
    const { browser, user } = await signedInWithBasket();
    const { html } = await browser.get("/checkout");
    const fields = { checkoutKey: checkoutKeyFrom(html), ...validAddress };

    const first = await browser.post("/checkout", fields);
    const second = await browser.post("/checkout", fields);
    expect(first.status).toBe(303);
    expect(second.status).toBe(303);
    const firstId = /\/orders\/(\d+)/.exec(first.headers.get("location") ?? "")?.[1];
    expect(second.headers.get("location")).toBe(`/orders/${firstId}`);
    expect(await orderCount(user.id)).toBe(1);
  });

  it("is idempotent under concurrent submissions with the same key", async () => {
    const { user } = await signedInWithBasket();
    const key = crypto.randomUUID();
    const input = { userId: user.id, checkoutKey: key, shipTo: validAddress };
    const results = await Promise.all([placeOrder(env.DB, input), placeOrder(env.DB, input)]);
    const ids = results.map((r) => (r.ok ? r.orderId : null));
    expect(ids[0]).not.toBeNull();
    expect(ids[0]).toBe(ids[1]);
    expect(results.filter((r) => r.ok && r.created)).toHaveLength(1);
    expect(await orderCount(user.id)).toBe(1);
  });

  it("a new checkout key after an order with an empty basket does not create an order", async () => {
    const { browser, user } = await signedInWithBasket();
    const { html } = await browser.get("/checkout");
    await browser.post("/checkout", { checkoutKey: checkoutKeyFrom(html), ...validAddress });
    const response = await browser.post("/checkout", { checkoutKey: crypto.randomUUID(), ...validAddress });
    expect(response.headers.get("location")).toBe("/basket");
    expect(await orderCount(user.id)).toBe(1);
  });

  it("validates the shipping address and keeps the basket", async () => {
    const { browser, user } = await signedInWithBasket();
    const { html } = await browser.get("/checkout");
    const response = await browser.post("/checkout", {
      checkoutKey: checkoutKeyFrom(html),
      ...validAddress,
      name: " ",
      postalCode: "!!",
      country: "ZZ",
    });
    expect(response.status).toBe(200);
    const page = await response.text();
    expect(page).toContain("Enter the recipient&#39;s full name.");
    expect(page).toContain("Enter a valid postal code.");
    expect(page).toContain("Choose a country.");
    expect(page).toContain('aria-invalid="true"');
    expect(await orderCount(user.id)).toBe(0);
    expect((await getBasket(env.DB, userBuyerId(user.id))).lines).toHaveLength(2);
  });

  it("rejects a missing or malformed checkout key", async () => {
    const { browser, user } = await signedInWithBasket();
    const response = await browser.post("/checkout", { checkoutKey: "not-a-uuid", ...validAddress });
    expect(response.headers.get("location")).toBe("/checkout");
    expect(await orderCount(user.id)).toBe(0);
  });
});
