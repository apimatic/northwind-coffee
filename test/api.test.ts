import { env } from "cloudflare:workers";
import { afterEach, describe, expect, it, vi } from "vitest";
import { BASE_URL, call } from "./helpers";

async function getJson(path: string): Promise<{ status: number; body: unknown; headers: Headers }> {
  const response = await call(new Request(new URL(path, BASE_URL)));
  expect(response.headers.get("content-type")).toContain("application/json");
  return { status: response.status, body: await response.json(), headers: response.headers };
}

interface ItemsBody {
  catalogItems: { id: number; priceCents: number; currency: string; catalogBrandId: number; catalogTypeId: number }[];
  pageIndex: number;
  pageSize: number;
  pageCount: number;
  totalItems: number;
}

describe("public catalog API", () => {
  it("GET /api/catalog-items pages with defaults", async () => {
    const { status, body } = await getJson("/api/catalog-items");
    const items = body as ItemsBody;
    expect(status).toBe(200);
    expect(items).toMatchObject({ pageIndex: 0, pageSize: 10, pageCount: 2, totalItems: 16 });
    expect(items.catalogItems).toHaveLength(10);
    expect(items.catalogItems[0]).toEqual({
      id: 1,
      name: "House Blend Whole Bean, 12 oz",
      description: "Our everyday medium roast: milk chocolate, toasted almond and a clean finish.",
      priceCents: 1600,
      currency: "USD",
      pictureUri: "/images/products/house-blend-whole-bean.svg",
      catalogTypeId: 1,
      catalogBrandId: 1,
    });
  });

  it("supports pageIndex, pageSize and brand/type filters", async () => {
    const page = (await getJson("/api/catalog-items?pageIndex=1&pageSize=5")).body as ItemsBody;
    expect(page.catalogItems.map((i) => i.id)).toEqual([6, 7, 8, 9, 10]);
    expect(page.pageCount).toBe(4);

    const filtered = (await getJson("/api/catalog-items?catalogBrandId=1&catalogTypeId=2")).body as ItemsBody;
    expect(filtered.totalItems).toBe(1);
    expect(filtered.catalogItems[0]).toMatchObject({ id: 5, catalogBrandId: 1, catalogTypeId: 2 });
  });

  it("falls back to defaults for invalid paging parameters", async () => {
    const { status, body } = await getJson("/api/catalog-items?pageIndex=-3&pageSize=0&catalogBrandId=x");
    expect(status).toBe(200);
    expect(body).toMatchObject({ pageIndex: 0, pageSize: 10, totalItems: 16 });
  });

  it("GET /api/catalog-items/:id returns one item or 404", async () => {
    const found = await getJson("/api/catalog-items/15");
    expect(found.status).toBe(200);
    expect(found.body).toMatchObject({ catalogItem: { id: 15, name: "Conical Burr Grinder", priceCents: 8900 } });
    expect((await getJson("/api/catalog-items/999")).status).toBe(404);
    expect((await getJson("/api/catalog-items/abc")).status).toBe(404);
  });

  it("GET /api/catalog-brands and /api/catalog-types", async () => {
    const brands = await getJson("/api/catalog-brands");
    expect(brands.body).toEqual({
      catalogBrands: [
        { id: 2, name: "Contoso Coffee Co." },
        { id: 3, name: "Fabrikam Farms" },
        { id: 1, name: "Northwind Roasters" },
        { id: 4, name: "Tailspin Trading" },
      ],
    });
    const types = await getJson("/api/catalog-types");
    expect(types.body).toEqual({
      catalogTypes: [
        { id: 1, name: "Whole bean" },
        { id: 2, name: "Ground" },
        { id: 3, name: "Capsules" },
        { id: 4, name: "Brewing gear" },
      ],
    });
  });

  it("returns JSON 404 for unknown API paths and sets no cookies", async () => {
    const { status, body, headers } = await getJson("/api/nope");
    expect(status).toBe(404);
    expect(body).toEqual({ error: "Not found" });
    expect(headers.get("set-cookie")).toBeNull();
  });
});

describe("health, errors and logging", () => {
  afterEach(() => vi.restoreAllMocks());

  it("GET /healthz runs a D1 query", async () => {
    const response = await call(new Request(new URL("/healthz", BASE_URL)));
    expect(response.status).toBe(200);
    expect(await response.json()).toEqual({ ok: true });
  });

  it("renders a friendly 404 page", async () => {
    const response = await call(new Request(new URL("/no-such-page", BASE_URL)));
    expect(response.status).toBe(404);
    const html = await response.text();
    expect(html).toContain("<!DOCTYPE html>");
    expect(html).toContain("Page not found");
  });

  it("sets security headers", async () => {
    const response = await call(new Request(new URL("/", BASE_URL)));
    expect(response.headers.get("content-security-policy")).toContain("default-src 'self'");
    expect(response.headers.get("x-content-type-options")).toBe("nosniff");
    expect(response.headers.get("x-frame-options")).toBe("DENY");
  });

  it("logs one structured JSON line per request", async () => {
    const lines: string[] = [];
    vi.spyOn(console, "log").mockImplementation((line: unknown) => {
      lines.push(String(line));
    });
    await call(new Request(new URL("/api/catalog-types", BASE_URL)));
    const entries = lines.map((line) => JSON.parse(line) as Record<string, unknown>);
    expect(entries).toHaveLength(1);
    expect(entries[0]).toMatchObject({ event: "request", method: "GET", path: "/api/catalog-types", status: 200 });
    expect(typeof entries[0]?.ms).toBe("number");
  });

  it("shows a 500 page without details and logs the error with its stack", async () => {
    const errors: string[] = [];
    vi.spyOn(console, "error").mockImplementation((line: unknown) => {
      errors.push(String(line));
    });
    vi.spyOn(console, "log").mockImplementation(() => {});
    const brokenDb = {
      prepare() {
        throw new Error("database exploded: secret detail");
      },
    } as unknown as D1Database;
    const { default: app } = await import("../src/index");
    const response = await app.fetch(new Request(new URL("/", BASE_URL)), { ...env, DB: brokenDb });
    expect(response.status).toBe(500);
    const html = await response.text();
    expect(html).toContain("Something went wrong");
    expect(html).not.toContain("secret detail");
    const entry = JSON.parse(errors[0] ?? "{}") as Record<string, string>;
    expect(entry).toMatchObject({
      event: "error",
      method: "GET",
      path: "/",
      message: "database exploded: secret detail",
    });
    expect(entry.stack).toContain("database exploded");

    const api = await app.fetch(new Request(new URL("/api/catalog-types", BASE_URL)), { ...env, DB: brokenDb });
    expect(api.status).toBe(500);
    expect(await api.json()).toEqual({ error: "Internal server error" });
  });
});
