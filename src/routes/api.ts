import { Hono } from "hono";
import type { AppEnv } from "../env";
import { DEFAULT_CURRENCY } from "../lib/money";
import * as catalogService from "../services/catalog";
import type { CatalogItem } from "../services/catalog";
import { parseId } from "./helpers";

/** Read-only public catalog API (eShopOnWeb PublicApi parity). Prices are integer cents. */
export const api = new Hono<AppEnv>();

function toDto(item: CatalogItem) {
  return {
    id: item.id,
    name: item.name,
    description: item.description,
    priceCents: item.priceCents,
    currency: DEFAULT_CURRENCY,
    pictureUri: item.pictureUri,
    catalogTypeId: item.catalogTypeId,
    catalogBrandId: item.catalogBrandId,
  };
}

api.get("/catalog-items", async (c) => {
  const query = catalogService.catalogQuerySchema.parse({
    brandId: c.req.query("catalogBrandId"),
    typeId: c.req.query("catalogTypeId"),
    pageIndex: c.req.query("pageIndex"),
    pageSize: c.req.query("pageSize"),
  });
  const page = await catalogService.listCatalog(c.env.DB, query);
  return c.json({
    catalogItems: page.items.map(toDto),
    pageIndex: page.pageIndex,
    pageSize: page.pageSize,
    pageCount: page.pageCount,
    totalItems: page.totalItems,
  });
});

api.get("/catalog-items/:id", async (c) => {
  const id = parseId(c.req.param("id"));
  const item = id === null ? null : await catalogService.getCatalogItem(c.env.DB, id);
  if (!item) return c.json({ error: "Catalog item not found" }, 404);
  return c.json({ catalogItem: toDto(item) });
});

api.get("/catalog-brands", async (c) => {
  const brands = await catalogService.listBrands(c.env.DB);
  return c.json({ catalogBrands: brands.map((b) => ({ id: b.id, name: b.brand })) });
});

api.get("/catalog-types", async (c) => {
  const types = await catalogService.listTypes(c.env.DB);
  return c.json({ catalogTypes: types.map((t) => ({ id: t.id, name: t.type })) });
});

api.all("*", (c) => c.json({ error: "Not found" }, 404));
