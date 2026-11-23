import type { Child } from "hono/jsx";
import { formatMoney } from "../lib/money";
import { COUNTRIES, type OrderDetail, type OrderSummary } from "../services/orders";
import type { PaymentSummary } from "../services/payments";
import { Alert, CsrfField, formatDate, Money, PageHeader, StatusBadge } from "./components";
import { Layout, type PageContext } from "./layout";

export const PAY_PROMPT = "Pay securely with PayPal. You'll approve the payment on PayPal and come back here.";

const PAYMENT_NOTICES = {
  paid: { kind: "success", title: "Payment received", text: "Thank you! PayPal has confirmed your payment." },
  pending: {
    kind: "info",
    title: "Payment processing",
    text: "PayPal is still processing your payment. We'll mark your order as paid as soon as it completes.",
  },
  declined: {
    kind: "error",
    title: "Payment declined",
    text: "PayPal couldn't complete the payment. Please try again, perhaps with a different payment method.",
  },
  not_approved: {
    kind: "info",
    title: "Payment not completed",
    text: "The payment wasn't approved on PayPal, so you haven't been charged. You can pay whenever you're ready.",
  },
  not_captured: {
    kind: "error",
    title: "Payment not taken",
    text: "Something went wrong taking your payment with PayPal, so you haven't been charged. Please try again in a moment.",
  },
  cancelled: {
    kind: "info",
    title: "Payment cancelled",
    text: "You cancelled on PayPal, so you haven't been charged. You can pay whenever you're ready.",
  },
  not_payable: { kind: "info", title: "Payment not needed", text: "This order can no longer be paid." },
  in_progress: {
    kind: "info",
    title: "Payment in progress",
    text: "A payment for this order is already being processed.",
  },
  provider_error: {
    kind: "error",
    title: "PayPal is unavailable",
    text: "We couldn't connect to PayPal. You haven't been charged. Please try again in a moment.",
  },
  error: {
    kind: "error",
    title: "We couldn't confirm your payment",
    text: "We couldn't confirm your payment with PayPal yet. You won't be charged twice. Please check again in a moment.",
  },
  unknown: {
    kind: "error",
    title: "Payment not recognised",
    text: "We couldn't match that PayPal payment to this order. You haven't been charged for it.",
  },
} as const satisfies Record<string, { kind: "error" | "info" | "success"; title: string; text: string }>;

export type PaymentNotice = keyof typeof PAYMENT_NOTICES;

export function parsePaymentNotice(value: string | undefined): PaymentNotice | undefined {
  return value !== undefined && Object.hasOwn(PAYMENT_NOTICES, value) ? (value as PaymentNotice) : undefined;
}

/** One-line payment status for an order, e.g. "Paid", "Partially refunded ($5.00 of $22.50)". */
export function paymentStatusText(order: Pick<OrderSummary, "status" | "currency">, payment: PaymentSummary): string {
  const active = payment.active;
  if (active?.status === "captured") {
    if (payment.refundedCents === 0) return "Paid with PayPal";
    const refunded = formatMoney(payment.refundedCents, order.currency);
    const captured = formatMoney(payment.capturedCents, order.currency);
    return payment.refundedCents >= payment.capturedCents
      ? `Refunded in full (${refunded})`
      : `Partially refunded (${refunded} of ${captured})`;
  }
  if (active?.status === "pending") return "Processing at PayPal";
  if (active?.status === "capturing") return "Confirming with PayPal";
  if (order.status === "cancelled") return "Not paid (order cancelled)";
  if (payment.lastAttemptFailed) return "Not paid (last attempt declined)";
  return "Not paid";
}

/** The buyer-facing payment card: status, and the Pay with PayPal button while payable. */
export function PaymentPanel(props: { order: OrderDetail; payment: PaymentSummary; csrfToken: string }) {
  const { order, payment } = props;
  const active = payment.active;
  return (
    <section class="card payment-panel" aria-labelledby="payment-heading">
      <h2 id="payment-heading">Payment</h2>
      <p data-testid="payment-status">{paymentStatusText(order, payment)}</p>
      {active?.status === "captured" ? (
        <p class="muted">
          <Money cents={active.capturedCents} currency={active.currency} /> paid on {formatDate(active.updatedAt)}.
        </p>
      ) : null}
      {active?.status === "capturing" ? (
        <p>
          <a href={`/orders/${order.id}/paypal/return?token=${encodeURIComponent(active.providerOrderId)}`}>
            Check payment status
          </a>
        </p>
      ) : null}
      {payment.canPay ? (
        <form method="post" action={`/orders/${order.id}/pay`} class="pay-form" data-disable-on-submit>
          <CsrfField token={props.csrfToken} />
          <p data-testid="payment-note">{PAY_PROMPT}</p>
          <button type="submit" class="button button-paypal">
            Pay <Money cents={order.totalCents} currency={order.currency} /> with PayPal
          </button>
        </form>
      ) : null}
    </section>
  );
}

function countryName(code: string): string {
  return COUNTRIES.find(([c]) => c === code)?.[1] ?? code;
}

