/**
 * Full-page screenshots of every page at desktop (1440 px) and phone (390 px) widths.
 * Run with `npm run screenshots`; output goes to $SCREENSHOT_DIR (default test-results/screenshots).
 */
import { join } from "node:path";
import type { Page } from "@playwright/test";
import { E2E_ADMIN_EMAIL, E2E_ADMIN_PASSWORD, E2E_CUSTOMER_PASSWORD } from "./constants";
import { expect, test } from "./fixtures";

const outDir = process.env.SCREENSHOT_DIR ?? join("test-results", "screenshots");
const widths = [
  { width: 1440, height: 900 },
  { width: 390, height: 844 },
];

for (const viewport of widths) {
  test(`screenshots at ${viewport.width}px`, async ({ browser }) => {
    const context = await browser.newContext({ viewport });
    const page = await context.newPage();
    const errors: string[] = [];
    page.on("console", (m) => {
      if (m.type() === "error") errors.push(m.text());
    });
    let n = 0;
    const shot = async (name: string) => {
      n += 1;
      await page.evaluate(() => document.fonts.ready);
      await page.screenshot({
        path: join(outDir, `${String(n).padStart(2, "0")}-${name}-${viewport.width}.png`),
        fullPage: true,
      });
    };
    const nav = (p: Page) => p.getByRole("navigation", { name: "Main" });

    await page.goto("/");
    await shot("catalog");
    await page.goto("/?page=2");
    await shot("catalog-page-2");
    await page.goto("/?brand=4");
    await shot("catalog-filtered-brand");

    await page.goto("/basket");
    await shot("basket-empty");
    await page.goto("/?type=1");
    await page.getByRole("button", { name: "Add to basket: House Blend Whole Bean, 12 oz" }).click();
    await page.goto("/?type=4");
    await page.getByRole("button", { name: "Add to basket: French Press, 34 oz" }).click();
    await expect(page.getByTestId("basket-line")).toHaveCount(2);
    await shot("basket");

    await page.goto("/account/login?returnUrl=%2Fcheckout");
    await shot("sign-in");
    await page.getByLabel("Email").fill("nobody@example.com");
    await page.getByLabel("Password").fill("wrong-password");
    await page.getByRole("button", { name: "Sign in" }).click();
    await shot("sign-in-failed");

    await page.getByRole("link", { name: "Create an account" }).click();
    await shot("register");
    const email = `jamie.${viewport.width}.${Math.random().toString(36).slice(2, 6)}@example.com`;
    await page.getByLabel("Email").fill(email);
    await page.getByLabel("Password", { exact: true }).fill(E2E_CUSTOMER_PASSWORD);
    await page.getByLabel("Confirm password").fill(E2E_CUSTOMER_PASSWORD);
    await page.getByRole("button", { name: "Create account" }).click();
    await expect(page).toHaveURL(/\/checkout$/);
    await shot("checkout");

    await page.getByRole("button", { name: "Place order" }).click();
    await expect(page.getByText("Please check the highlighted fields.")).toBeVisible();
    await shot("checkout-validation-errors");
    await page.getByLabel("Full name").fill("Grace Hopper");
    await page.getByLabel("Street address").fill("1 Compiler Court");
    await page.getByLabel("Apartment, suite, etc.").fill("Suite 200");
    await page.getByLabel("City").fill("Arlington");
    await page.getByLabel("State / region").fill("VA");
    await page.getByLabel("Postal code").fill("22201");
    await page.getByRole("button", { name: "Place order" }).click();
    await expect(page).toHaveURL(/\/orders\/\d+\?placed=1$/);
    const orderId = /\/orders\/(\d+)/.exec(page.url())?.[1] ?? "";
    await shot("order-confirmation");

    await nav(page).getByRole("link", { name: "My orders" }).click();
    await shot("my-orders");
    await page.goto(`/orders/${orderId}`);
    await shot("order-detail");

    await page.goto("/admin");
    await shot("access-denied-for-customer");

    await page.getByRole("button", { name: "Sign out" }).click();
    await page.goto("/account/login");
    await page.getByLabel("Email").fill(E2E_ADMIN_EMAIL);
    await page.getByLabel("Password").fill(E2E_ADMIN_PASSWORD);
    await page.getByRole("button", { name: "Sign in" }).click();
    await nav(page).getByRole("link", { name: "Admin" }).click();
    await shot("admin-orders");
    await page.goto(`/admin/orders/${orderId}`);
    await shot("admin-order");
    await page.getByRole("button", { name: "Cancel order" }).click();
    await expect(page.getByText("The order was cancelled.")).toBeVisible();
    await shot("admin-order-cancelled");
    await page.goto("/admin/orders?status=cancelled");
    await shot("admin-orders-filtered-cancelled");
    await page.goto("/admin/catalog");
    await shot("admin-catalog");

    await page.goto("/no-such-page");
    await shot("not-found");

    // Only the deliberate 403 and 404 navigations may log console errors.
    expect(errors.filter((e) => !/status of (403|404)/.test(e))).toEqual([]);
    await context.close();
  });
}
