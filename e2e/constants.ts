/** End-to-end settings. The admin password is a fixed value for the throwaway e2e database only. */
export const E2E_PORT = 8788;
export const E2E_BASE_URL = `http://localhost:${E2E_PORT}`;
export const E2E_STATE_DIR = ".wrangler/e2e-state";
export const E2E_ADMIN_EMAIL = "admin@northwind.test";
export const E2E_ADMIN_PASSWORD = "e2e-only-admin-password";
export const E2E_CUSTOMER_PASSWORD = "e2e-only-customer-password";