export function OrdersTable(props: { orders: OrderSummary[]; hrefBase: string; showBuyer?: boolean }) {
  return (
    <table class="data-table orders-table">
      <caption class="visually-hidden">Orders</caption>
      <thead>
        <tr>
          <th scope="col">Order</th>
          <th scope="col">Placed</th>
          {props.showBuyer ? <th scope="col">Buyer</th> : null}
          <th scope="col" class="num">
            Items
          </th>
          <th scope="col" class="num">
            Total
          </th>
          <th scope="col">Status</th>
        </tr>
      </thead>
      <tbody>
        {props.orders.map((order) => (
          <tr data-testid="order-row">
            <td data-label="Order">
              <a href={`${props.hrefBase}/${order.id}`}>Order #{order.id}</a>
            </td>
            <td data-label="Placed">{formatDate(order.createdAt)}</td>
            {props.showBuyer ? <td data-label="Buyer">{order.buyerEmail}</td> : null}
            <td class="num" data-label="Items">
              {order.itemCount}
            </td>
            <td class="num" data-label="Total">
              <Money cents={order.totalCents} currency={order.currency} />
            </td>
            <td data-label="Status">
              <StatusBadge status={order.status} />
            </td>
          </tr>
        ))}
      </tbody>
    </table>
  );
}

export function OrdersListView(props: { ctx: PageContext; orders: OrderSummary[] }) {
  return (
    <Layout ctx={props.ctx} title="My orders">
      <PageHeader title="My orders" />
      {props.orders.length === 0 ? (
        <div class="empty-state">
          <p>You haven't placed any orders yet.</p>
          <a class="button" href="/">
            Start shopping
          </a>
        </div>
      ) : (
        <OrdersTable orders={props.orders} hrefBase="/orders" />
      )}
    </Layout>
  );
}

export function OrderDetailBody(props: { order: OrderDetail; showBuyer?: boolean; actions?: Child }) {
  const { order } = props;
  const ship = order.shipTo;
  return (
    <div class="order-detail">
      <div class="order-meta card">
        <dl class="meta-list">
          <div>
            <dt>Status</dt>
            <dd data-testid="order-status">
              <StatusBadge status={order.status} />
            </dd>
          </div>
          <div>
            <dt>Placed</dt>
            <dd>{formatDate(order.createdAt)}</dd>
          </div>
          {props.showBuyer ? (
            <div>
              <dt>Buyer</dt>
              <dd>{order.buyerEmail}</dd>
            </div>
          ) : null}
          <div>
            <dt>Ship to</dt>
            <dd>
              <address>
                {ship.name}
                <br />
                {ship.line1}
                {ship.line2 ? (
                  <>
                    <br />
                    {ship.line2}
                  </>
                ) : null}
                <br />
                {ship.city}, {ship.region} {ship.postalCode}
                <br />
                {countryName(ship.country)}
              </address>
            </dd>
          </div>
        </dl>
        {props.actions}
      </div>
      <table class="data-table">
        <caption class="visually-hidden">Items in this order</caption>
        <thead>
          <tr>
            <th scope="col">Product</th>
            <th scope="col" class="num">
              Price
            </th>
            <th scope="col" class="num">
              Quantity
            </th>
            <th scope="col" class="num">
              Total
            </th>
          </tr>
        </thead>
        <tbody>
          {order.lines.map((line) => (
            <tr data-testid="order-line">
              <td data-label="Product">
                <div class="line-product">
                  <img src={line.pictureUri} alt="" width="64" height="64" />
                  <span>{line.productName}</span>
                </div>
              </td>
              <td class="num" data-label="Price">
                <Money cents={line.unitPriceCents} currency={order.currency} />
              </td>
              <td class="num" data-label="Quantity">
                {line.quantity}
              </td>
              <td class="num" data-label="Total">
                <Money cents={line.lineTotalCents} currency={order.currency} />
              </td>
            </tr>
          ))}
        </tbody>
        <tfoot>
          <tr>
            <th scope="row" colspan={3} class="num">
              Order total
            </th>
            <td class="num" data-testid="order-total">
              <strong>
                <Money cents={order.totalCents} currency={order.currency} />
              </strong>
            </td>
          </tr>
        </tfoot>
      </table>
    </div>
  );
}

export function OrderDetailView(props: {
  ctx: PageContext;
  order: OrderDetail;
  payment: PaymentSummary;
  justPlaced: boolean;
  notice?: PaymentNotice | undefined;
}) {
  const { order } = props;
  const notice = props.notice ? PAYMENT_NOTICES[props.notice] : null;
  return (
    <Layout ctx={props.ctx} title={`Order #${order.id}`}>
      <PageHeader title={`Order #${order.id}`}>
        <a href="/orders">Back to my orders</a>
      </PageHeader>
      {props.justPlaced ? (
        <Alert kind="success" title="Thank you! Your order has been placed.">
          <p>We've saved your order and emptied your basket.</p>
        </Alert>
      ) : null}
      {notice ? (
        <Alert kind={notice.kind} title={notice.title}>
          <p data-testid="payment-notice">{notice.text}</p>
        </Alert>
      ) : null}
      <PaymentPanel order={order} payment={props.payment} csrfToken={props.ctx.csrfToken} />
      <OrderDetailBody order={order} />
    </Layout>
  );
}
