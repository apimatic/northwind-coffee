import { toDecimalAmount } from "../lib/money";
import type { OrderSummary } from "../services/orders";
import { type PaymentInfo, paymentStatusLabel, type RefundInfo, type RefundState } from "../services/payments";
import { Alert, CsrfField, formatDate, Money } from "./components";

const REFUND_STATE_LABELS: Record<RefundState, string> = {
  requested: "Sent to PayPal",
  pending: "Pending at PayPal",
  completed: "Refunded",
  failed: "Failed",
  unknown: "Being confirmed with PayPal",
};

/** Whether the buyer can (re)start paying for this order with PayPal. */
export function canPayWithPaypal(order: Pick<OrderSummary, "status">, payment: PaymentInfo | null): boolean {
  if (order.status !== "awaiting_payment") return false;
  return payment === null || ["creating", "awaiting_approval", "declined"].includes(payment.state);
}

export function PayWithPaypalForm(props: { orderId: number; csrfToken: string; label?: string }) {
  return (
    <form method="post" action={`/orders/${props.orderId}/pay`} class="order-actions" data-disable-on-submit>
      <CsrfField token={props.csrfToken} />
      <button type="submit" class="button" data-testid="pay-with-paypal">
        {props.label ?? "Pay with PayPal"}
      </button>
    </form>
  );
}

/** Customer-facing explanation of where the payment stands. */
export function PaymentStatusNote(props: { payment: PaymentInfo | null }) {
  const { payment } = props;
  if (!payment || payment.state === "creating" || payment.state === "awaiting_approval") {
    return (
      <p data-testid="payment-note">
        Pay securely with PayPal. You'll approve the payment on PayPal and come back here.
      </p>
    );
  }
  switch (payment.state) {
    case "capturing":
      return (
        <p data-testid="payment-note">
          We're confirming your payment with PayPal. This page will show the result once PayPal confirms it.
        </p>
      );
    case "pending":
      return (
        <p data-testid="payment-note">
          PayPal is still processing your payment. We'll ship your order once PayPal completes it.
        </p>
      );
    case "declined":
      return (
        <p data-testid="payment-note">
          {payment.failureReason ?? "PayPal declined the payment."} You can try again with PayPal.
        </p>
      );
    case "completed":
      return null;
  }
}

function RefundsTable(props: { orderId: number; refunds: RefundInfo[]; csrfToken: string }) {
  return (
    <table class="data-table" data-testid="refunds-table">
      <caption>Refunds</caption>
      <thead>
        <tr>
          <th scope="col">Requested</th>
          <th scope="col" class="num">
            Amount
          </th>
          <th scope="col">Status</th>
          <th scope="col">PayPal refund</th>
        </tr>
      </thead>
      <tbody>
        {props.refunds.map((refund) => (
          <tr data-testid="refund-row">
            <td data-label="Requested">{formatDate(refund.createdAt)}</td>
            <td class="num" data-label="Amount">
              <Money cents={refund.amountCents} currency={refund.currency} />
            </td>
            <td data-label="Status">
              {REFUND_STATE_LABELS[refund.state]}
              {refund.failureReason ? <span class="muted"> ({refund.failureReason})</span> : null}
              {refund.state === "pending" || refund.state === "unknown" ? (
                <form
                  method="post"
                  action={`/admin/orders/${props.orderId}/refunds/${refund.id}/check`}
                  class="inline-form"
                  data-disable-on-submit
                >
                  <CsrfField token={props.csrfToken} />
                  <button type="submit" class="button button-secondary">
                    Check refund status
                  </button>
                </form>
              ) : null}
            </td>
            <td data-label="PayPal refund">{refund.paypalRefundId ?? "—"}</td>
          </tr>
        ))}
      </tbody>
    </table>
  );
}

/** Admin payment panel: status, PayPal references, refunds and the refund form. */
export function AdminPaymentPanel(props: {
  orderId: number;
  payment: PaymentInfo | null;
  csrfToken: string;
  refundKey: string;
  refundAmount?: string;
  refundError?: string;
}) {
  const { payment } = props;
  return (
    <section class="card payment-panel" aria-labelledby="payment-heading">
      <h2 id="payment-heading">Payment</h2>
      <dl class="meta-list">
        <div>
          <dt>Payment status</dt>
          <dd data-testid="admin-payment-status">{paymentStatusLabel(payment)}</dd>
        </div>
        {payment?.paypalOrderId ? (
          <div>
            <dt>PayPal order</dt>
            <dd>{payment.paypalOrderId}</dd>
          </div>
        ) : null}
        {payment?.captureId ? (
          <div>
            <dt>PayPal capture</dt>
            <dd>{payment.captureId}</dd>
          </div>
        ) : null}
        {payment?.capturedCents != null ? (
          <div>
            <dt>Captured</dt>
            <dd>
              <Money cents={payment.capturedCents} currency={payment.currency} />
            </dd>
          </div>
        ) : null}
        {payment && payment.state === "completed" ? (
          <>
            <div>
              <dt>Refunded</dt>
              <dd data-testid="admin-refunded">
                <Money cents={payment.refundedCents} currency={payment.currency} />
              </dd>
            </div>
            <div>
              <dt>Refundable</dt>
              <dd data-testid="admin-refundable">
                <Money cents={payment.refundableCents} currency={payment.currency} />
              </dd>
            </div>
          </>
        ) : null}
      </dl>
      {payment?.amountMismatch ? (
        <Alert kind="error">
          PayPal captured a different amount from the order total. Check this payment in PayPal.
        </Alert>
      ) : null}
      {payment && payment.refunds.length > 0 ? (
        <RefundsTable orderId={props.orderId} refunds={payment.refunds} csrfToken={props.csrfToken} />
      ) : null}
      {payment && payment.state === "completed" && payment.refundableCents > 0 ? (
        <form
          method="post"
          action={`/admin/orders/${props.orderId}/refund`}
          class="refund-form"
          data-disable-on-submit
          novalidate
        >
          <CsrfField token={props.csrfToken} />
          <input type="hidden" name="refundKey" value={props.refundKey} />
          <h3>Refund</h3>
          {props.refundError ? (
            <Alert kind="error">
              <p data-testid="refund-error">{props.refundError}</p>
            </Alert>
          ) : null}
          <div class={props.refundError ? "field has-error" : "field"}>
            <label for="field-amount">
              Amount in {payment.currency}
              <span class="optional"> (leave empty to refund the full remaining amount)</span>
            </label>
            <input
              id="field-amount"
              name="amount"
              type="text"
              inputmode="decimal"
              value={props.refundAmount ?? ""}
              placeholder={toDecimalAmount(payment.refundableCents)}
              aria-invalid={props.refundError ? "true" : undefined}
            />
          </div>
          <button type="submit" class="button button-danger" data-testid="refund-submit">
            Refund with PayPal
          </button>
        </form>
      ) : null}
    </section>
  );
}
