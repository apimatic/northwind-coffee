/**
 * PayPal payments for orders: start a checkout, capture on return, refunds, and reconciliation.
 *
 * Rules:
 * - An order is marked paid only after PayPal reports the capture COMPLETED for exactly the order
 *   total and currency.
 * - A capture is "claimed" in the database before calling PayPal, so an order can't be cancelled
 *   (or captured twice) while a capture is in flight.
 * - PayPal calls that change money use idempotency keys (PayPal-Request-Id) stored in D1, so a call
 *   whose outcome is unknown (timeout, 5xx) can be retried safely.
 */
import { z } from "zod";
import * as paymentsDb from "../db/payments";
import type { PaymentRow, RefundRow } from "../db/payments";
import type { Cents } from "../lib/money";
import { PayPalApiError, type PayPalCapture, type PayPalClient, type PayPalOrder } from "../lib/paypal";
import { log } from "../lib/log";
import type { OrderSummary } from "./orders";

export type PaymentStatus = "created" | "capturing" | "pending" | "captured" | "failed" | "voided";
export type RefundStatus = "requested" | "pending" | "completed" | "failed";

export interface Payment {
  id: number;
  orderId: number;
  provider: string;
  providerOrderId: string;
  status: PaymentStatus;
  amountCents: Cents;
  currency: string;
  captureId: string | null;
  capturedCents: Cents;
  failureReason: string | null;
  createdAt: string;
  updatedAt: string;
}

export interface Refund {
  id: number;
  paymentId: number;
  orderId: number;
  requestKey: string;
  providerRefundId: string | null;
  status: RefundStatus;
  amountCents: Cents;
  currency: string;
  note: string;
  failureReason: string | null;
  createdByEmail: string | null;
  createdAt: string;
}

export interface PaymentSummary {
  /** All PayPal attempts, newest first. */
  payments: Payment[];
  refunds: Refund[];
  /** The attempt that is capturing, pending or captured (at most one), if any. */
  active: Payment | null;
  capturedCents: Cents;
  /** Completed refunds. */
  refundedCents: Cents;
  /** Captured amount not yet refunded or reserved by a refund in progress. */
  refundableCents: Cents;
  /** The buyer can start a PayPal checkout now. */
  canPay: boolean;
  /** The order can be cancelled (no money captured or in flight). */
  canCancel: boolean;
  /** Something is waiting on PayPal and can be re-checked. */
  needsSync: boolean;
  /** The most recent attempt failed (declined). */
  lastAttemptFailed: boolean;
}

function toPayment(row: PaymentRow): Payment {
  return {
    id: row.id,
    orderId: row.order_id,
    provider: row.provider,
    providerOrderId: row.provider_order_id,
    status: row.status as PaymentStatus,
    amountCents: row.amount_cents,
    currency: row.currency,
    captureId: row.capture_id,
    capturedCents: row.captured_cents,
    failureReason: row.failure_reason,
    createdAt: row.created_at,
    updatedAt: row.updated_at,
  };
}

function toRefund(row: RefundRow): Refund {
  return {
    id: row.id,
    paymentId: row.payment_id,
    orderId: row.order_id,
    requestKey: row.request_key,
    providerRefundId: row.provider_refund_id,
    status: row.status as RefundStatus,
    amountCents: row.amount_cents,
    currency: row.currency,
    note: row.note,
    failureReason: row.failure_reason,
    createdByEmail: row.created_by_email,
    createdAt: row.created_at,
  };
}

const ACTIVE: readonly PaymentStatus[] = ["capturing", "pending", "captured"];

export async function getPaymentSummary(
  db: D1Database,
  order: Pick<OrderSummary, "id" | "status" | "totalCents">,
): Promise<PaymentSummary> {
  const [paymentRows, refundRows] = await Promise.all([
    paymentsDb.listPaymentsForOrder(db, order.id),
    paymentsDb.listRefundsForOrder(db, order.id),
  ]);
  const payments = paymentRows.map(toPayment);
  const refunds = refundRows.map(toRefund);
  const active = payments.find((p) => ACTIVE.includes(p.status)) ?? null;
  const capturedCents = active?.status === "captured" ? active.capturedCents : 0;
  const sum = (statuses: RefundStatus[]) =>
    refunds.filter((r) => statuses.includes(r.status)).reduce((total, r) => total + r.amountCents, 0);
  const refundedCents = sum(["completed"]);
  const refundableCents = Math.max(0, capturedCents - sum(["requested", "pending", "completed"]));
  const awaiting = order.status === "awaiting_payment";
  return {
    payments,
    refunds,
    active,
    capturedCents,
    refundedCents,
    refundableCents,
    canPay: awaiting && active === null && order.totalCents > 0,
    canCancel: awaiting && active === null,
    needsSync:
      active?.status === "capturing" ||
      active?.status === "pending" ||
      refunds.some((r) => r.status === "requested" || r.status === "pending"),
    lastAttemptFailed: active === null && payments[0]?.status === "failed",
  };
}

