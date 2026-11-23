import { z } from "zod";
import * as basketDb from "../db/baskets";
import { MAX_LINE_QUANTITY } from "../db/baskets";
import * as catalogDb from "../db/catalog";
import { type Cents, lineTotal, sumCents } from "../lib/money";

export { MAX_LINE_QUANTITY };

/** Basket owner key: signed-in users and anonymous visitors have separate baskets. */
export function userBuyerId(userId: number): string {
  return `u:${userId}`;
}
export function anonBuyerId(anonId: string): string {
  return `a:${anonId}`;
}

export interface BasketLine {
  id: number;
  catalogItemId: number;
  name: string;
  pictureUri: string;
  unitPriceCents: Cents;
  quantity: number;
  lineTotalCents: Cents;
}

export interface Basket {
  lines: BasketLine[];
  totalCents: Cents;
  unitCount: number;
}

export const addItemSchema = z.object({
  catalogItemId: z.coerce.number().int().positive(),
  quantity: z.coerce.number().int().min(1).max(MAX_LINE_QUANTITY).default(1),
});

export async function getBasket(db: D1Database, buyerId: string): Promise<Basket> {
  const rows = await basketDb.listBasketLines(db, buyerId);
  const lines = rows.map((row) => ({
    id: row.id,
    catalogItemId: row.catalog_item_id,
    name: row.name,
    pictureUri: row.picture_uri,
    unitPriceCents: row.unit_price_cents,
    quantity: row.quantity,
    lineTotalCents: lineTotal(row.unit_price_cents, row.quantity),
  }));
  return {
    lines,
    totalCents: sumCents(lines.map((line) => line.lineTotalCents)),
    unitCount: lines.reduce((n, line) => n + line.quantity, 0),
  };
}

export function countUnits(db: D1Database, buyerId: string): Promise<number> {
  return basketDb.countBasketUnits(db, buyerId);
}

/** Adds a catalog item; the unit price is captured from the catalog now. */
export async function addItem(
  db: D1Database,
  buyerId: string,
  input: z.infer<typeof addItemSchema>,
): Promise<{ ok: true } | { ok: false; reason: "not_found" }> {
  const item = await catalogDb.getCatalogItem(db, input.catalogItemId);
  if (!item) return { ok: false, reason: "not_found" };
  await basketDb.addBasketItem(db, buyerId, {
    catalogItemId: item.id,
    unitPriceCents: item.price_cents,
    quantity: input.quantity,
  });
  return { ok: true };
}

/**
 * Parses quantity fields named `qty-<basketItemId>` from the basket form.
 * Returns null if any value is not an integer from 0 to MAX_LINE_QUANTITY.
 */
export function parseQuantities(form: Record<string, unknown>): Map<number, number> | null {
  const quantities = new Map<number, number>();
  const quantity = z.coerce.number().int().min(0).max(MAX_LINE_QUANTITY);
  for (const [key, value] of Object.entries(form)) {
    const match = /^qty-(\d+)$/.exec(key);
    if (!match) continue;
    const parsed = quantity.safeParse(typeof value === "string" ? value.trim() : value);
    if (!parsed.success || (typeof value === "string" && value.trim() === "")) return null;
    quantities.set(Number(match[1]), parsed.data);
  }
  return quantities;
}

export function setQuantities(db: D1Database, buyerId: string, quantities: ReadonlyMap<number, number>) {
  return basketDb.setBasketQuantities(db, buyerId, quantities);
}

export function removeItem(db: D1Database, buyerId: string, basketItemId: number) {
  return basketDb.deleteBasketItem(db, buyerId, basketItemId);
}

/** Merges an anonymous basket into the signed-in user's basket (eShopOnWeb TransferBasket). */
export function transferBasket(db: D1Database, anonId: string, userId: number) {
  return basketDb.transferBasket(db, anonBuyerId(anonId), userBuyerId(userId));
}
