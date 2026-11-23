export interface PaymentRow {
  id: number;
  order_id: number;
  provider: string;
  provider_order_id: string;
  status: string;
  amount_cents: number;
  currency: string;
  capture_request_id: string | null;
  capture_id: string | null;
  captured_cents: number;
  failure_reason: string | null;
  created_at: string;
  updated_at: string;
}

export interface RefundRow {
  id: number;
  payment_id: number;
  order_id: number;
  request_key: string;
  provider_refund_id: string | null;
  status: string;
  amount_cents: number;
  currency: string;
  note: string;
  failure_reason: string | null;
  created_by_email: string | null;
  created_at: string;
  updated_at: string;
}

const NOW = "strftime('%Y-%m-%dT%H:%M:%fZ', 'now')";
const PAYMENT_COLUMNS = `id, order_id, provider, provider_order_id, status, amount_cents, currency, capture_request_id,
  capture_id, captured_cents, failure_reason, created_at, updated_at`;
const REFUND_SELECT = `SELECT r.id, r.payment_id, r.order_id, r.request_key, r.provider_refund_id, r.status,
  r.amount_cents, r.currency, r.note, r.failure_reason, u.email AS created_by_email, r.created_at, r.updated_at
  FROM refunds r LEFT JOIN users u ON u.id = r.created_by_user_id`;

/** Sets the order's status from its completed refunds; only for orders that have been paid. */
function recomputeRefundStatus(db: D1Database, orderId: number): D1PreparedStatement {
  const refunded = "(SELECT COALESCE(SUM(amount_cents), 0) FROM refunds WHERE order_id = ?1 AND status = 'completed')";
  const captured =
    "(SELECT COALESCE(SUM(captured_cents), 0) FROM payments WHERE order_id = ?1 AND status = 'captured')";
  return db
    .prepare(
      `UPDATE orders SET
         status = CASE WHEN ${refunded} >= ${captured} THEN 'refunded'
                       WHEN ${refunded} > 0 THEN 'partially_refunded'
                       ELSE 'paid' END,
         updated_at = ${NOW}
       WHERE id = ?1 AND status IN ('paid', 'partially_refunded', 'refunded')`,
    )
    .bind(orderId);
}

export async function insertPayment(
  db: D1Database,
  input: { orderId: number; providerOrderId: string; amountCents: number; currency: string },
): Promise<void> {
  await db
    .prepare(
      `INSERT INTO payments (order_id, provider, provider_order_id, status, amount_cents, currency)
       VALUES (?1, 'paypal', ?2, 'created', ?3, ?4)`,
    )
    .bind(input.orderId, input.providerOrderId, input.amountCents, input.currency)
    .run();
}

export async function listPaymentsForOrder(db: D1Database, orderId: number): Promise<PaymentRow[]> {
  const { results } = await db
    .prepare(`SELECT ${PAYMENT_COLUMNS} FROM payments WHERE order_id = ?1 ORDER BY created_at DESC, id DESC`)
    .bind(orderId)
    .all<PaymentRow>();
  return results;
}

export async function findPayment(
  db: D1Database,
  orderId: number,
  providerOrderId: string,
): Promise<PaymentRow | null> {
  return db
    .prepare(`SELECT ${PAYMENT_COLUMNS} FROM payments WHERE order_id = ?1 AND provider_order_id = ?2`)
    .bind(orderId, providerOrderId)
    .first<PaymentRow>();
}

export async function getPayment(db: D1Database, paymentId: number): Promise<PaymentRow | null> {
  return db.prepare(`SELECT ${PAYMENT_COLUMNS} FROM payments WHERE id = ?1`).bind(paymentId).first<PaymentRow>();
}

/**
 * Claims a payment for capture: only if its order is still awaiting payment and no other attempt
 * for the order is capturing, pending or captured. A fresh claim gets `requestId` as its capture
 * idempotency key; re-claiming a payment already in `capturing` keeps the original key.
 * Returns the claimed row, or null if it could not be claimed.
 */
export async function claimPaymentForCapture(
  db: D1Database,
  paymentId: number,
  requestId: string,
): Promise<PaymentRow | null> {
  return db
    .prepare(
      `UPDATE payments SET
         capture_request_id = CASE WHEN status = 'capturing' THEN capture_request_id ELSE ?2 END,
         status = 'capturing', failure_reason = NULL, updated_at = ${NOW}
       WHERE id = ?1 AND status IN ('created', 'voided', 'capturing')
         AND EXISTS (SELECT 1 FROM orders o WHERE o.id = payments.order_id AND o.status = 'awaiting_payment')
         AND NOT EXISTS (SELECT 1 FROM payments other WHERE other.order_id = payments.order_id
                         AND other.id <> payments.id AND other.status IN ('capturing', 'pending', 'captured'))
       RETURNING ${PAYMENT_COLUMNS}`,
    )
    .bind(paymentId, requestId)
    .first<PaymentRow>();
}

