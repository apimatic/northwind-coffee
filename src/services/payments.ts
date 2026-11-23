import type { CapturedPayment, Order as PaypalOrder, Refund as PaypalRefund } from "paypal";
import * as paymentsDb from "../db/payments";
import type { PaymentRow, PaymentState, RefundRow, RefundState } from "../db/payments";
import { log } from "../lib/log";
import { type Cents, parseDecimalAmount, toDecimalAmount } from "../lib/money";
import {
  approvalUrlFrom,
  classifyPaypalError,
  definitelyNotApplied,
  type Paypal,
  type PaypalFailure,
  paypalDeadline,
} from "../lib/paypal";

export type { PaymentState, RefundState };

/** A capture claim older than this is treated as abandoned and re-checked with PayPal. */
const STALE_CAPTURE_MS = 2 * 60 * 1000;

/**
 * Marks an invoice ID as this store's in the PayPal merchant account. The random part keeps IDs apart across
 * databases that number their orders independently (local, test, production) but share one merchant account.
 */
const INVOICE_ID_PREFIX = "NWC";

function newInvoiceId(orderId: number): string {
  return `${INVOICE_ID_PREFIX}-${orderId}-${crypto.randomUUID().replaceAll("-", "").slice(0, 16)}`;
}

function isUniqueViolation(error: unknown): boolean {
  return error instanceof Error && /UNIQUE constraint failed/i.test(error.message);
}

function logPaypal(
  op: "create_order" | "get_order" | "capture_order" | "get_capture" | "refund",
  orderId: number,
  outcome: string,
  failure?: PaypalFailure,
): void {
  log({
    event: "paypal",
    op,
    orderId,
    outcome,
    ...(failure && "status" in failure ? { status: failure.status } : {}),
    ...(failure && "debugId" in failure && failure.debugId ? { debugId: failure.debugId } : {}),
    ...(failure && "detail" in failure ? { detail: failure.detail } : {}),
    ...((failure?.kind === "rejected" || failure?.kind === "conflict") && failure.issue
      ? { detail: failure.issue }
      : {}),
  });
}

// ---------------------------------------------------------------------------------------------------------------
// Read model

export interface RefundInfo {
  id: number;
  amountCents: Cents;
  currency: string;
  state: RefundState;
  paypalRefundId: string | null;
  failureReason: string | null;
  createdAt: string;
}

export interface PaymentInfo {
  state: PaymentState;
  paypalOrderId: string | null;
  captureId: string | null;
  amountCents: Cents;
  currency: string;
  capturedCents: Cents | null;
  /** Refunds PayPal reported COMPLETED. */
  refundedCents: Cents;
  /** Refunds sent but not settled yet (requested, pending or unknown). */
  refundsInFlightCents: Cents;
  refundableCents: Cents;
  failureReason: string | null;
  /** Captured amount differs from the order total (the order is then not marked paid). */
  amountMismatch: boolean;
  refunds: RefundInfo[];
}

function toRefundInfo(row: RefundRow): RefundInfo {
  return {
    id: row.id,
    amountCents: row.amount_cents,
    currency: row.currency,
    state: row.state,
    paypalRefundId: row.paypal_refund_id,
    failureReason: row.failure_reason,
    createdAt: row.created_at,
  };
}

export async function getPaymentInfo(db: D1Database, orderId: number): Promise<PaymentInfo | null> {
  const payment = await paymentsDb.getPayment(db, orderId);
  if (!payment) return null;
  const refunds = (await paymentsDb.listRefunds(db, orderId)).map(toRefundInfo);
  const sum = (states: RefundState[]) =>
    refunds.filter((r) => states.includes(r.state)).reduce((total, r) => total + r.amountCents, 0);
  const refundedCents = sum(["completed"]);
  const refundsInFlightCents = sum(["requested", "pending", "unknown"]);
  const captured = payment.state === "completed" ? (payment.captured_cents ?? 0) : 0;
  return {
    state: payment.state,
    paypalOrderId: payment.paypal_order_id,
    captureId: payment.capture_id,
    amountCents: payment.amount_cents,
    currency: payment.currency,
    capturedCents: payment.captured_cents,
    refundedCents,
    refundsInFlightCents,
    refundableCents: Math.max(0, captured - refundedCents - refundsInFlightCents),
    failureReason: payment.failure_reason,
    amountMismatch: payment.captured_cents !== null && payment.captured_cents !== payment.amount_cents,
    refunds,
  };
}