function isUniqueViolation(error: unknown): boolean {
  return error instanceof Error && /UNIQUE constraint failed/i.test(error.message);
}

function logPayment(entry: { action: string; orderId: number; outcome: string; providerOrderId?: string }): void {
  log({ event: "payment", ...entry });
}

function logProviderError(action: string, orderId: number, error: unknown): void {
  const err = error instanceof Error ? error : new Error(String(error));
  log({
    event: "payment_error",
    action,
    orderId,
    name: err.name,
    message: err.message,
    ...(error instanceof PayPalApiError ? { status: error.status, issue: error.issue, debugId: error.debugId } : {}),
  });
}

// ---------------------------------------------------------------------------------------------
// Checkout

export type StartCheckoutResult =
  { ok: true; approveUrl: string } | { ok: false; reason: "not_payable" | "in_progress" | "provider_error" };

/** Creates a PayPal order for the order total and returns the URL where the buyer approves it. */
export async function startPayPalCheckout(
  db: D1Database,
  paypal: PayPalClient,
  input: { order: OrderSummary; origin: string },
): Promise<StartCheckoutResult> {
  const { order } = input;
  const summary = await getPaymentSummary(db, order);
  if (!summary.canPay) {
    return { ok: false, reason: order.status === "awaiting_payment" && summary.active ? "in_progress" : "not_payable" };
  }

  let created: PayPalOrder;
  try {
    created = await paypal.createOrder({
      requestId: crypto.randomUUID(),
      referenceId: `order-${order.id}`,
      description: `Northwind Coffee order #${order.id}`,
      amountCents: order.totalCents,
      currency: order.currency,
      returnUrl: `${input.origin}/orders/${order.id}/paypal/return`,
      cancelUrl: `${input.origin}/orders/${order.id}/paypal/cancel`,
    });
    if (!created.approveUrl) throw new Error(`PayPal order ${created.id} (${created.status}) has no approval link`);
  } catch (error) {
    logProviderError("create_order", order.id, error);
    return { ok: false, reason: "provider_error" };
  }
  await paymentsDb.insertPayment(db, {
    orderId: order.id,
    providerOrderId: created.id,
    amountCents: order.totalCents,
    currency: order.currency,
  });
  logPayment({ action: "create_order", orderId: order.id, outcome: "created", providerOrderId: created.id });
  return { ok: true, approveUrl: created.approveUrl };
}

/** PayPal order ids are short upper-case alphanumerics. */
export const paypalTokenSchema = z.string().regex(/^[A-Z0-9]{8,40}$/);

export type ReturnOutcome =
  "paid" | "pending" | "declined" | "not_approved" | "not_payable" | "in_progress" | "unknown" | "error";

/**
 * Handles the buyer coming back from PayPal after approving: captures the payment and marks the
 * order paid once PayPal confirms the capture. Safe to call repeatedly (page refresh, double click).
 */
export async function completePayPalReturn(
  db: D1Database,
  paypal: PayPalClient,
  input: { orderId: number; token: string },
): Promise<ReturnOutcome> {
  const row = await paymentsDb.findPayment(db, input.orderId, input.token);
  if (!row) return "unknown";
  const payment = toPayment(row);
  switch (payment.status) {
    case "captured":
      return payment.capturedCents === payment.amountCents ? "paid" : "error";
    case "pending":
      return "pending";
    case "failed":
      return "declined";
    default:
      break;
  }

  let claimed: PaymentRow | null;
  try {
    claimed = await paymentsDb.claimPaymentForCapture(db, payment.id, crypto.randomUUID());
  } catch (error) {
    if (!isUniqueViolation(error)) throw error;
    claimed = null;
  }
  if (!claimed) {
    const others = await paymentsDb.listPaymentsForOrder(db, input.orderId);
    const outcome = others.some((p) => ACTIVE.includes(p.status as PaymentStatus)) ? "in_progress" : "not_payable";
    logPayment({ action: "capture", orderId: input.orderId, outcome, providerOrderId: payment.providerOrderId });
    return outcome;
  }
  return captureClaimed(db, paypal, claimed);
}

const NOT_APPROVED_ISSUES = new Set(["ORDER_NOT_APPROVED", "PAYER_ACTION_REQUIRED"]);

