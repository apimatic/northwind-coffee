import { E2E_ADMIN_EMAIL, E2E_ADMIN_PASSWORD, E2E_CUSTOMER_PASSWORD } from "./constants";
import { expect, expectAccessible, test, uniqueEmail } from "./fixtures";

test("shopper journey: browse, filter, basket, register, checkout, orders; admin cancels", async ({ page }) => {
  const email = uniqueEmail("shopper");

  // Browse the catalog.
  await page.goto("/");
  await expect(page.getByRole("heading", { level: 1, name: "Great coffee, from bean to cup" })).toBeVisible();
  await expect(page.getByTestId("result-count")).toHaveText("Showing 1–10 of 16 products");
  await expect(page.getByTestId("product-card")).toHaveCount(10);
  await expectAccessible(page, "catalog");

  // Paging.
  await page.getByRole("link", { name: "Next" }).click();
  await expect(page).toHaveURL(/\?page=2$/);
  await expect(page.getByTestId("result-count")).toHaveText("Showing 11–16 of 16 products");

  // Filter by brand, then brand + type.
  await page.getByLabel("Brand").selectOption({ label: "Fabrikam Farms" });
  await page.getByRole("button", { name: "Apply filters" }).click();
  await expect(page).toHaveURL(/brand=3/);
  await expect(page.getByTestId("result-count")).toHaveText("Showing 1–4 of 4 products");
  await page.getByLabel("Type").selectOption({ label: "Whole bean" });
  await page.getByRole("button", { name: "Apply filters" }).click();
  await expect(page.getByTestId("product-card")).toHaveCount(1);

  // Add the first item.
  await page.getByRole("button", { name: "Add to basket: Ethiopia Yirgacheffe Whole Bean, 12 oz" }).click();
  await expect(page).toHaveURL(/\/basket$/);
  await expect(page.getByTestId("basket-line")).toHaveCount(1);

  // Add a second item from another filter.
  await page.goto("/?type=4");
  await page.getByRole("button", { name: "Add to basket: Gooseneck Kettle, 1 L" }).click();
  await expect(page.getByTestId("basket-line")).toHaveCount(2);
  await expect(page.getByTestId("basket-total")).toHaveText("$75.00");
  await expect(page.getByTestId("basket-count")).toContainText("2");
  await expectAccessible(page, "basket");

  // Change a quantity.
  await page.getByLabel("Quantity of Ethiopia Yirgacheffe Whole Bean, 12 oz").fill("2");
  await page.getByRole("button", { name: "Update basket" }).click();
  await expect(page.getByTestId("basket-total")).toHaveText("$96.00");
  await expect(page.getByTestId("basket-count")).toContainText("3");

  // Checkout requires sign-in; register from the sign-in page.
  await page.getByRole("button", { name: "Checkout" }).click();
  await expect(page).toHaveURL(/\/account\/login\?returnUrl=%2Fcheckout$/);
  await expect(page.getByRole("heading", { name: "Sign in" })).toBeVisible();
  await expectAccessible(page, "sign-in");
  await page.getByRole("link", { name: "Create an account" }).click();
  await expect(page).toHaveURL(/\/account\/register\?returnUrl=%2Fcheckout$/);
  await page.getByLabel("Email").fill(email);
  await page.getByLabel("Password", { exact: true }).fill(E2E_CUSTOMER_PASSWORD);
  await page.getByLabel("Confirm password").fill(E2E_CUSTOMER_PASSWORD);
  await page.getByRole("button", { name: "Create account" }).click();

  // The anonymous basket was merged into the new account.
  await expect(page).toHaveURL(/\/checkout$/);
  await expect(page.getByTestId("checkout-total")).toHaveText("$96.00");
  await expect(page.getByText(email)).toBeVisible();
  await expectAccessible(page, "checkout");

  // Server-side validation.
  await page.getByRole("button", { name: "Place order" }).click();
  await expect(page.getByText("Please check the highlighted fields.")).toBeVisible();
  await expectAccessible(page, "checkout (validation errors)");

  await page.getByLabel("Full name").fill("Ada Lovelace");
  await page.getByLabel("Street address").fill("12 Analytical Way");
  await page.getByLabel("City").fill("Seattle");
  await page.getByLabel("State / region").fill("WA");
  await page.getByLabel("Postal code").fill("98101");
  await page.getByLabel("Country").selectOption("US");
  await page.getByRole("button", { name: "Place order" }).click();

  // Order confirmation.
  await expect(page).toHaveURL(/\/orders\/\d+\?placed=1$/);
  const orderId = /\/orders\/(\d+)/.exec(page.url())?.[1] ?? "";
  await expect(page.getByRole("heading", { name: `Order #${orderId}` })).toBeVisible();
  await expect(page.getByText("Thank you! Your order has been placed.")).toBeVisible();
  await expect(page.getByTestId("payment-note")).toHaveText(
    "Pay securely with PayPal. You'll approve the payment on PayPal and come back here.",
  );
  await expect(page.getByTestId("payment-status")).toHaveText("Not paid");
  await expect(page.getByTestId("pay-with-paypal")).toBeVisible();
  await expect(page.getByTestId("order-status")).toHaveText("Awaiting payment");
  await expect(page.getByTestId("order-total")).toHaveText("$96.00");
  await expect(page.getByTestId("order-line")).toHaveCount(2);
  await expect(page.getByTestId("basket-count")).toContainText("0");
  await expectAccessible(page, "order");

  // It shows in My orders.
  await page.getByRole("navigation", { name: "Main" }).getByRole("link", { name: "My orders" }).click();
  const row = page.getByTestId("order-row").filter({ hasText: `Order #${orderId}` });
  await expect(row).toHaveCount(1);
  await expect(row).toContainText("Awaiting payment");
  await expect(row).toContainText("$96.00");
  await expectAccessible(page, "my orders");

  // Sign out, sign in as admin.
  await page.getByRole("button", { name: "Sign out" }).click();
  await expect(page.getByRole("link", { name: "Sign in" })).toBeVisible();
  await page.getByRole("link", { name: "Sign in" }).click();
  await page.getByLabel("Email").fill(E2E_ADMIN_EMAIL);
  await page.getByLabel("Password").fill(E2E_ADMIN_PASSWORD);
  await page.getByRole("button", { name: "Sign in" }).click();
  await page.getByRole("navigation", { name: "Main" }).getByRole("link", { name: "Admin" }).click();

  // Admin sees the order and cancels it.
  await expect(page).toHaveURL(/\/admin\/orders$/);
  const adminRow = page.getByTestId("order-row").filter({ hasText: `Order #${orderId}` });
  await expect(adminRow).toContainText(email);
  await expect(adminRow).toContainText("Awaiting payment");
  await expectAccessible(page, "admin orders");
  await adminRow.getByRole("link", { name: `Order #${orderId}` }).click();
  await expect(page.getByRole("heading", { name: `Order #${orderId}` })).toBeVisible();
  await page.getByRole("button", { name: "Cancel order" }).click();
  await expect(page.getByText("The order was cancelled.")).toBeVisible();
  await expect(page.getByTestId("order-status")).toHaveText("Cancelled");
  await expect(page.getByRole("button", { name: "Cancel order" })).toHaveCount(0);
  await expectAccessible(page, "admin order");

  await page.goto("/admin/orders?status=cancelled");
  await expect(page.getByTestId("order-row").filter({ hasText: `Order #${orderId}` })).toHaveCount(1);

  await page.getByRole("link", { name: "Catalog", exact: true }).click();
  await expect(page.getByText("Read-only. 16 products.")).toBeVisible();
  await expectAccessible(page, "admin catalog");
});
