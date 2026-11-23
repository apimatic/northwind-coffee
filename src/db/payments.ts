export type PaymentState = "creating" | "awaiting_approval" | "capturing" | "completed" | "pending" | "declined";
export type RefundState = "requested" | "pending" | "completed" | "failed" | "unknown";

export interface PaymentRow {
  order_id: number;
  request_id: string;
  paypal_order_id: string | null;
  state: PaymentState;
  amount_cents: number;
  currency: string;
  capture_id: string | null;
  captured_cents: number | null;
  failure_reason: string | null;
  created_at: string;
  updated_at: string;
}

export interface RefundRow {
  id: number;
  order_id: number;
  refund_key: string;
  amount_cents: number;
  currency: string;
  state: RefundState;
  paypal_refund_id: string | null;
  failure_reason: string | null;
  requested_by_user_id: number | null;
  created_at: string;
  updated_at: string;
}

const NOW = "strftime('%Y-%m-%dT%H:%M:%fZ', 'now')";

export async function getPayment(db: D1Database, orderId: number): Promise<PaymentRow | null> {
  return db.prepare("SELECT * FROM paypal_payments WHERE order_id = ?1").bind(orderId).first<PaymentRow>();
}

/**
 * Claims the PayPal checkout for an order. Throws a UNIQUE constraint error if the order already has one.
 */
export async function insertPaymentClaim(
  db: D1Database,
  input: { orderId: number; requestId: string; amountCents: number; currency: string },
): Promise<void> {
  await db
    .prepare(
      `INSERT INTO paypal_payments (order_id, request_id, state, amount_cents, currency)
       VALUES (?1, ?2, 'creating', ?3, ?4)`,
    )
    .bind(input.orderId, input.requestId, input.amountCents, input.currency)
    .run();
}

/**
 * Returns the order's PayPal invoice ID, storing `candidate` first when the order has none yet. One statement, so
 * concurrent callers all get the value that was stored first. Null when the order does not exist.
 */
export async function ensurePaypalInvoiceId(
  db: D1Database,
  orderId: number,
  candidate: string,
): Promise<string | null> {
  const row = await db
    .prepare(
      `UPDATE orders SET paypal_invoice_id = COALESCE(paypal_invoice_id, ?2)
       WHERE id = ?1
       RETURNING paypal_invoice_id`,
    )
    .bind(orderId, candidate)
    .first<{ paypal_invoice_id: string }>();
  return row?.paypal_invoice_id ?? null;
}

/** Releases a checkout claim that PayPal refused (only while it is still being created with this request id). */
export async function deletePaymentClaim(db: D1Database, orderId: number, requestId: string): Promise<void> {
  await db
    .prepare("DELETE FROM paypal_payments WHERE order_id = ?1 AND request_id = ?2 AND state = 'creating'")
    .bind(orderId, requestId)
    .run();
}

/** Records the PayPal order created for this claim. Returns false if the claim moved on meanwhile. */
export async function recordPaypalOrder(
  db: D1Database,
  orderId: number,
  requestId: string,
  paypalOrderId: string,
): Promise<boolean> {
  const result = await db
    .prepare(
      `UPDATE paypal_payments SET paypal_order_id = ?3, state = 'awaiting_approval', failure_reason = NULL,
         updated_at = ${NOW}
       WHERE order_id = ?1 AND request_id = ?2 AND state = 'creating'`,
    )
    .bind(orderId, requestId, paypalOrderId)
    .run();
  return result.meta.changes === 1;
}

/**
 * Starts a new PayPal checkout for an order whose previous one expired or was declined. Only the caller that
 * still sees the old request id wins. Returns false otherwise.
 */
export async function restartPayment(
  db: D1Database,
  orderId: number,
  oldRequestId: string,
  newRequestId: string,
): Promise<boolean> {
  const result = await db
    .prepare(
      `UPDATE paypal_payments SET request_id = ?3, paypal_order_id = NULL, state = 'creating', capture_id = NULL,
         captured_cents = NULL, failure_reason = NULL, updated_at = ${NOW}
       WHERE order_id = ?1 AND request_id = ?2 AND state IN ('awaiting_approval', 'declined')`,
    )
    .bind(orderId, oldRequestId, newRequestId)
    .run();
  return result.meta.changes === 1;
}

/**
 * Claims the capture of an approved PayPal order. Succeeds only for the PayPal order we created for this store
 * order, while the store order is still awaiting payment. Returns true for exactly one caller.
 */
export async function claimCapture(db: D1Database, orderId: number, paypalOrderId: string): Promise<boolean> {
  const result = await db
    .prepare(
      `UPDATE paypal_payments SET state = 'capturing', failure_reason = NULL, updated_at = ${NOW}
       WHERE order_id = ?1 AND paypal_order_id = ?2 AND state = 'awaiting_approval'
         AND EXISTS (SELECT 1 FROM orders WHERE id = ?1 AND status = 'awaiting_payment')`,
    )
    .bind(orderId, paypalOrderId)
    .run();
  return result.meta.changes === 1;
}

/** Releases a capture claim that PayPal certainly did not act on. */
export async function releaseCapture(db: D1Database, orderId: number, reason: string | null): Promise<void> {
  await db
    .prepare(
      `UPDATE paypal_payments SET state = 'awaiting_approval', failure_reason = ?2, updated_at = ${NOW}
       WHERE order_id = ?1 AND state = 'capturing'`,
    )
    .bind(orderId, reason)
    .run();
}

