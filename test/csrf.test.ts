import { env } from "cloudflare:workers";
import { describe, expect, it } from "vitest";
import { anonBuyerId, getBasket } from "../src/services/basket";
import { Browser, createTestUser, TEST_PASSWORD, validAddress } from "./helpers";

async function postWith(browser: Browser, path: string, fields: Record<string, string>) {
  return browser.request("POST", path, new URLSearchParams(fields));
}

describe("CSRF protection", () => {
  it("rejects a form without a token", async () => {
    const browser = new Browser();
    await browser.get("/");
    const response = await postWith(browser, "/basket/items", { catalogItemId: "1" });
    expect(response.status).toBe(403);
    expect(await response.text()).toContain("This form has expired");
    expect((await getBasket(env.DB, anonBuyerId(browser.cookies.get("nw_anon") ?? ""))).lines).toHaveLength(0);
  });

  it("rejects a wrong token", async () => {
    const browser = new Browser();
    await browser.get("/");
    const response = await postWith(browser, "/basket/items", { _csrf: "x".repeat(43), catalogItemId: "1" });
    expect(response.status).toBe(403);
  });

  it("rejects a token issued to another visitor", async () => {
    const victim = new Browser();
    await victim.get("/");
    const attacker = new Browser();
    await attacker.get("/");
    const response = await postWith(victim, "/basket/items", { _csrf: attacker.csrfToken, catalogItemId: "1" });
    expect(response.status).toBe(403);
  });

  it("protects every state-changing form", async () => {
    const user = await createTestUser();
    const signedIn = new Browser();
    await signedIn.signIn(user.email);
    const paths: [Browser, string, Record<string, string>][] = [
      [new Browser(), "/basket", { "qty-1": "2" }],
      [new Browser(), "/basket/items/1/remove", {}],
      [new Browser(), "/account/login", { email: user.email, password: TEST_PASSWORD }],
      [new Browser(), "/account/register", { email: "x@example.com", password: TEST_PASSWORD }],
      [signedIn, "/checkout", { checkoutKey: crypto.randomUUID(), ...validAddress }],
      [signedIn, "/account/logout", {}],
      [signedIn, "/admin/orders/1/cancel", {}],
    ];
    for (const [browser, path, fields] of paths) {
      await browser.get("/");
      const response = await postWith(browser, path, fields);
      expect(response.status, path).toBe(403);
    }
    // The rejected logout did not end the session.
    expect((await signedIn.get("/orders")).response.status).toBe(200);
  });

  it("an anonymous token stops working after sign-in", async () => {
    const user = await createTestUser();
    const browser = new Browser();
    await browser.get("/account/login");
    const anonymousToken = browser.csrfToken;
    await browser.post("/account/login", { email: user.email, password: TEST_PASSWORD });
    const response = await postWith(browser, "/basket/items", { _csrf: anonymousToken, catalogItemId: "1" });
    expect(response.status).toBe(403);
  });

  it("accepts the token in the X-CSRF-Token header", async () => {
    const browser = new Browser();
    await browser.get("/");
    const response = await browser.request("POST", "/basket/items", new URLSearchParams({ catalogItemId: "1" }), {
      "x-csrf-token": browser.csrfToken,
    });
    expect(response.status).toBe(303);
  });
});