/** Records a completed capture; when `markOrderPaid`, also moves the order from awaiting payment to paid. */
export async function markPaymentCaptured(
  db: D1Database,
  payment: { id: number; orderId: number },
  captureId: string,
  capturedCents: number,
  markOrderPaid: boolean,
): Promise<boolean> {
  const statements = [
    db
      .prepare(
        `UPDATE payments SET status = 'captured', capture_id = ?2, captured_cents = ?3, failure_reason = NULL,
           updated_at = ${NOW}
         WHERE id = ?1 AND status IN ('capturing', 'pending')`,
      )
      .bind(payment.id, captureId, capturedCents),
  ];
  if (markOrderPaid) {
    statements.push(
      db
        .prepare(
          `UPDATE orders SET status = 'paid', updated_at = ${NOW}
           WHERE id = ?1 AND status = 'awaiting_payment'
             AND EXISTS (SELECT 1 FROM payments WHERE id = ?2 AND status = 'captured' AND capture_id = ?3)`,
        )
        .bind(payment.orderId, payment.id, captureId),
    );
  }
  const results = await db.batch(statements);
  return (results[0]?.meta.changes ?? 0) === 1;
}

export async function markPaymentPending(db: D1Database, paymentId: number, captureId: string): Promise<boolean> {
  const result = await db
    .prepare(
      `UPDATE payments SET status = 'pending', capture_id = ?2, updated_at = ${NOW}
       WHERE id = ?1 AND status = 'capturing'`,
    )
    .bind(paymentId, captureId)
    .run();
  return result.meta.changes === 1;
}

export async function markPaymentFailed(db: D1Database, paymentId: number, reason: string): Promise<boolean> {
  const result = await db
    .prepare(
      `UPDATE payments SET status = 'failed', failure_reason = ?2, updated_at = ${NOW}
       WHERE id = ?1 AND status IN ('capturing', 'pending')`,
    )
    .bind(paymentId, reason)
    .run();
  return result.meta.changes === 1;
}

/** Gives up a capture claim (the buyer had not approved yet), so the attempt can be retried. */
export async function releaseCaptureClaim(db: D1Database, paymentId: number): Promise<void> {
  await db
    .prepare(`UPDATE payments SET status = 'created', updated_at = ${NOW} WHERE id = ?1 AND status = 'capturing'`)
    .bind(paymentId)
    .run();
}

export async function voidPayment(db: D1Database, paymentId: number): Promise<void> {
  await db
    .prepare(`UPDATE payments SET status = 'voided', updated_at = ${NOW} WHERE id = ?1 AND status = 'created'`)
    .bind(paymentId)
    .run();
}

/** Cancels an order only while it awaits payment and has no capture in progress, pending or done. */
export async function cancelUnpaidOrder(db: D1Database, orderId: number): Promise<boolean> {
  const result = await db
    .prepare(
      `UPDATE orders SET status = 'cancelled', updated_at = ${NOW}
       WHERE id = ?1 AND status = 'awaiting_payment'
         AND NOT EXISTS (SELECT 1 FROM payments WHERE order_id = ?1 AND status IN ('capturing', 'pending', 'captured'))`,
    )
    .bind(orderId)
    .run();
  return result.meta.changes === 1;
}

/**
 * Reserves a refund against the order's captured payment, only if the amount fits in what has not
 * already been refunded or reserved. Returns the new refund row, or null if it does not fit.
 */
export async function reserveRefund(
  db: D1Database,
  input: { orderId: number; requestKey: string; amountCents: number; note: string; userId: number },
): Promise<RefundRow | null> {
  const inserted = await db
    .prepare(
      `INSERT INTO refunds (payment_id, order_id, request_key, status, amount_cents, currency, note, created_by_user_id)
       SELECT p.id, p.order_id, ?2, 'requested', ?3, p.currency, ?4, ?5
       FROM payments p
       WHERE p.order_id = ?1 AND p.status = 'captured'
         AND p.captured_cents - (SELECT COALESCE(SUM(r.amount_cents), 0) FROM refunds r
                                 WHERE r.payment_id = p.id AND r.status IN ('requested', 'pending', 'completed')) >= ?3
       RETURNING id`,
    )
    .bind(input.orderId, input.requestKey, input.amountCents, input.note, input.userId)
    .first<{ id: number }>();
  return inserted ? getRefund(db, inserted.id) : null;
}

export async function getRefund(db: D1Database, refundId: number): Promise<RefundRow | null> {
  return db.prepare(`${REFUND_SELECT} WHERE r.id = ?1`).bind(refundId).first<RefundRow>();
}

export async function findRefundByKey(db: D1Database, requestKey: string): Promise<RefundRow | null> {
  return db.prepare(`${REFUND_SELECT} WHERE r.request_key = ?1`).bind(requestKey).first<RefundRow>();
}

export async function listRefundsForOrder(db: D1Database, orderId: number): Promise<RefundRow[]> {
  const { results } = await db
    .prepare(`${REFUND_SELECT} WHERE r.order_id = ?1 ORDER BY r.created_at DESC, r.id DESC`)
    .bind(orderId)
    .all<RefundRow>();
  return results;
}

/** Records PayPal's answer for a refund and updates the order's refund status, together. */
export async function updateRefund(
  db: D1Database,
  refund: { id: number; orderId: number },
  update: { status: "pending" | "completed" | "failed"; providerRefundId: string | null; failureReason: string | null },
): Promise<void> {
  await db.batch([
    db
      .prepare(
        `UPDATE refunds SET status = ?2, provider_refund_id = COALESCE(?3, provider_refund_id), failure_reason = ?4,
           updated_at = ${NOW}
         WHERE id = ?1 AND status IN ('requested', 'pending')`,
      )
      .bind(refund.id, update.status, update.providerRefundId, update.failureReason),
    recomputeRefundStatus(db, refund.orderId),
  ]);
}