/** Captures a payment already claimed (status `capturing`), reusing its stored idempotency key. */
async function captureClaimed(db: D1Database, paypal: PayPalClient, row: PaymentRow): Promise<ReturnOutcome> {
  const payment = toPayment(row);
  if (!row.capture_request_id) throw new Error(`Payment ${row.id} is capturing without a request id`);
  let result: PayPalOrder;
  try {
    result = await paypal.captureOrder(payment.providerOrderId, row.capture_request_id);
  } catch (error) {
    if (error instanceof PayPalApiError && error.issue === "ORDER_ALREADY_CAPTURED") {
      try {
        result = await paypal.getOrder(payment.providerOrderId);
      } catch (lookupError) {
        logProviderError("capture_lookup", payment.orderId, lookupError);
        return "error";
      }
    } else if (error instanceof PayPalApiError && error.isDefinitive) {
      logProviderError("capture", payment.orderId, error);
      if (error.issue && NOT_APPROVED_ISSUES.has(error.issue)) {
        await paymentsDb.releaseCaptureClaim(db, payment.id);
        return "not_approved";
      }
      await paymentsDb.markPaymentFailed(db, payment.id, error.issue ?? error.errorName);
      return "declined";
    } else {
      // Unknown outcome (timeout, 5xx). Keep the claim; retrying reuses the same PayPal-Request-Id.
      logProviderError("capture", payment.orderId, error);
      return "error";
    }
  }
  const capture = result.captures[0];
  if (!capture) {
    logProviderError(
      "capture",
      payment.orderId,
      new Error(`PayPal order ${result.id} (${result.status}) has no capture`),
    );
    return "error";
  }
  return applyCapture(db, payment, capture);
}

async function applyCapture(db: D1Database, payment: Payment, capture: PayPalCapture): Promise<ReturnOutcome> {
  const base = { orderId: payment.orderId, providerOrderId: payment.providerOrderId };
  switch (capture.status) {
    case "COMPLETED":
    case "PARTIALLY_REFUNDED":
    case "REFUNDED": {
      const amountMatches = capture.amountCents === payment.amountCents && capture.currency === payment.currency;
      await paymentsDb.markPaymentCaptured(db, payment, capture.id, capture.amountCents ?? 0, amountMatches);
      if (!amountMatches) {
        // Money moved but not for the order total: never mark the order paid; staff must review.
        logProviderError(
          "capture",
          payment.orderId,
          new Error(
            `Captured ${capture.amountCents} ${capture.currency}, expected ${payment.amountCents} ${payment.currency}`,
          ),
        );
        return "error";
      }
      logPayment({ action: "capture", ...base, outcome: "paid" });
      return "paid";
    }
    case "PENDING":
      await paymentsDb.markPaymentPending(db, payment.id, capture.id);
      logPayment({ action: "capture", ...base, outcome: "pending" });
      return "pending";
    case "DECLINED":
    case "FAILED":
      await paymentsDb.markPaymentFailed(db, payment.id, `CAPTURE_${capture.status}`);
      logPayment({ action: "capture", ...base, outcome: "declined" });
      return "declined";
    default:
      logProviderError("capture", payment.orderId, new Error(`Unexpected capture status ${capture.status}`));
      return "error";
  }
}

/** The buyer cancelled on PayPal: abandon that attempt (nothing was charged). */
export async function cancelPayPalReturn(db: D1Database, input: { orderId: number; token: string }): Promise<void> {
  const row = await paymentsDb.findPayment(db, input.orderId, input.token);
  if (!row) return;
  await paymentsDb.voidPayment(db, row.id);
  logPayment({
    action: "buyer_cancel",
    orderId: input.orderId,
    outcome: "voided",
    providerOrderId: row.provider_order_id,
  });
}

// ---------------------------------------------------------------------------------------------
// Refunds

export const REFUND_NOTE_MAX = 255;

export type RefundResult =
  | { ok: true; status: "completed" | "pending" }
  | {
      ok: false;
      reason: "not_refundable" | "exceeds_refundable" | "provider_refused" | "provider_unavailable";
      issue?: string;
    };

/**
 * Refunds part or all of an order's captured payment. `requestKey` (issued with the refund form)
 * makes this idempotent: resubmitting the same form never refunds twice.
 */