/** One human label for the payment status of an order. */
export function paymentStatusLabel(payment: PaymentInfo | null): string {
  if (!payment) return "Not paid";
  switch (payment.state) {
    case "creating":
      return "Starting PayPal checkout";
    case "awaiting_approval":
      return "Waiting for PayPal approval";
    case "capturing":
      return "Confirming payment with PayPal";
    case "pending":
      return "Payment pending at PayPal";
    case "declined":
      return "Payment declined";
    case "completed": {
      const captured = payment.capturedCents ?? 0;
      if (captured > 0 && payment.refundedCents >= captured) return "Refunded";
      if (payment.refundedCents > 0) return "Partially refunded";
      return "Paid with PayPal";
    }
  }
}

// ---------------------------------------------------------------------------------------------------------------
// Starting a PayPal checkout

export type StartCheckoutResult =
  /** Send the buyer to PayPal. */
  | { kind: "redirect"; approvalUrl: string }
  /** The buyer already approved; go to our confirm page. */
  | { kind: "approved" }
  /** Payment is under way or done, or the order cannot be paid. */
  | { kind: "not_payable" }
  /** PayPal may have created the order; trying again is safe. */
  | { kind: "unknown" }
  | { kind: "failed"; failure: PaypalFailure };

type CheckoutInput = { order: PayableOrder; returnUrl: string; cancelUrl: string };

export interface PayableOrder {
  id: number;
  status: string;
  totalCents: Cents;
  currency: string;
}

/**
 * Creates (or resumes) the PayPal checkout for a store order and returns where to send the buyer.
 * The checkout claim (one row per order) is inserted before createOrder is called; the PayPal-Request-Id stored on
 * it makes a repeated createOrder return the same PayPal order.
 */
export async function startPaypalCheckout(
  db: D1Database,
  paypal: Paypal,
  input: CheckoutInput,
): Promise<StartCheckoutResult> {
  const { order } = input;
  // One wall-clock budget for every PayPal call this checkout makes (token, getOrder, createOrder).
  const signal = paypalDeadline(paypal.budgetMs);
  if (order.status !== "awaiting_payment" || order.totalCents <= 0) return { kind: "not_payable" };

  let payment = await paymentsDb.getPayment(db, order.id);
  if (!payment) {
    try {
      await paymentsDb.insertPaymentClaim(db, {
        orderId: order.id,
        requestId: crypto.randomUUID(),
        amountCents: order.totalCents,
        currency: order.currency,
      });
    } catch (error) {
      if (!isUniqueViolation(error)) throw error;
      // A concurrent click claimed it first: carry on with the winner's row.
    }
    payment = await paymentsDb.getPayment(db, order.id);
    if (!payment) throw new Error(`payment claim for order ${order.id} vanished`);
  }

  switch (payment.state) {
    case "capturing":
    case "pending":
    case "completed":
      return { kind: "not_payable" };
    case "declined":
      return restartAndCreate(db, paypal, payment, input, signal);
    case "awaiting_approval":
      return resumeApproval(db, paypal, payment, input, signal);
    case "creating":
      return createPaypalOrder(db, paypal, payment, input, signal);
  }
}

async function restartAndCreate(
  db: D1Database,
  paypal: Paypal,
  payment: PaymentRow,
  input: CheckoutInput,
  signal: AbortSignal,
): Promise<StartCheckoutResult> {
  await paymentsDb.restartPayment(db, payment.order_id, payment.request_id, crypto.randomUUID());
  const fresh = await paymentsDb.getPayment(db, payment.order_id);
  if (fresh?.state !== "creating") return { kind: "unknown" };
  return createPaypalOrder(db, paypal, fresh, input, signal);
}