/** Touches a capture claim whose outcome is still unknown, so it is re-checked later. */
export async function noteCaptureUnknown(db: D1Database, orderId: number): Promise<void> {
  await db
    .prepare(`UPDATE paypal_payments SET updated_at = ${NOW} WHERE order_id = ?1 AND state = 'capturing'`)
    .bind(orderId)
    .run();
}

/**
 * Records what PayPal reported for the capture. When `markPaid` is set, the store order becomes paid in the same
 * transaction. Returns false if the payment was not in a capturing/pending state.
 */
export async function recordCapture(
  db: D1Database,
  input: {
    orderId: number;
    state: "completed" | "pending" | "declined";
    captureId: string | null;
    capturedCents: number | null;
    failureReason: string | null;
    markPaid: boolean;
  },
): Promise<boolean> {
  const statements = [
    db
      .prepare(
        `UPDATE paypal_payments SET state = ?2, capture_id = ?3, captured_cents = ?4, failure_reason = ?5,
           updated_at = ${NOW}
         WHERE order_id = ?1 AND state IN ('capturing', 'pending', 'awaiting_approval')`,
      )
      .bind(input.orderId, input.state, input.captureId, input.capturedCents, input.failureReason),
  ];
  if (input.markPaid) {
    statements.push(
      db
        .prepare(
          `UPDATE orders SET status = 'paid', updated_at = ${NOW}
           WHERE id = ?1 AND status = 'awaiting_payment'
             AND EXISTS (SELECT 1 FROM paypal_payments WHERE order_id = ?1 AND state = 'completed')`,
        )
        .bind(input.orderId),
    );
  }
  const results = await db.batch(statements);
  return (results[0]?.meta.changes ?? 0) === 1;
}

export async function listRefunds(db: D1Database, orderId: number): Promise<RefundRow[]> {
  const { results } = await db
    .prepare("SELECT * FROM paypal_refunds WHERE order_id = ?1 ORDER BY created_at, id")
    .bind(orderId)
    .all<RefundRow>();
  return results;
}

export async function getRefund(db: D1Database, orderId: number, refundId: number): Promise<RefundRow | null> {
  return db
    .prepare("SELECT * FROM paypal_refunds WHERE order_id = ?1 AND id = ?2")
    .bind(orderId, refundId)
    .first<RefundRow>();
}

export async function getRefundByKey(db: D1Database, orderId: number, refundKey: string): Promise<RefundRow | null> {
  return db
    .prepare("SELECT * FROM paypal_refunds WHERE order_id = ?1 AND refund_key = ?2")
    .bind(orderId, refundKey)
    .first<RefundRow>();
}

/**
 * Claims a refund. The row is inserted only if the payment is completed and the amount fits in what is still
 * refundable (captured minus every refund that has not failed), checked in the same statement. Returns the new
 * refund id, or null when the amount does not fit. Throws a UNIQUE constraint error if the refund key was used.
 */
export async function insertRefundClaim(
  db: D1Database,
  input: { orderId: number; refundKey: string; amountCents: number; requestedByUserId: number },
): Promise<number | null> {
  const row = await db
    .prepare(
      `INSERT INTO paypal_refunds (order_id, refund_key, amount_cents, currency, state, requested_by_user_id)
       SELECT ?1, ?2, ?3, p.currency, 'requested', ?4
       FROM paypal_payments p
       WHERE p.order_id = ?1 AND p.state = 'completed' AND p.capture_id IS NOT NULL
         AND p.captured_cents - (
           SELECT COALESCE(SUM(r.amount_cents), 0) FROM paypal_refunds r WHERE r.order_id = ?1 AND r.state <> 'failed'
         ) >= ?3
       RETURNING id`,
    )
    .bind(input.orderId, input.refundKey, input.amountCents, input.requestedByUserId)
    .first<{ id: number }>();
  return row?.id ?? null;
}

/** Records a refund outcome. Settled refunds (completed/failed) are never changed again. */
export async function recordRefund(
  db: D1Database,
  refundId: number,
  input: { state: RefundState; paypalRefundId: string | null; failureReason: string | null },
): Promise<void> {
  await db
    .prepare(
      `UPDATE paypal_refunds SET state = ?2, paypal_refund_id = COALESCE(?3, paypal_refund_id), failure_reason = ?4,
         updated_at = ${NOW}
       WHERE id = ?1 AND state IN ('requested', 'pending', 'unknown')`,
    )
    .bind(refundId, input.state, input.paypalRefundId, input.failureReason)
    .run();
}

/** Cancels an order only while it awaits payment and no PayPal capture is under way or done. */
export async function cancelUnpaidOrder(db: D1Database, orderId: number): Promise<boolean> {
  const result = await db
    .prepare(
      `UPDATE orders SET status = 'cancelled', updated_at = ${NOW}
       WHERE id = ?1 AND status = 'awaiting_payment'
         AND NOT EXISTS (
           SELECT 1 FROM paypal_payments WHERE order_id = ?1 AND state IN ('capturing', 'pending', 'completed')
         )`,
    )
    .bind(orderId)
    .run();
  return result.meta.changes === 1;
}
