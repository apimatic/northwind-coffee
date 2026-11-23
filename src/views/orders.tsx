import type { Child } from "hono/jsx";
import { COUNTRIES, type OrderDetail, type OrderSummary } from "../services/orders";
import { type PaymentInfo, paymentStatusLabel } from "../services/payments";
import { Alert, CsrfField, formatDate, Money, PageHeader, StatusBadge } from "./components";
import { Layout, type PageContext } from "./layout";
import { canPayWithPaypal, PaymentStatusNote, PayWithPaypalForm } from "./payments";

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

export function OrderDetailBody(props: {
  order: OrderDetail;
  payment?: PaymentInfo | null;
  showBuyer?: boolean;
  actions?: Child;
}) {
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
          {props.payment !== undefined ? (
            <div>
              <dt>Payment</dt>
              <dd data-testid="payment-status">{paymentStatusLabel(props.payment)}</dd>
            </div>
          ) : null}
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

export type OrderNotice = "paypal_cancelled" | "paid" | "pending" | "confirming" | "declined";

const NOTICES: Record<OrderNotice, { kind: "success" | "info" | "error"; text: string }> = {
  paypal_cancelled: { kind: "info", text: "You left PayPal without paying. You can try again whenever you're ready." },
  paid: { kind: "success", text: "Thank you! Your payment is complete." },
  pending: { kind: "info", text: "PayPal accepted your payment and is still processing it." },
  confirming: { kind: "info", text: "We're confirming your payment with PayPal. Check back in a moment." },
  declined: { kind: "error", text: "PayPal declined the payment. You can try again." },
};

export function OrderDetailView(props: {
  ctx: PageContext;
  order: OrderDetail;
  payment: PaymentInfo | null;
  justPlaced: boolean;
  notice?: OrderNotice | undefined;
  paymentError?: string | undefined;
}) {
  const { order, payment } = props;
  const notice = props.notice ? NOTICES[props.notice] : undefined;
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
        <Alert kind={notice.kind}>
          <p data-testid="payment-notice">{notice.text}</p>
        </Alert>
      ) : null}
      {props.paymentError ? (
        <Alert kind="error" title="We couldn't start the PayPal payment.">
          <p data-testid="payment-error">{props.paymentError}</p>
        </Alert>
      ) : null}
      {order.status === "awaiting_payment" ? (
        <Alert kind="info">
          <PaymentStatusNote payment={payment} />
        </Alert>
      ) : null}
      <OrderDetailBody
        order={order}
        payment={payment}
        actions={
          canPayWithPaypal(order, payment) ? (
            <PayWithPaypalForm
              orderId={order.id}
              csrfToken={props.ctx.csrfToken}
              label={payment?.state === "declined" ? "Try PayPal again" : "Pay with PayPal"}
            />
          ) : null
        }
      />
    </Layout>
  );
}

export function PaypalConfirmView(props: { ctx: PageContext; order: OrderDetail; error?: string | undefined }) {
  const { order } = props;
  return (
    <Layout ctx={props.ctx} title={`Confirm payment for order #${order.id}`}>
      <PageHeader title={`Confirm payment for order #${order.id}`}>
        <a href={`/orders/${order.id}`}>Back to order</a>
      </PageHeader>
      {props.error ? (
        <Alert kind="error" title="The payment didn't go through.">
          <p data-testid="payment-error">{props.error}</p>
        </Alert>
      ) : null}
      <div class="card form-card">
        <p>You've approved the payment on PayPal. Nothing has been charged yet.</p>
        <form method="post" action={`/orders/${order.id}/paypal/capture`} data-disable-on-submit>
          <CsrfField token={props.ctx.csrfToken} />
          <button type="submit" class="button" data-testid="confirm-payment">
            Pay <Money cents={order.totalCents} currency={order.currency} /> now
          </button>
        </form>
        {props.error ? (
          <PayWithPaypalForm orderId={order.id} csrfToken={props.ctx.csrfToken} label="Go back to PayPal" />
        ) : null}
      </div>
      <OrderDetailBody order={order} />
    </Layout>
  );
}