async function resumeApproval(
  db: D1Database,
  paypal: Paypal,
  payment: PaymentRow,
  input: CheckoutInput,
  signal: AbortSignal,
): Promise<StartCheckoutResult> {
  const orderId = payment.order_id;
  if (!payment.paypal_order_id) return restartAndCreate(db, paypal, payment, input, signal);
  let paypalOrder: PaypalOrder;
  try {
    paypalOrder = await paypal.client.orders.getOrder({ id: payment.paypal_order_id }, { signal });
  } catch (error) {
    const failure = classifyPaypalError(error);
    logPaypal("get_order", orderId, failure.kind, failure);
    // The PayPal order expired or no longer exists: start a new one.
    if (failure.kind === "rejected" && failure.status === 404)
      return restartAndCreate(db, paypal, payment, input, signal);
    return { kind: "failed", failure };
  }
  logPaypal("get_order", orderId, "ok");
  switch (paypalOrder.status) {
    case "APPROVED":
      return { kind: "approved" };
    case "CREATED":
    case "SAVED":
    case "PAYER_ACTION_REQUIRED": {
      const approvalUrl = approvalUrlFrom(paypalOrder.links, paypal.environment);
      if (approvalUrl) return { kind: "redirect", approvalUrl };
      return restartAndCreate(db, paypal, payment, input, signal);
    }
    case "COMPLETED":
      // Captured at PayPal although we never recorded it: settle from what PayPal holds.
      await settleCaptureFromOrder(db, payment, paypalOrder);
      return { kind: "not_payable" };
    default:
      // VOIDED or anything else: this PayPal order can no longer be paid.
      return restartAndCreate(db, paypal, payment, input, signal);
  }
}

async function createPaypalOrder(
  db: D1Database,
  paypal: Paypal,
  payment: PaymentRow,
  input: { returnUrl: string; cancelUrl: string },
  signal: AbortSignal,
): Promise<StartCheckoutResult> {
  const orderId = payment.order_id;
  // One invoice ID per store order, stored before the first createOrder and reused by every later one.
  const invoiceId = await paymentsDb.ensurePaypalInvoiceId(db, orderId, newInvoiceId(orderId));
  if (!invoiceId) throw new Error(`order ${orderId} vanished while starting its PayPal checkout`);
  let created: PaypalOrder;
  try {
    created = await paypal.client.orders.createOrder(
      {
        payPalRequestId: payment.request_id,
        body: {
          intent: "CAPTURE",
          purchaseUnits: [
            {
              amount: { currencyCode: payment.currency, value: toDecimalAmount(payment.amount_cents) },
              invoiceId,
            },
          ],
          paymentSource: {
            paypal: { experienceContext: { returnUrl: input.returnUrl, cancelUrl: input.cancelUrl } },
          },
        },
      },
      { signal },
    );
  } catch (error) {
    const failure = classifyPaypalError(error);
    logPaypal("create_order", orderId, failure.kind, failure);
    if (definitelyNotApplied(failure)) {
      // PayPal did not create anything: release the claim so the next attempt starts clean.
      await paymentsDb.deletePaymentClaim(db, orderId, payment.request_id);
      return { kind: "failed", failure };
    }
    // PayPal may have created the order. The claim stays; the next attempt replays createOrder with the same
    // PayPal-Request-Id, and PayPal answers with the order it already created.
    return failure.kind === "no_response" ? { kind: "unknown" } : { kind: "failed", failure };
  }

  const approvalUrl = approvalUrlFrom(created.links, paypal.environment);
  if (!created.id || !approvalUrl) {
    logPaypal("create_order", orderId, "unusable_response");
    return { kind: "unknown" };
  }
  logPaypal("create_order", orderId, "ok");
  const recorded = await paymentsDb.recordPaypalOrder(db, orderId, payment.request_id, created.id);
  if (!recorded) {
    // Another request recorded it first (same PayPal order, thanks to the shared request id).
    const current = await paymentsDb.getPayment(db, orderId);
    if (current?.state !== "awaiting_approval" || current.paypal_order_id !== created.id) return { kind: "unknown" };
  }
  return { kind: "redirect", approvalUrl };
}

// ---------------------------------------------------------------------------------------------------------------
// Returning from PayPal and capturing

/** Checks that a buyer returning from PayPal belongs to this order's PayPal checkout. */
export async function paymentForReturn(
  db: D1Database,
  orderId: number,
  paypalOrderId: string,
): Promise<PaymentInfo | null> {
  const payment = await paymentsDb.getPayment(db, orderId);
  if (!payment || payment.paypal_order_id === null || payment.paypal_order_id !== paypalOrderId) return null;
  return getPaymentInfo(db, orderId);
}

