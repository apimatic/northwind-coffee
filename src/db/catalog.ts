export interface CatalogItemRow {
  id: number;
  name: string;
  description: string;
  price_cents: number;
  picture_uri: string;
  catalog_type_id: number;
  catalog_brand_id: number;
  brand: string;
  type: string;
}

export interface CatalogFilter {
  brandId: number | null;
  typeId: number | null;
}

const ITEM_COLUMNS = `ci.id, ci.name, ci.description, ci.price_cents, ci.picture_uri,
  ci.catalog_type_id, ci.catalog_brand_id, cb.brand, ct.type`;
const ITEM_FROM = `catalog_items ci
  JOIN catalog_brands cb ON cb.id = ci.catalog_brand_id
  JOIN catalog_types ct ON ct.id = ci.catalog_type_id`;
const FILTER_WHERE = "(?1 IS NULL OR ci.catalog_brand_id = ?1) AND (?2 IS NULL OR ci.catalog_type_id = ?2)";

export async function countCatalogItems(db: D1Database, filter: CatalogFilter): Promise<number> {
  const row = await db
    .prepare(`SELECT COUNT(*) AS n FROM catalog_items ci WHERE ${FILTER_WHERE}`)
    .bind(filter.brandId, filter.typeId)
    .first<{ n: number }>();
  return row?.n ?? 0;
}

export async function listCatalogItems(
  db: D1Database,
  filter: CatalogFilter,
  limit: number,
  offset: number,
): Promise<CatalogItemRow[]> {
  const { results } = await db
    .prepare(`SELECT ${ITEM_COLUMNS} FROM ${ITEM_FROM} WHERE ${FILTER_WHERE} ORDER BY ci.id LIMIT ?3 OFFSET ?4`)
    .bind(filter.brandId, filter.typeId, limit, offset)
    .all<CatalogItemRow>();
  return results;
}

export async function getCatalogItem(db: D1Database, id: number): Promise<CatalogItemRow | null> {
  return db.prepare(`SELECT ${ITEM_COLUMNS} FROM ${ITEM_FROM} WHERE ci.id = ?1`).bind(id).first<CatalogItemRow>();
}

export async function listAllCatalogItems(db: D1Database): Promise<CatalogItemRow[]> {
  const { results } = await db.prepare(`SELECT ${ITEM_COLUMNS} FROM ${ITEM_FROM} ORDER BY ci.id`).all<CatalogItemRow>();
  return results;
}

export async function listBrands(db: D1Database): Promise<{ id: number; brand: string }[]> {
  const { results } = await db
    .prepare("SELECT id, brand FROM catalog_brands ORDER BY brand")
    .all<{ id: number; brand: string }>();
  return results;
}

export async function listTypes(db: D1Database): Promise<{ id: number; type: string }[]> {
  const { results } = await db
    .prepare("SELECT id, type FROM catalog_types ORDER BY id")
    .all<{ id: number; type: string }>();
  return results;
}

export async function ping(db: D1Database): Promise<boolean> {
  const row = await db.prepare("SELECT 1 AS ok").first<{ ok: number }>();
  return row?.ok === 1;
}
