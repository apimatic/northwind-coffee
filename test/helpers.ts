import { createExecutionContext, waitOnExecutionContext } from "cloudflare:test";
import { env } from "cloudflare:workers";
import { expect } from "vitest";
import app from "../src/index";
import { createUser, type Role } from "../src/services/identity";

export const BASE_URL = "https://northwind.test";
export const TEST_PASSWORD = "correct-horse-battery";

let counter = 0;
export function uniqueEmail(prefix = "user"): string {
  counter += 1;
  return `${prefix}-${Date.now()}-${counter}-${crypto.randomUUID().slice(0, 8)}@example.com`;
}

/** Calls the Worker directly (inside workerd) without following redirects. */
export async function call(request: Request): Promise<Response> {
  const ctx = createExecutionContext();
  const response = await app.fetch(request, env, ctx);
  await waitOnExecutionContext(ctx);
  return response;
}

/** A minimal browser: keeps cookies between requests and reads CSRF tokens from pages. */
export class Browser {
  readonly cookies = new Map<string, string>();
  csrfToken = "";

  async request(method: string, path: string, body?: URLSearchParams, headers: Record<string, string> = {}) {
    const requestHeaders = new Headers(headers);
    if (this.cookies.size > 0) {
      requestHeaders.set("cookie", [...this.cookies].map(([name, value]) => `${name}=${value}`).join("; "));
    }
    if (body) requestHeaders.set("content-type", "application/x-www-form-urlencoded");
    const response = await call(new Request(new URL(path, BASE_URL), { method, headers: requestHeaders, body }));
    for (const setCookie of response.headers.getSetCookie()) {
      const [pair = "", ...attributes] = setCookie.split(";").map((part) => part.trim());
      const index = pair.indexOf("=");
      const name = pair.slice(0, index);
      const value = pair.slice(index + 1);
      const expired = attributes.some((a) => /^max-age=0$/i.test(a) || /^expires=thu, 01 jan 1970/i.test(a));
      if (expired || value === "") this.cookies.delete(name);
      else this.cookies.set(name, value);
    }
    return response;
  }

  /** GET a page; remembers the CSRF token rendered in it. */
  async get(path: string): Promise<{ response: Response; html: string }> {
    const response = await this.request("GET", path);
    const html = await response.text();
    const match = /name="_csrf" value="([^"]+)"/.exec(html);
    if (match?.[1]) this.csrfToken = match[1];
    return { response, html };
  }

  /** POST a form with the current CSRF token (unless `_csrf` is given explicitly). */
  async post(path: string, fields: Record<string, string> = {}): Promise<Response> {
    if (!this.csrfToken) await this.get("/");
    const body = new URLSearchParams({ _csrf: this.csrfToken, ...fields });
    return this.request("POST", path, body);
  }

  async register(email = uniqueEmail(), password = TEST_PASSWORD): Promise<string> {
    await this.get("/account/register");
    const response = await this.post("/account/register", { email, password, confirmPassword: password });
    expect(response.status).toBe(303);
    await this.get("/");
    return email;
  }

  async signIn(email: string, password = TEST_PASSWORD): Promise<Response> {
    await this.get("/account/login");
    const response = await this.post("/account/login", { email, password });
    await this.get("/");
    return response;
  }

  async addToBasket(catalogItemId: number, quantity = 1): Promise<void> {
    const response = await this.post("/basket/items", {
      catalogItemId: String(catalogItemId),
      quantity: String(quantity),
    });
    expect(response.status).toBe(303);
  }
}

export async function createTestUser(role: Role = "customer"): Promise<{ email: string; id: number }> {
  const email = uniqueEmail(role);
  const result = await createUser(env.DB, { email, password: TEST_PASSWORD, role });
  if (!result.ok) throw new Error("could not create test user");
  return { email, id: result.user.id };
}

export const validAddress = {
  name: "Ada Lovelace",
  line1: "12 Analytical Way",
  line2: "",
  city: "Seattle",
  region: "WA",
  postalCode: "98101",
  country: "US",
};

/** Reads the hidden checkout key from the checkout page. */
export function checkoutKeyFrom(html: string): string {
  const match = /name="checkoutKey" value="([^"]+)"/.exec(html);
  if (!match?.[1]) throw new Error("checkout key not found");
  return match[1];
}