export type CaptureResult =
  | { kind: "paid" }
  | { kind: "pending" }
  | { kind: "declined"; reason: string }
  | { kind: "unknown" }
  | { kind: "not_capturable" }
  | { kind: "failed"; failure: PaypalFailure };

function firstCapture(order: PaypalOrder) {
  for (const unit of order.purchaseUnits ?? []) {
    const capture = unit.payments?.captures?.[0];
    if (capture) return capture;
  }
  return undefined;
}

/**
 * Records a capture PayPal reports. Only a COMPLETED capture of exactly the order total marks the order paid.
 */
async function settleCapture(
  db: D1Database,
  payment: PaymentRow,
  capture: { id?: string; status?: string; amount?: { currencyCode: string; value: string } },
): Promise<CaptureResult> {
  const orderId = payment.order_id;
  if (!capture.id || !capture.status) return { kind: "unknown" };
  const capturedCents = capture.amount ? parseDecimalAmount(capture.amount.value) : null;
  const matches = capturedCents === payment.amount_cents && capture.amount?.currencyCode === payment.currency;

  switch (capture.status) {
    case "COMPLETED":
    case "PARTIALLY_REFUNDED":
    case "REFUNDED": {
      if (!matches) {
        log({
          event: "error",
          method: "PAYPAL",
          path: `/orders/${orderId}`,
          message: `captured amount ${capture.amount?.value} ${capture.amount?.currencyCode} does not match order total`,
        });
      }
      await paymentsDb.recordCapture(db, {
        orderId,
        state: "completed",
        captureId: capture.id,
        capturedCents,
        failureReason: matches ? null : "Captured amount does not match the order total.",
        markPaid: matches,
      });
      return matches ? { kind: "paid" } : { kind: "unknown" };
    }
    case "PENDING":
      await paymentsDb.recordCapture(db, {
        orderId,
        state: "pending",
        captureId: capture.id,
        capturedCents,
        failureReason: null,
        markPaid: false,
      });
      return { kind: "pending" };
    case "DECLINED":
    case "FAILED": {
      const reason = "PayPal declined the payment. You can try again with another payment method.";
      await paymentsDb.recordCapture(db, {
        orderId,
        state: "declined",
        captureId: capture.id,
        capturedCents: null,
        failureReason: reason,
        markPaid: false,
      });
      return { kind: "declined", reason };
    }
    default:
      return { kind: "unknown" };
  }
}

/** Settles a capture from a PayPal order (the capture response, or a re-read of the order). */
async function settleCaptureFromOrder(
  db: D1Database,
  payment: PaymentRow,
  paypalOrder: PaypalOrder,
): Promise<CaptureResult> {
  const capture = firstCapture(paypalOrder);
  if (capture) return settleCapture(db, payment, capture);
  if (paypalOrder.status === "APPROVED") {
    // Approved but never captured: PayPal did not act on our capture. Release the claim.
    await paymentsDb.releaseCapture(db, payment.order_id, null);
    return { kind: "unknown" };
  }
  return { kind: "unknown" };
}

/** Re-reads the PayPal order after a capture whose outcome we did not learn. */
async function settleCaptureFromPaypal(db: D1Database, paypal: Paypal, payment: PaymentRow): Promise<CaptureResult> {
  const orderId = payment.order_id;
  if (!payment.paypal_order_id) return { kind: "unknown" };
  try {
    const paypalOrder = await paypal.client.orders.getOrder(
      { id: payment.paypal_order_id },
      { signal: paypalDeadline(paypal.rereadBudgetMs) },
    );
    logPaypal("get_order", orderId, "ok");
    const result = await settleCaptureFromOrder(db, payment, paypalOrder);
    if (result.kind === "unknown") await paymentsDb.noteCaptureUnknown(db, orderId);
    return result;
  } catch (error) {
    const failure = classifyPaypalError(error);
    logPaypal("get_order", orderId, failure.kind, failure);
    return { kind: "unknown" };
  }
}

/**
 * Captures the approved PayPal payment for a store order. The capture claim (state 'capturing') is taken before
 * captureOrder is called, so a double click captures once.
 */
