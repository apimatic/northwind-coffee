import { env } from "cloudflare:workers";
import { describe, expect, it } from "vitest";
import { PBKDF2_ITERATIONS, verifyPassword } from "../src/lib/password";
import { authenticate, createUser, safeReturnUrl } from "../src/services/identity";
import { Browser, createTestUser, TEST_PASSWORD, uniqueEmail } from "./helpers";

describe("registration", () => {
  it("creates an account, signs in and redirects to the return URL", async () => {
    const browser = new Browser();
    const email = uniqueEmail();
    await browser.get("/account/register?returnUrl=%2Forders");
    const response = await browser.post("/account/register?returnUrl=%2Forders", {
      email,
      password: TEST_PASSWORD,
      confirmPassword: TEST_PASSWORD,
    });
    expect(response.status).toBe(303);
    expect(response.headers.get("location")).toBe("/orders");
    const cookie = response.headers.getSetCookie().find((c) => c.startsWith("nw_session="));
    expect(cookie).toMatch(/HttpOnly/);
    expect(cookie).toMatch(/Secure/);
    expect(cookie).toMatch(/SameSite=Lax/);
    const { html } = await browser.get("/");
    expect(html).toContain(email);
    expect(html).toContain("Sign out");
  });

  it("stores a PBKDF2-SHA256 hash with a per-user salt, never the password", async () => {
    const a = await createTestUser();
    const b = await createTestUser();
    const { results } = await env.DB.prepare("SELECT password_hash FROM users WHERE id IN (?1, ?2)")
      .bind(a.id, b.id)
      .all<{ password_hash: string }>();
    const [hashA, hashB] = results.map((r) => r.password_hash);
    expect(hashA).toMatch(new RegExp(`^pbkdf2_sha256\\$${PBKDF2_ITERATIONS}\\$[\\w-]{22}\\$[\\w-]{43}$`));
    expect(hashA).not.toContain(TEST_PASSWORD);
    expect(hashA?.split("$")[2]).not.toBe(hashB?.split("$")[2]);
    expect(await verifyPassword(TEST_PASSWORD, hashA ?? "")).toBe(true);
    expect(PBKDF2_ITERATIONS).toBe(100_000);
  });

  it("rejects a duplicate email (case-insensitive)", async () => {
    const user = await createTestUser();
    const browser = new Browser();
    await browser.get("/account/register");
    const response = await browser.post("/account/register", {
      email: user.email.toUpperCase(),
      password: TEST_PASSWORD,
      confirmPassword: TEST_PASSWORD,
    });
    expect(response.status).toBe(200);
    expect(await response.text()).toContain("An account with this email already exists.");
  });

  it("validates email, password length and confirmation", async () => {
    const browser = new Browser();
    await browser.get("/account/register");
    const response = await browser.post("/account/register", {
      email: "not-an-email",
      password: "short",
      confirmPassword: "different",
    });
    expect(response.status).toBe(200);
    const html = await response.text();
    expect(html).toContain("Enter a valid email address.");
    expect(html).toContain("Use at least 8 characters.");
    expect(browser.cookies.has("nw_session")).toBe(false);
  });

  it("reports mismatched passwords", async () => {
    const browser = new Browser();
    await browser.get("/account/register");
    const response = await browser.post("/account/register", {
      email: uniqueEmail(),
      password: TEST_PASSWORD,
      confirmPassword: `${TEST_PASSWORD}x`,
    });
    expect(response.status).toBe(200);
    expect(await response.text()).toContain("The passwords don&#39;t match.");
  });
});

describe("sign in and sign out", () => {
  it("signs in with the right password", async () => {
    const user = await createTestUser();
    const browser = new Browser();
    const response = await browser.signIn(user.email);
    expect(response.status).toBe(303);
    expect(response.headers.get("location")).toBe("/");
    expect(browser.cookies.has("nw_session")).toBe(true);
  });

  it("rejects a wrong password without creating a session", async () => {
    const user = await createTestUser();
    const browser = new Browser();
    const response = await browser.signIn(user.email, "wrong-password");
    expect(response.status).toBe(200);
    expect(browser.cookies.has("nw_session")).toBe(false);
  });

  it("gives the same answer for an unknown email", async () => {
    const browser = new Browser();
    await browser.get("/account/login");
    const response = await browser.post("/account/login", { email: uniqueEmail(), password: TEST_PASSWORD });
    expect(response.status).toBe(200);
    expect(await response.text()).toContain("The email or password is incorrect.");
    expect(await authenticate(env.DB, "nobody@example.com", TEST_PASSWORD)).toBeNull();
  });

  it("sign out ends the server-side session", async () => {
    const user = await createTestUser();
    const browser = new Browser();
    await browser.signIn(user.email);
    const stolenCookie = browser.cookies.get("nw_session");
    expect((await browser.get("/orders")).response.status).toBe(200);

    const response = await browser.post("/account/logout");
    expect(response.status).toBe(303);
    expect(browser.cookies.has("nw_session")).toBe(false);
    expect((await browser.get("/orders")).response.status).toBe(303);

    // The old cookie no longer works either.
    const replay = new Browser();
    replay.cookies.set("nw_session", stolenCookie ?? "");
    const { response: replayed } = await replay.get("/orders");
    expect(replayed.status).toBe(303);
  });

  it("issues a new session token on every sign-in", async () => {
    const user = await createTestUser();
    const first = new Browser();
    await first.signIn(user.email);
    const second = new Browser();
    await second.signIn(user.email);
    expect(first.cookies.get("nw_session")).not.toBe(second.cookies.get("nw_session"));
  });

  it("ignores a forged session cookie", async () => {
    const browser = new Browser();
    browser.cookies.set("nw_session", "forged-token-forged-token-forged");
    const { response, html } = await browser.get("/");
    expect(response.status).toBe(200);
    expect(html).toContain("Sign in");
  });

  it("does not redirect off-site after sign-in", async () => {
    expect(safeReturnUrl("/checkout")).toBe("/checkout");
    expect(safeReturnUrl("https://evil.example")).toBe("/");
    expect(safeReturnUrl("//evil.example")).toBe("/");
    expect(safeReturnUrl("/\\evil.example")).toBe("/");
    expect(safeReturnUrl(undefined)).toBe("/");

    const user = await createTestUser();
    const browser = new Browser();
    await browser.get("/account/login");
    const response = await browser.post("/account/login?returnUrl=https%3A%2F%2Fevil.example", {
      email: user.email,
      password: TEST_PASSWORD,
    });
    expect(response.headers.get("location")).toBe("/");
  });

  it("createUser refuses weak passwords", async () => {
    await expect(createUser(env.DB, { email: uniqueEmail(), password: "1234567" })).rejects.toThrow();
  });
});
