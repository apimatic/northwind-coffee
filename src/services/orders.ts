import { z } from "zod";
import * as ordersDb from "../db/orders";
import { cancelUnpaidOrder } from "../db/payments";
import type { OrderItemRow, OrderRow, ShippingAddress } from "../db/orders";
import { type Cents, DEFAULT_CURRENCY, lineTotal } from "../lib/money";
import { userBuyerId } from "./basket";

export type { ShippingAddress };

export const ORDER_STATUSES = ["awaiting_payment", "paid", "cancelled"] as const;
export type OrderStatus = (typeof ORDER_STATUSES)[number];

export const STATUS_LABELS: Record<OrderStatus, string> = {
  awaiting_payment: "Awaiting payment",
  paid: "Paid",
  cancelled: "Cancelled",
};

export function statusLabel(status: string): string {
  return (STATUS_LABELS as Record<string, string>)[status] ?? status;
}

export const COUNTRIES = [
  ["US", "United States"],
  ["CA", "Canada"],
  ["GB", "United Kingdom"],
  ["IE", "Ireland"],
  ["AU", "Australia"],
  ["NZ", "New Zealand"],
] as const;
const countryCodes = COUNTRIES.map(([code]) => code) as [string, ...string[]];

const text = (label: string, max: number) =>
  z
    .string()
    .trim()
    .min(1, `Enter ${label}.`)
    .max(max, `Use at most ${max} characters.`)
    .refine((value) => ![...value].some((ch) => ch.charCodeAt(0) < 32), "Remove control characters.");

export const shippingAddressSchema = z.object({
  name: text("the recipient's full name", 100),
  line1: text("the street address", 120),
  line2: z.string().trim().max(120, "Use at most 120 characters.").default(""),
  city: text("the city", 80),
  region: text("the state, province or region", 80),
  postalCode: text("the postal code", 16).refine(
    (value) => /^[A-Za-z0-9][A-Za-z0-9 -]{1,14}$/.test(value),
    "Enter a valid postal code.",
  ),
  country: z.enum(countryCodes, "Choose a country."),
});

export const checkoutKeySchema = z.uuid();

export interface OrderSummary {
  id: number;
  buyerUserId: number;
  buyerEmail: string;
  status: string;
  currency: string;
  totalCents: Cents;
  itemCount: number;
  createdAt: string;
  shipTo: ShippingAddress;
}

export interface OrderLine {
  catalogItemId: number;
  productName: string;
  pictureUri: string;
  unitPriceCents: Cents;
  quantity: number;
  lineTotalCents: Cents;
}

export interface OrderDetail extends OrderSummary {
  lines: OrderLine[];
}

function toSummary(row: OrderRow): OrderSummary {
  return {
    id: row.id,
    buyerUserId: row.buyer_user_id,
    buyerEmail: row.buyer_email,
    status: row.status,
    currency: row.currency,
    totalCents: row.total_cents,
    itemCount: row.item_count,
    createdAt: row.created_at,
    shipTo: {
      name: row.ship_name,
      line1: row.ship_line1,
      line2: row.ship_line2,
      city: row.ship_city,
      region: row.ship_region,
      postalCode: row.ship_postal_code,
      country: row.ship_country,
    },
  };
}

function toLine(row: OrderItemRow): OrderLine {
  return {
    catalogItemId: row.catalog_item_id,
    productName: row.product_name,
    pictureUri: row.picture_uri,
    unitPriceCents: row.unit_price_cents,
    quantity: row.quantity,
    lineTotalCents: lineTotal(row.unit_price_cents, row.quantity),
  };
}

async function withLines(db: D1Database, row: OrderRow | null): Promise<OrderDetail | null> {
  if (!row) return null;
  const lines = (await ordersDb.listOrderItems(db, row.id)).map(toLine);
  return { ...toSummary(row), lines };
}

function isUniqueViolation(error: unknown): boolean {
  return error instanceof Error && /UNIQUE constraint failed/i.test(error.message);
}

export type PlaceOrderResult = { ok: true; orderId: number; created: boolean } | { ok: false; reason: "empty_basket" };

/**
 * Places an order from the user's basket. The checkout key (issued with the checkout form)
 * makes this idempotent: resubmitting the same form returns the order it already created.
 */
export async function placeOrder(
  db: D1Database,
  input: { userId: number; checkoutKey: string; shipTo: ShippingAddress },
): Promise<PlaceOrderResult> {
  const existing = await ordersDb.findOrderIdByCheckoutKey(db, input.userId, input.checkoutKey);
  if (existing !== null) return { ok: true, orderId: existing, created: false };
  try {
    const orderId = await ordersDb.createOrderFromBasket(db, {
      userId: input.userId,
      buyerId: userBuyerId(input.userId),
      checkoutKey: input.checkoutKey,
      status: "awaiting_payment" satisfies OrderStatus,
      currency: DEFAULT_CURRENCY,
      ship: input.shipTo,
    });
    if (orderId !== null) return { ok: true, orderId, created: true };
    // Nothing was inserted: either the basket was empty, or a concurrent submission with the
    // same key placed the order (and emptied the basket) first.
    const concurrent = await ordersDb.findOrderIdByCheckoutKey(db, input.userId, input.checkoutKey);
    if (concurrent !== null) return { ok: true, orderId: concurrent, created: false };
    return { ok: false, reason: "empty_basket" };
  } catch (error) {
    if (!isUniqueViolation(error)) throw error;
    const raced = await ordersDb.findOrderIdByCheckoutKey(db, input.userId, input.checkoutKey);
    if (raced === null) throw error;
    return { ok: true, orderId: raced, created: false };
  }
}

export async function listOrdersForUser(db: D1Database, userId: number): Promise<OrderSummary[]> {
  return (await ordersDb.listOrdersForUser(db, userId)).map(toSummary);
}

/** Returns the order only if it belongs to the user. */
export async function getOrderForUser(db: D1Database, userId: number, orderId: number): Promise<OrderDetail | null> {
  return withLines(db, await ordersDb.getOrderForUser(db, userId, orderId));
}

export const adminStatusFilterSchema = z.enum(ORDER_STATUSES).optional().catch(undefined);

export async function listAllOrders(db: D1Database, status?: OrderStatus): Promise<OrderSummary[]> {
  return (await ordersDb.listOrders(db, status ?? null)).map(toSummary);
}

export async function getOrder(db: D1Database, orderId: number): Promise<OrderDetail | null> {
  return withLines(db, await ordersDb.getOrder(db, orderId));
}

export function canCancel(order: Pick<OrderSummary, "status">): boolean {
  return order.status === "awaiting_payment";
}

/**
 * Cancels an order. Only orders awaiting payment can be cancelled, and not while a PayPal capture is under way.
 */
export async function cancelOrder(
  db: D1Database,
  orderId: number,
): Promise<{ ok: true } | { ok: false; reason: "not_found" | "not_cancellable" }> {
  const changed = await cancelUnpaidOrder(db, orderId);
  if (changed) return { ok: true };
  const order = await ordersDb.getOrder(db, orderId);
  return { ok: false, reason: order ? "not_cancellable" : "not_found" };
}