export async function capturePaypalPayment(db: D1Database, paypal: Paypal, orderId: number): Promise<CaptureResult> {
  const payment = await paymentsDb.getPayment(db, orderId);
  if (!payment?.paypal_order_id) return { kind: "not_capturable" };
  if (payment.state !== "awaiting_approval") return currentCaptureResult(payment);

  const claimed = await paymentsDb.claimCapture(db, orderId, payment.paypal_order_id);
  if (!claimed) {
    const current = await paymentsDb.getPayment(db, orderId);
    return current ? currentCaptureResult(current) : { kind: "not_capturable" };
  }

  let captured: PaypalOrder;
  try {
    captured = await paypal.client.orders.captureOrder(
      {
        id: payment.paypal_order_id,
        payPalRequestId: `${payment.request_id}:capture`,
        // We need the capture id, status and amount from the response.
        prefer: "return=representation",
        // PayPal refuses a capture without a JSON body (415).
        body: {},
      },
      { signal: paypalDeadline(paypal.budgetMs) },
    );
  } catch (error) {
    const failure = classifyPaypalError(error);
    logPaypal("capture_order", orderId, failure.kind, failure);
    if (definitelyNotApplied(failure)) {
      if (failure.kind === "rejected" && failure.issue === "ORDER_ALREADY_CAPTURED") {
        return settleCaptureFromPaypal(db, paypal, { ...payment, state: "capturing" });
      }
      await paymentsDb.releaseCapture(db, orderId, failure.kind === "rejected" ? failure.reason : null);
      return { kind: "failed", failure };
    }
    // PayPal may have captured: find out from PayPal before telling the buyer anything.
    return settleCaptureFromPaypal(db, paypal, { ...payment, state: "capturing" });
  }

  const capture = firstCapture(captured);
  if (!capture) {
    logPaypal("capture_order", orderId, "no_capture_in_response");
    return settleCaptureFromPaypal(db, paypal, { ...payment, state: "capturing" });
  }
  logPaypal("capture_order", orderId, "ok");
  return settleCapture(db, { ...payment, state: "capturing" }, capture);
}

function currentCaptureResult(payment: PaymentRow): CaptureResult {
  switch (payment.state) {
    case "completed":
      return payment.captured_cents === payment.amount_cents ? { kind: "paid" } : { kind: "unknown" };
    case "pending":
      return { kind: "pending" };
    case "capturing":
      return { kind: "unknown" };
    case "declined":
      return { kind: "declined", reason: payment.failure_reason ?? "PayPal declined the payment." };
    default:
      return { kind: "not_capturable" };
  }
}

/**
 * Brings a payment whose outcome is still open up to date with PayPal: a pending capture, or a capture claim
 * left behind by a request that never learned the answer. Errors are logged and leave the state unchanged.
 */
export async function reconcilePayment(db: D1Database, paypal: Paypal, orderId: number): Promise<void> {
  const payment = await paymentsDb.getPayment(db, orderId);
  if (!payment) return;
  if (payment.state === "capturing") {
    const age = Date.now() - Date.parse(payment.updated_at);
    if (age >= STALE_CAPTURE_MS) await settleCaptureFromPaypal(db, paypal, payment);
    return;
  }
  if (payment.state === "pending" && payment.capture_id) {
    let capture: CapturedPayment;
    try {
      capture = await paypal.client.payments.getCapturedPayment(
        { captureId: payment.capture_id },
        { signal: paypalDeadline(paypal.rereadBudgetMs) },
      );
    } catch (error) {
      const failure = classifyPaypalError(error);
      logPaypal("get_capture", orderId, failure.kind, failure);
      return;
    }
    logPaypal("get_capture", orderId, "ok");
    if (capture.status !== "PENDING") await settleCapture(db, payment, capture);
  }
}

// ---------------------------------------------------------------------------------------------------------------
// Refunds

export type RefundResult =
  | { kind: "completed"; refund: RefundInfo }
  | { kind: "pending"; refund: RefundInfo }
  | { kind: "unknown"; refund: RefundInfo }
  | { kind: "duplicate"; refund: RefundInfo }
  | { kind: "not_refundable" }
  | { kind: "exceeds_refundable"; refundableCents: Cents }
  | { kind: "failed"; failure: PaypalFailure };

