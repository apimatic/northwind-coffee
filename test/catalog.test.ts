import { env } from "cloudflare:workers";
import { describe, expect, it } from "vitest";
import { formatMoney, lineTotal, sumCents } from "../src/lib/money";
import { catalogQuerySchema, listCatalog } from "../src/services/catalog";
import { Browser } from "./helpers";

const query = (input: Record<string, unknown>) => catalogQuerySchema.parse(input);

describe("money helpers", () => {
  it("formats integer cents as USD", () => {
    expect(formatMoney(1950)).toBe("$19.50");
    expect(formatMoney(0)).toBe("$0.00");
    expect(formatMoney(123456)).toBe("$1,234.56");
  });

  it("computes line totals and sums in integer cents", () => {
    expect(lineTotal(1825, 3)).toBe(5475);
    expect(sumCents([1600, 1950, 5])).toBe(3555);
  });

  it("rejects fractional or negative amounts", () => {
    expect(() => formatMoney(19.5)).toThrow(RangeError);
    expect(() => lineTotal(-1, 1)).toThrow(RangeError);
    expect(() => lineTotal(100, 1.5)).toThrow(RangeError);
  });
});

describe("catalog service: filters and paging", () => {
  it("returns the first 10 of 16 products by default", async () => {
    const page = await listCatalog(env.DB, query({}));
    expect(page.totalItems).toBe(16);
    expect(page.pageCount).toBe(2);
    expect(page.items).toHaveLength(10);
    expect(page.items[0]?.id).toBe(1);
  });

  it("returns the remaining 6 on the second page", async () => {
    const page = await listCatalog(env.DB, query({ pageIndex: 1 }));
    expect(page.pageIndex).toBe(1);
    expect(page.items.map((i) => i.id)).toEqual([11, 12, 13, 14, 15, 16]);
  });

  it("clamps a page index past the end to the last page", async () => {
    const page = await listCatalog(env.DB, query({ pageIndex: 99 }));
    expect(page.pageIndex).toBe(1);
    expect(page.items).toHaveLength(6);
  });

  it("filters by brand", async () => {
    const page = await listCatalog(env.DB, query({ brandId: 2 }));
    expect(page.totalItems).toBe(4);
    expect(page.items.every((i) => i.catalogBrandId === 2)).toBe(true);
  });

  it("filters by type", async () => {
    const page = await listCatalog(env.DB, query({ typeId: 4 }));
    expect(page.totalItems).toBe(4);
    expect(page.items.every((i) => i.type === "Brewing gear")).toBe(true);
  });

  it("combines brand and type filters", async () => {
    const page = await listCatalog(env.DB, query({ brandId: 3, typeId: 1 }));
    expect(page.items.map((i) => i.name)).toEqual(["Ethiopia Yirgacheffe Whole Bean, 12 oz"]);
  });

  it("returns an empty page for a filter with no matches", async () => {
    const page = await listCatalog(env.DB, query({ brandId: 999 }));
    expect(page).toMatchObject({ totalItems: 0, pageCount: 0, pageIndex: 0, items: [] });
  });

  it("falls back to defaults for invalid query values", () => {
    expect(query({ brandId: "abc", typeId: "-1", pageIndex: "x", pageSize: "1000" })).toEqual({
      brandId: undefined,
      typeId: undefined,
      pageIndex: 0,
      pageSize: 10,
    });
  });

  it("stores every price as integer cents", async () => {
    const page = await listCatalog(env.DB, query({ pageSize: 50 }));
    for (const item of page.items) expect(Number.isInteger(item.priceCents)).toBe(true);
  });
});

describe("catalog page", () => {
  it("renders the grid, filters and pagination", async () => {
    const { response, html } = await new Browser().get("/");
    expect(response.status).toBe(200);
    expect(response.headers.get("content-type")).toContain("text/html");
    expect(html).toContain("Showing 1–10 of 16 products");
    expect(html.match(/data-testid="product-card"/g)).toHaveLength(10);
    expect(html).toContain('href="/?page=2"');
    expect(html).toContain("$16.00");
  });

  it("applies brand and type filters from the query string", async () => {
    const { html } = await new Browser().get("/?brand=4&type=3");
    expect(html).toContain("Showing 1–1 of 1 products");
    expect(html).toContain("Vanilla Capsules, 10 pack");
    expect(html).toMatch(/<option value="4" selected="">Tailspin Trading<\/option>/);
  });

  it("keeps filters in pagination links", async () => {
    const { html } = await new Browser().get("/?type=1&page=1");
    expect(html).not.toContain('rel="next"');
    const all = await new Browser().get("/?page=2");
    expect(all.html).toContain("Showing 11–16 of 16 products");
    expect(all.html).toContain('href="/" rel="prev"');
  });

  it("ignores a malformed page number", async () => {
    const { response, html } = await new Browser().get("/?page=abc&brand=zzz");
    expect(response.status).toBe(200);
    expect(html).toContain("Showing 1–10 of 16 products");
  });
});
