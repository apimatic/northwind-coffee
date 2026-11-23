export interface ShippingAddress {
  name: string;
  line1: string;
  line2: string;
  city: string;
  region: string;
  postalCode: string;
  country: string;
}

export interface OrderRow {
  id: number;
  buyer_user_id: number;
  buyer_email: string;
  status: string;
  currency: string;
  total_cents: number;
  ship_name: string;
  ship_line1: string;
  ship_line2: string;
  ship_city: string;
  ship_region: string;
  ship_postal_code: string;
  ship_country: string;
  created_at: string;
  updated_at: string;
  item_count: number;
}

export interface OrderItemRow {
  id: number;
  catalog_item_id: number;
  product_name: string;
  picture_uri: string;
  unit_price_cents: number;
  quantity: number;
}

const ORDER_SELECT = `SELECT o.id, o.buyer_user_id, u.email AS buyer_email, o.status, o.currency, o.total_cents,
  o.ship_name, o.ship_line1, o.ship_line2, o.ship_city, o.ship_region, o.ship_postal_code, o.ship_country,
  o.created_at, o.updated_at,
  (SELECT COALESCE(SUM(oi.quantity), 0) FROM order_items oi WHERE oi.order_id = o.id) AS item_count
  FROM orders o JOIN users u ON u.id = o.buyer_user_id`;

export async function findOrderIdByCheckoutKey(
  db: D1Database,
  userId: number,
  checkoutKey: string,
): Promise<number | null> {
  const row = await db
    .prepare("SELECT id FROM orders WHERE buyer_user_id = ?1 AND checkout_key = ?2")
    .bind(userId, checkoutKey)
    .first<{ id: number }>();
  return row?.id ?? null;
}

/**
 * Creates an order from the buyer's basket in a single transaction: the order (total computed
 * from the basket lines), a snapshot of every line (name, picture, unit price), and the emptied
 * basket. Returns the new order id, or null when the basket was empty.
 * Throws a UNIQUE constraint error if the checkout key was already used by this user.
 */
export async function createOrderFromBasket(
  db: D1Database,
  input: {
    userId: number;
    buyerId: string;
    checkoutKey: string;
    status: string;
    currency: string;
    ship: ShippingAddress;
  },
): Promise<number | null> {
  const { userId, buyerId, checkoutKey, ship } = input;
  const results = await db.batch([
    db
      .prepare(
        `INSERT INTO orders (buyer_user_id, checkout_key, status, currency, total_cents,
           ship_name, ship_line1, ship_line2, ship_city, ship_region, ship_postal_code, ship_country)
         SELECT ?1, ?2, ?3, ?4, SUM(bi.unit_price_cents * bi.quantity), ?5, ?6, ?7, ?8, ?9, ?10, ?11
         FROM basket_items bi JOIN baskets b ON b.id = bi.basket_id
         WHERE b.buyer_id = ?12
         HAVING COUNT(*) > 0`,
      )
      .bind(
        userId,
        checkoutKey,
        input.status,
        input.currency,
        ship.name,
        ship.line1,
        ship.line2,
        ship.city,
        ship.region,
        ship.postalCode,
        ship.country,
        buyerId,
      ),
    db
      .prepare(
        `INSERT INTO order_items (order_id, catalog_item_id, product_name, picture_uri, unit_price_cents, quantity)
         SELECT o.id, bi.catalog_item_id, ci.name, ci.picture_uri, bi.unit_price_cents, bi.quantity
         FROM basket_items bi
         JOIN baskets b ON b.id = bi.basket_id
         JOIN catalog_items ci ON ci.id = bi.catalog_item_id
         JOIN orders o ON o.buyer_user_id = ?1 AND o.checkout_key = ?2
         WHERE b.buyer_id = ?3
         ORDER BY bi.id`,
      )
      .bind(userId, checkoutKey, buyerId),
    db.prepare("DELETE FROM basket_items WHERE basket_id = (SELECT id FROM baskets WHERE buyer_id = ?1)").bind(buyerId),
  ]);
  if ((results[0]?.meta.changes ?? 0) === 0) return null;
  return findOrderIdByCheckoutKey(db, userId, checkoutKey);
}

export async function listOrdersForUser(db: D1Database, userId: number): Promise<OrderRow[]> {
  const { results } = await db
    .prepare(`${ORDER_SELECT} WHERE o.buyer_user_id = ?1 ORDER BY o.created_at DESC, o.id DESC`)
    .bind(userId)
    .all<OrderRow>();
  return results;
}

export async function getOrderForUser(db: D1Database, userId: number, orderId: number): Promise<OrderRow | null> {
  return db.prepare(`${ORDER_SELECT} WHERE o.id = ?1 AND o.buyer_user_id = ?2`).bind(orderId, userId).first<OrderRow>();
}

export async function getOrder(db: D1Database, orderId: number): Promise<OrderRow | null> {
  return db.prepare(`${ORDER_SELECT} WHERE o.id = ?1`).bind(orderId).first<OrderRow>();
}

export async function listOrders(db: D1Database, status: string | null): Promise<OrderRow[]> {
  const { results } = await db
    .prepare(`${ORDER_SELECT} WHERE (?1 IS NULL OR o.status = ?1) ORDER BY o.created_at DESC, o.id DESC`)
    .bind(status)
    .all<OrderRow>();
  return results;
}

export async function listOrderItems(db: D1Database, orderId: number): Promise<OrderItemRow[]> {
  const { results } = await db
    .prepare(
      `SELECT id, catalog_item_id, product_name, picture_uri, unit_price_cents, quantity
       FROM order_items WHERE order_id = ?1 ORDER BY id`,
    )
    .bind(orderId)
    .all<OrderItemRow>();
  return results;
}