function refundCustomId(refundId: number): string {
  return `northwind-refund-${refundId}`;
}

function refundStateFrom(status: string | undefined): RefundState | null {
  switch (status) {
    case "COMPLETED":
      return "completed";
    case "PENDING":
      return "pending";
    case "FAILED":
    case "CANCELLED":
      return "failed";
    default:
      return null;
  }
}

async function refundResult(db: D1Database, orderId: number, refundId: number): Promise<RefundResult> {
  const row = await paymentsDb.getRefund(db, orderId, refundId);
  if (!row) throw new Error(`refund ${refundId} vanished`);
  const refund = toRefundInfo(row);
  switch (row.state) {
    case "completed":
      return { kind: "completed", refund };
    case "pending":
      return { kind: "pending", refund };
    case "failed":
      return {
        kind: "failed",
        failure: {
          kind: "rejected",
          status: 422,
          reason: row.failure_reason ?? "PayPal did not complete the refund.",
          issue: undefined,
          debugId: undefined,
        },
      };
    default:
      return { kind: "unknown", refund };
  }
}

async function recordRefundFrom(db: D1Database, refundId: number, refund: PaypalRefund): Promise<boolean> {
  const state = refundStateFrom(refund.status);
  if (!refund.id || !state) return false;
  await paymentsDb.recordRefund(db, refundId, {
    state,
    paypalRefundId: refund.id,
    failureReason: state === "failed" ? `PayPal reported the refund ${refund.status}.` : null,
  });
  return true;
}

/** PayPal keeps refund PayPal-Request-Ids for 45 days; we only replay well inside that window. */
const REFUND_REPLAY_WINDOW_MS = 44 * 24 * 60 * 60 * 1000;

/** What a re-read of the PayPal order said about one refund. */
type RefundLookup = "found" | "absent" | "unreadable";

/** Looks the refund up on the PayPal order by its custom id, and records it if found. */
async function settleRefundFromPaypal(
  db: D1Database,
  paypal: Paypal,
  payment: PaymentRow,
  refundId: number,
): Promise<RefundLookup> {
  const orderId = payment.order_id;
  let found: PaypalRefund | undefined;
  let readable = false;
  if (payment.paypal_order_id) {
    try {
      const paypalOrder = await paypal.client.orders.getOrder(
        { id: payment.paypal_order_id },
        { signal: paypalDeadline(paypal.rereadBudgetMs) },
      );
      logPaypal("get_order", orderId, "ok");
      readable = true;
      const customId = refundCustomId(refundId);
      for (const unit of paypalOrder.purchaseUnits ?? []) {
        found ??= unit.payments?.refunds?.find((r) => r.customId === customId);
      }
    } catch (error) {
      const failure = classifyPaypalError(error);
      logPaypal("get_order", orderId, failure.kind, failure);
    }
  }
  if (found && (await recordRefundFrom(db, refundId, found))) return "found";
  // Not found, or PayPal could not be read: the outcome stays unknown (never "failed").
  await paymentsDb.recordRefund(db, refundId, { state: "unknown", paypalRefundId: null, failureReason: null });
  return readable && !found ? "absent" : "unreadable";
}

/**
 * Sends a claimed refund to PayPal (the first time, or as a replay with the same PayPal-Request-Id, which PayPal
 * answers with the original refund if it already made it) and records the outcome.
 */
