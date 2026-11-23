import { expect, expectAccessible, test } from "./fixtures";

test("register and sign-in pages, including error states, are accessible", async ({ page }) => {
  await page.goto("/account/register");
  await expectAccessible(page, "register");
  await page.getByRole("button", { name: "Create account" }).click();
  await expect(page.getByText("Enter a valid email address.")).toBeVisible();
  await expectAccessible(page, "register (validation errors)");

  await page.goto("/account/login");
  await page.getByLabel("Email").fill("nobody@example.com");
  await page.getByLabel("Password").fill("wrong-password");
  await page.getByRole("button", { name: "Sign in" }).click();
  await expect(page.getByText("The email or password is incorrect.")).toBeVisible();
  await expectAccessible(page, "sign-in (failed)");
});

test("empty basket and 404 pages", async ({ page, consoleGuard }) => {
  await page.goto("/basket");
  await expect(page.getByText("Your basket is empty.")).toBeVisible();
  await expectAccessible(page, "empty basket");

  // Chromium logs every 4xx document response; this one is the point of the test.
  consoleGuard.allowOnce(/Failed to load resource: .* 404 .*\/no-such-page\)$/);
  const response = await page.goto("/no-such-page");
  expect(response?.status()).toBe(404);
  await expect(page.getByRole("heading", { name: "Page not found" })).toBeVisible();
  await expectAccessible(page, "404");
});

test("API and health endpoints respond with JSON", async ({ request }) => {
  const health = await request.get("/healthz");
  expect(await health.json()).toEqual({ ok: true });
  const items = await request.get("/api/catalog-items?pageSize=3");
  expect((await items.json()).catalogItems).toHaveLength(3);
});
