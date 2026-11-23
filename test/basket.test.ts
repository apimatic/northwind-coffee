import { env } from "cloudflare:workers";
import { describe, expect, it } from "vitest";
import { anonBuyerId, getBasket, parseQuantities, userBuyerId } from "../src/services/basket";
import { Browser, createTestUser } from "./helpers";

function anonId(browser: Browser): string {
  const id = browser.cookies.get("nw_anon");
  if (!id) throw new Error("no anonymous cookie");
  return id;
}

async function lineIds(buyerId: string): Promise<number[]> {
  return (await getBasket(env.DB, buyerId)).lines.map((line) => line.id);
}

describe("basket", () => {
  it("gives an anonymous visitor a basket cookie", async () => {
    const browser = new Browser();
    const { response } = await browser.get("/basket");
    const setCookie = response.headers.get("set-cookie") ?? "";
    expect(setCookie).toMatch(/nw_anon=[0-9a-f-]{36}/);
    expect(setCookie).toMatch(/HttpOnly/);
    expect(setCookie).toMatch(/Secure/);
    expect(setCookie).toMatch(/SameSite=Lax/);
  });

  it("adds items, capturing the unit price, and shows totals", async () => {
    const browser = new Browser();
    await browser.addToBasket(1); // $16.00
    await browser.addToBasket(2, 2); // 2 x $19.50
    const basket = await getBasket(env.DB, anonBuyerId(anonId(browser)));
    expect(basket.lines.map((l) => [l.catalogItemId, l.unitPriceCents, l.quantity])).toEqual([
      [1, 1600, 1],
      [2, 1950, 2],
    ]);
    expect(basket.totalCents).toBe(5500);

    const { html } = await browser.get("/basket");
    expect(html).toContain("$55.00");
    expect(html).toMatch(/data-testid="basket-count">3/);
  });

  it("increases the quantity when the same item is added again", async () => {
    const browser = new Browser();
    await browser.addToBasket(5);
    await browser.addToBasket(5);
    const basket = await getBasket(env.DB, anonBuyerId(anonId(browser)));
    expect(basket.lines).toHaveLength(1);
    expect(basket.lines[0]?.quantity).toBe(2);
  });

  it("returns 404 for an unknown product", async () => {
    const browser = new Browser();
    const response = await browser.post("/basket/items", { catalogItemId: "9999" });
    expect(response.status).toBe(404);
  });

  it("updates quantities, and quantity 0 removes the line", async () => {
    const browser = new Browser();
    await browser.addToBasket(1);
    await browser.addToBasket(3);
    const buyer = anonBuyerId(anonId(browser));
    const [first, second] = await lineIds(buyer);
    const response = await browser.post("/basket", { [`qty-${first}`]: "4", [`qty-${second}`]: "0" });
    expect(response.status).toBe(303);
    expect(response.headers.get("location")).toBe("/basket");
    const basket = await getBasket(env.DB, buyer);
    expect(basket.lines.map((l) => [l.id, l.quantity])).toEqual([[first, 4]]);
    expect(basket.totalCents).toBe(6400);
  });

  it("rejects invalid quantities without changing the basket", async () => {
    const browser = new Browser();
    await browser.addToBasket(1);
    const buyer = anonBuyerId(anonId(browser));
    const [line] = await lineIds(buyer);
    for (const bad of ["-1", "1.5", "abc", "100", ""]) {
      const response = await browser.post("/basket", { [`qty-${line}`]: bad });
      expect(response.status, `quantity ${JSON.stringify(bad)}`).toBe(200);
    }
    expect((await getBasket(env.DB, buyer)).lines[0]?.quantity).toBe(1);
  });

  it("redirects to checkout when the Checkout button submits the basket form", async () => {
    const browser = new Browser();
    await browser.addToBasket(1);
    const [line] = await lineIds(anonBuyerId(anonId(browser)));
    const response = await browser.post("/basket", { [`qty-${line}`]: "2", next: "checkout" });
    expect(response.headers.get("location")).toBe("/checkout");
  });

  it("removes a line", async () => {
    const browser = new Browser();
    await browser.addToBasket(1);
    await browser.addToBasket(2);
    const buyer = anonBuyerId(anonId(browser));
    const [first] = await lineIds(buyer);
    const response = await browser.post(`/basket/items/${first}/remove`);
    expect(response.status).toBe(303);
    expect((await getBasket(env.DB, buyer)).lines.map((l) => l.catalogItemId)).toEqual([2]);
  });

  it("cannot change or remove another visitor's basket lines", async () => {
    const owner = new Browser();
    await owner.addToBasket(1);
    const ownerBuyer = anonBuyerId(anonId(owner));
    const [line] = await lineIds(ownerBuyer);

    const attacker = new Browser();
    await attacker.get("/");
    await attacker.post(`/basket/items/${line}/remove`);
    await attacker.post("/basket", { [`qty-${line}`]: "0" });
    expect(await lineIds(ownerBuyer)).toEqual([line]);
  });

  it("parses only qty-<id> fields", () => {
    expect(parseQuantities({ "qty-3": "2", _csrf: "x", next: "checkout" })).toEqual(new Map([[3, 2]]));
    expect(parseQuantities({ "qty-3": " " })).toBeNull();
  });
});

describe("basket merge on sign-in (TransferBasket)", () => {
  it("moves the anonymous basket into the user's basket and sums quantities", async () => {
    const user = await createTestUser();

    // The user already has item 1 in their basket from an earlier session, at an older price.
    const earlier = new Browser();
    await earlier.signIn(user.email);
    await earlier.addToBasket(1, 1);
    await env.DB.prepare(
      "UPDATE basket_items SET unit_price_cents = 1500 WHERE basket_id = (SELECT id FROM baskets WHERE buyer_id = ?1)",
    )
      .bind(userBuyerId(user.id))
      .run();

    // Signed out, they add items anonymously in a new browser, then sign in.
    const browser = new Browser();
    await browser.addToBasket(1, 2);
    await browser.addToBasket(4, 1);
    const anonBuyer = anonBuyerId(anonId(browser));
    const response = await browser.signIn(user.email);
    expect(response.status).toBe(303);

    const basket = await getBasket(env.DB, userBuyerId(user.id));
    expect(basket.lines.map((l) => [l.catalogItemId, l.quantity, l.unitPriceCents])).toEqual([
      [1, 3, 1500], // user's existing line keeps its captured price
      [4, 1, 1825],
    ]);
    expect((await getBasket(env.DB, anonBuyer)).lines).toHaveLength(0);
    const row = await env.DB.prepare("SELECT COUNT(*) AS n FROM baskets WHERE buyer_id = ?1")
      .bind(anonBuyer)
      .first<{ n: number }>();
    expect(row?.n).toBe(0);
    // The anonymous cookie is cleared once the basket has been transferred.
    expect(browser.cookies.has("nw_anon")).toBe(false);
  });

  it("merges on registration too", async () => {
    const browser = new Browser();
    await browser.addToBasket(7, 2);
    await browser.register();
    const { html } = await browser.get("/basket");
    expect(html).toContain("Colombia Huila Ground, 12 oz");
    expect(html).toMatch(/data-testid="basket-count">2/);
  });
});
