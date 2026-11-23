export const MAX_LINE_QUANTITY = 99;

export interface BasketLineRow {
  id: number;
  catalog_item_id: number;
  unit_price_cents: number;
  quantity: number;
  name: string;
  picture_uri: string;
}

const BASKET_ID = "(SELECT id FROM baskets WHERE buyer_id = ?1)";

export async function listBasketLines(db: D1Database, buyerId: string): Promise<BasketLineRow[]> {
  const { results } = await db
    .prepare(
      `SELECT bi.id, bi.catalog_item_id, bi.unit_price_cents, bi.quantity, ci.name, ci.picture_uri
       FROM basket_items bi
       JOIN baskets b ON b.id = bi.basket_id
       JOIN catalog_items ci ON ci.id = bi.catalog_item_id
       WHERE b.buyer_id = ?1
       ORDER BY bi.id`,
    )
    .bind(buyerId)
    .all<BasketLineRow>();
  return results;
}

export async function countBasketUnits(db: D1Database, buyerId: string): Promise<number> {
  const row = await db
    .prepare(
      `SELECT COALESCE(SUM(bi.quantity), 0) AS n FROM basket_items bi
       JOIN baskets b ON b.id = bi.basket_id WHERE b.buyer_id = ?1`,
    )
    .bind(buyerId)
    .first<{ n: number }>();
  return row?.n ?? 0;
}

/**
 * Adds a quantity of a catalog item at the given unit price. If the item is already in the
 * basket, the quantity is increased and the originally captured unit price is kept.
 */
export async function addBasketItem(
  db: D1Database,
  buyerId: string,
  item: { catalogItemId: number; unitPriceCents: number; quantity: number },
): Promise<void> {
  await db.batch([
    db.prepare("INSERT INTO baskets (buyer_id) VALUES (?1) ON CONFLICT (buyer_id) DO NOTHING").bind(buyerId),
    db
      .prepare(
        `INSERT INTO basket_items (basket_id, catalog_item_id, unit_price_cents, quantity)
         VALUES (${BASKET_ID}, ?2, ?3, ?4)
         ON CONFLICT (basket_id, catalog_item_id)
         DO UPDATE SET quantity = MIN(basket_items.quantity + excluded.quantity, ${MAX_LINE_QUANTITY})`,
      )
      .bind(buyerId, item.catalogItemId, item.unitPriceCents, item.quantity),
  ]);
}

/** Sets line quantities in one transaction. Quantity 0 removes the line. */
export async function setBasketQuantities(
  db: D1Database,
  buyerId: string,
  quantities: ReadonlyMap<number, number>,
): Promise<void> {
  const statements = [...quantities].map(([basketItemId, quantity]) =>
    quantity === 0
      ? db.prepare(`DELETE FROM basket_items WHERE id = ?2 AND basket_id = ${BASKET_ID}`).bind(buyerId, basketItemId)
      : db
          .prepare(`UPDATE basket_items SET quantity = ?3 WHERE id = ?2 AND basket_id = ${BASKET_ID}`)
          .bind(buyerId, basketItemId, quantity),
  );
  if (statements.length > 0) await db.batch(statements);
}

export async function deleteBasketItem(db: D1Database, buyerId: string, basketItemId: number): Promise<void> {
  await db
    .prepare(`DELETE FROM basket_items WHERE id = ?2 AND basket_id = ${BASKET_ID}`)
    .bind(buyerId, basketItemId)
    .run();
}

/**
 * Moves every line of one basket into another (quantities are added for items already present,
 * keeping the destination's captured price) and deletes the source basket. One transaction.
 */
export async function transferBasket(db: D1Database, fromBuyerId: string, toBuyerId: string): Promise<void> {
  await db.batch([
    db.prepare("INSERT INTO baskets (buyer_id) VALUES (?1) ON CONFLICT (buyer_id) DO NOTHING").bind(toBuyerId),
    db
      .prepare(
        `INSERT INTO basket_items (basket_id, catalog_item_id, unit_price_cents, quantity)
         SELECT (SELECT id FROM baskets WHERE buyer_id = ?2), catalog_item_id, unit_price_cents, quantity
         FROM basket_items WHERE basket_id = (SELECT id FROM baskets WHERE buyer_id = ?1)
         ORDER BY id
         ON CONFLICT (basket_id, catalog_item_id)
         DO UPDATE SET quantity = MIN(basket_items.quantity + excluded.quantity, ${MAX_LINE_QUANTITY})`,
      )
      .bind(fromBuyerId, toBuyerId),
    db.prepare(`DELETE FROM basket_items WHERE basket_id = ${BASKET_ID}`).bind(fromBuyerId),
    db.prepare("DELETE FROM baskets WHERE buyer_id = ?1").bind(fromBuyerId),
  ]);
}
