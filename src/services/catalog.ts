import { z } from "zod";
import * as catalogDb from "../db/catalog";
import type { CatalogItemRow } from "../db/catalog";

export const DEFAULT_PAGE_SIZE = 10;
export const MAX_PAGE_SIZE = 50;

export interface CatalogItem {
  id: number;
  name: string;
  description: string;
  priceCents: number;
  pictureUri: string;
  catalogTypeId: number;
  catalogBrandId: number;
  brand: string;
  type: string;
}

export interface CatalogPage {
  items: CatalogItem[];
  brandId: number | null;
  typeId: number | null;
  pageIndex: number;
  pageSize: number;
  totalItems: number;
  pageCount: number;
}

const optionalId = z.preprocess(
  (value) => (value === "" || value === undefined || value === null ? undefined : value),
  z.coerce.number().int().positive().optional(),
);

/** Query parameters for catalog listing. Invalid values fall back to defaults. */
export const catalogQuerySchema = z.object({
  brandId: optionalId.catch(undefined),
  typeId: optionalId.catch(undefined),
  pageIndex: z.coerce.number().int().min(0).max(10_000).catch(0),
  pageSize: z.coerce.number().int().min(1).max(MAX_PAGE_SIZE).catch(DEFAULT_PAGE_SIZE),
});
export type CatalogQuery = z.infer<typeof catalogQuerySchema>;

export function toCatalogItem(row: CatalogItemRow): CatalogItem {
  return {
    id: row.id,
    name: row.name,
    description: row.description,
    priceCents: row.price_cents,
    pictureUri: row.picture_uri,
    catalogTypeId: row.catalog_type_id,
    catalogBrandId: row.catalog_brand_id,
    brand: row.brand,
    type: row.type,
  };
}

/** Lists a page of the catalog. A page index past the end is clamped to the last page. */
export async function listCatalog(db: D1Database, query: CatalogQuery): Promise<CatalogPage> {
  const filter = { brandId: query.brandId ?? null, typeId: query.typeId ?? null };
  const totalItems = await catalogDb.countCatalogItems(db, filter);
  const pageCount = Math.ceil(totalItems / query.pageSize);
  const pageIndex = Math.min(query.pageIndex, Math.max(pageCount - 1, 0));
  const rows = await catalogDb.listCatalogItems(db, filter, query.pageSize, pageIndex * query.pageSize);
  return {
    items: rows.map(toCatalogItem),
    brandId: filter.brandId,
    typeId: filter.typeId,
    pageIndex,
    pageSize: query.pageSize,
    totalItems,
    pageCount,
  };
}

export async function getCatalogItem(db: D1Database, id: number): Promise<CatalogItem | null> {
  const row = await catalogDb.getCatalogItem(db, id);
  return row ? toCatalogItem(row) : null;
}

export async function listAllCatalogItems(db: D1Database): Promise<CatalogItem[]> {
  return (await catalogDb.listAllCatalogItems(db)).map(toCatalogItem);
}

export const listBrands = catalogDb.listBrands;
export const listTypes = catalogDb.listTypes;