async function sendRefund(
  db: D1Database,
  paypal: Paypal,
  payment: PaymentRow & { capture_id: string },
  claim: { id: number; refundKey: string; amountCents: Cents; replay: boolean },
): Promise<RefundResult> {
  const orderId = payment.order_id;
  let refund: PaypalRefund;
  try {
    refund = await paypal.client.payments.refundCapturedPayment(
      {
        captureId: payment.capture_id,
        payPalRequestId: claim.refundKey,
        body: {
          amount: { currencyCode: payment.currency, value: toDecimalAmount(claim.amountCents) },
          customId: refundCustomId(claim.id),
        },
      },
      { signal: paypalDeadline(paypal.budgetMs) },
    );
  } catch (error) {
    const failure = classifyPaypalError(error);
    logPaypal("refund", orderId, failure.kind, failure);
    // On a replay only an explicit refusal settles it: a 429, a credential problem or a request that never left
    // says nothing about the original attempt, so the refund stays unknown and its amount stays reserved.
    const settled = claim.replay ? failure.kind === "rejected" : definitelyNotApplied(failure);
    if (settled) {
      await paymentsDb.recordRefund(db, claim.id, {
        state: "failed",
        paypalRefundId: null,
        failureReason: failure.kind === "rejected" ? failure.reason : `Not sent to PayPal (${failure.kind}).`,
      });
      return { kind: "failed", failure };
    }
    if (definitelyNotApplied(failure)) return refundResult(db, orderId, claim.id);
    await settleRefundFromPaypal(db, paypal, payment, claim.id);
    return refundResult(db, orderId, claim.id);
  }

  if (!(await recordRefundFrom(db, claim.id, refund))) {
    logPaypal("refund", orderId, "unusable_response");
    await settleRefundFromPaypal(db, paypal, payment, claim.id);
  } else {
    logPaypal("refund", orderId, "ok");
  }
  return refundResult(db, orderId, claim.id);
}

/**
 * Refunds a captured PayPal payment, in full (amountCents null: everything still refundable) or in part.
 * The refund claim is inserted, with the refundable amount checked in the same statement, before PayPal is called.
 */
export async function refundPaypalPayment(
  db: D1Database,
  paypal: Paypal,
  input: { orderId: number; refundKey: string; amountCents: Cents | null; requestedByUserId: number },
): Promise<RefundResult> {
  const { orderId, refundKey } = input;
  const existing = await paymentsDb.getRefundByKey(db, orderId, refundKey);
  if (existing) return { kind: "duplicate", refund: toRefundInfo(existing) };

  const payment = await paymentsDb.getPayment(db, orderId);
  const info = await getPaymentInfo(db, orderId);
  if (!payment || !info || payment.state !== "completed" || !payment.capture_id) return { kind: "not_refundable" };

  const amountCents = input.amountCents ?? info.refundableCents;
  if (amountCents <= 0 || amountCents > info.refundableCents) {
    return { kind: "exceeds_refundable", refundableCents: info.refundableCents };
  }

  let refundId: number | null;
  try {
    refundId = await paymentsDb.insertRefundClaim(db, {
      orderId,
      refundKey,
      amountCents,
      requestedByUserId: input.requestedByUserId,
    });
  } catch (error) {
    if (!isUniqueViolation(error)) throw error;
    const winner = await paymentsDb.getRefundByKey(db, orderId, refundKey);
    if (!winner) throw error;
    return { kind: "duplicate", refund: toRefundInfo(winner) };
  }
  if (refundId === null) {
    const latest = await getPaymentInfo(db, orderId);
    return { kind: "exceeds_refundable", refundableCents: latest?.refundableCents ?? 0 };
  }

  return sendRefund(
    db,
    paypal,
    { ...payment, capture_id: payment.capture_id },
    {
      id: refundId,
      refundKey,
      amountCents,
      replay: false,
    },
  );
}

/**
 * Re-checks a refund whose outcome is pending or unknown. An unknown refund that PayPal's order shows no trace of
 * is re-sent with its original PayPal-Request-Id: PayPal returns the original refund if it did make it, and makes
 * it now if it did not, so it is never refunded twice.
 */
export async function recheckRefund(
  db: D1Database,
  paypal: Paypal,
  orderId: number,
  refundId: number,
): Promise<RefundResult | null> {
  const row = await paymentsDb.getRefund(db, orderId, refundId);
  const payment = await paymentsDb.getPayment(db, orderId);
  if (!row || !payment) return null;
  if (row.state !== "pending" && row.state !== "unknown" && row.state !== "requested") {
    return refundResult(db, orderId, refundId);
  }
  const lookup = await settleRefundFromPaypal(db, paypal, payment, refundId);
  const withinWindow = Date.now() - Date.parse(row.created_at) < REFUND_REPLAY_WINDOW_MS;
  if (row.state === "unknown" && lookup === "absent" && withinWindow && payment.capture_id) {
    return sendRefund(
      db,
      paypal,
      { ...payment, capture_id: payment.capture_id },
      { id: row.id, refundKey: row.refund_key, amountCents: row.amount_cents, replay: true },
    );
  }
  return refundResult(db, orderId, refundId);
}