export async function refundOrder(
  db: D1Database,
  paypal: PayPalClient,
  input: { orderId: number; amountCents: Cents; note: string; requestKey: string; userId: number },
): Promise<RefundResult> {
  let row = await paymentsDb.findRefundByKey(db, input.requestKey);
  if (row && row.order_id !== input.orderId) return { ok: false, reason: "not_refundable" };
  if (row) {
    if (row.status === "completed" || row.status === "pending") return { ok: true, status: row.status };
    if (row.status === "failed") {
      return { ok: false, reason: "provider_refused", ...(row.failure_reason ? { issue: row.failure_reason } : {}) };
    }
    // "requested": the earlier attempt's outcome is unknown; retry with the same key below.
  } else {
    if (input.amountCents <= 0) return { ok: false, reason: "exceeds_refundable" };
    try {
      row = await paymentsDb.reserveRefund(db, input);
    } catch (error) {
      if (!isUniqueViolation(error)) throw error;
      // A concurrent submission of the same form reserved it first.
      return refundOrder(db, paypal, input);
    }
    if (!row) {
      const payments = await paymentsDb.listPaymentsForOrder(db, input.orderId);
      const captured = payments.some((p) => p.status === "captured");
      return { ok: false, reason: captured ? "exceeds_refundable" : "not_refundable" };
    }
  }
  return sendRefund(db, paypal, toRefund(row));
}

async function sendRefund(db: D1Database, paypal: PayPalClient, refund: Refund): Promise<RefundResult> {
  const payment = await paymentsDb.getPayment(db, refund.paymentId);
  if (!payment?.capture_id) throw new Error(`Refund ${refund.id} has no captured payment`);
  try {
    const result = await paypal.refundCapture({
      captureId: payment.capture_id,
      requestId: refund.requestKey,
      amountCents: refund.amountCents,
      currency: refund.currency,
      ...(refund.note ? { noteToPayer: refund.note } : {}),
    });
    return applyRefundStatus(db, refund, result.id, result.status);
  } catch (error) {
    logProviderError("refund", refund.orderId, error);
    if (error instanceof PayPalApiError && error.isDefinitive) {
      const issue = error.issue ?? error.errorName;
      await paymentsDb.updateRefund(db, refund, { status: "failed", providerRefundId: null, failureReason: issue });
      return { ok: false, reason: "provider_refused", issue };
    }
    return { ok: false, reason: "provider_unavailable" };
  }
}

async function applyRefundStatus(
  db: D1Database,
  refund: Refund,
  providerRefundId: string,
  status: string,
): Promise<RefundResult> {
  const mapped = status === "COMPLETED" ? "completed" : status === "PENDING" ? "pending" : "failed";
  await paymentsDb.updateRefund(db, refund, {
    status: mapped,
    providerRefundId,
    failureReason: mapped === "failed" ? `REFUND_${status}` : null,
  });
  logPayment({ action: "refund", orderId: refund.orderId, outcome: mapped });
  if (mapped === "failed") return { ok: false, reason: "provider_refused", issue: `REFUND_${status}` };
  return { ok: true, status: mapped };
}

// ---------------------------------------------------------------------------------------------
// Reconciliation

/**
 * Re-checks with PayPal anything left waiting on it for this order: a capture whose outcome was
 * unknown, a pending capture, and refunds that are requested or pending. Returns true if anything
 * changed.
 */
export async function syncOrderPayments(db: D1Database, paypal: PayPalClient, orderId: number): Promise<boolean> {
  const before = JSON.stringify(await snapshot(db, orderId));
  for (const row of await paymentsDb.listPaymentsForOrder(db, orderId)) {
    const payment = toPayment(row);
    if (payment.status === "capturing") {
      await captureClaimed(db, paypal, row);
    } else if (payment.status === "pending" && payment.captureId) {
      try {
        const capture = await paypal.getCapture(payment.captureId);
        if (capture.status !== "PENDING") await applyCapture(db, payment, capture);
      } catch (error) {
        logProviderError("sync_capture", orderId, error);
      }
    }
  }
  const refunds = (await paymentsDb.listRefundsForOrder(db, orderId)).map(toRefund);
  for (const refund of refunds) {
    if (refund.status === "requested") {
      await sendRefund(db, paypal, refund);
    } else if (refund.status === "pending" && refund.providerRefundId) {
      try {
        const result = await paypal.getRefund(refund.providerRefundId);
        if (result.status !== "PENDING") await applyRefundStatus(db, refund, result.id, result.status);
      } catch (error) {
        logProviderError("sync_refund", orderId, error);
      }
    }
  }
  return JSON.stringify(await snapshot(db, orderId)) !== before;
}

async function snapshot(db: D1Database, orderId: number) {
  const [payments, refunds] = await Promise.all([
    paymentsDb.listPaymentsForOrder(db, orderId),
    paymentsDb.listRefundsForOrder(db, orderId),
  ]);
  return [payments.map((p) => [p.id, p.status]), refunds.map((r) => [r.id, r.status])];
}
