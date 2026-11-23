import type { Child } from "hono/jsx";
import type { CatalogItem } from "../services/catalog";
import { formatMoney } from "../lib/money";
import { ORDER_STATUSES, type OrderDetail, type OrderSummary, STATUS_LABELS } from "../services/orders";
import type { PaymentSummary } from "../services/payments";
import { Alert, CsrfField, type FieldErrors, formatDate, Money, PageHeader, TextField } from "./components";
import { Layout, type PageContext } from "./layout";
import { OrderDetailBody, OrdersTable, paymentStatusText } from "./orders";

function AdminNav(props: { current: "orders" | "catalog" }) {
  return (
    <nav class="sub-nav" aria-label="Admin">
      <a href="/admin/orders" aria-current={props.current === "orders" ? "page" : undefined}>
        Orders
      </a>
      <a href="/admin/catalog" aria-current={props.current === "catalog" ? "page" : undefined}>
        Catalog
      </a>
    </nav>
  );
}

function AdminLayout(props: { ctx: PageContext; title: string; current: "orders" | "catalog"; children: Child }) {
  return (
    <Layout ctx={props.ctx} title={`${props.title} (admin)`}>
      <p class="eyebrow">Admin</p>
      <AdminNav current={props.current} />
      {props.children}
    </Layout>
  );
}

export function AdminOrdersView(props: { ctx: PageContext; orders: OrderSummary[]; status: string | undefined }) {
  return (
    <AdminLayout ctx={props.ctx} title="Orders" current="orders">
      <PageHeader title="Orders" />
      <form class="filter-bar" method="get" action="/admin/orders" aria-label="Filter orders">
        <div class="filter-field">
          <label for="filter-status">Status</label>
          <select id="filter-status" name="status">
            <option value="">All statuses</option>
            {ORDER_STATUSES.map((status) => (
              <option value={status} selected={props.status === status}>
                {STATUS_LABELS[status]}
              </option>
            ))}
          </select>
        </div>
        <div class="filter-actions">
          <button type="submit" class="button">
            Apply
          </button>
        </div>
      </form>
      {props.orders.length === 0 ? (
        <p class="empty-state">No orders found.</p>
      ) : (
        <OrdersTable orders={props.orders} hrefBase="/admin/orders" showBuyer />
      )}
    </AdminLayout>
  );
}

const ADMIN_ORDER_NOTICES = {
  cancelled: { kind: "success", text: "The order was cancelled." },
  not_cancellable: {
    kind: "error",
    text: "Only orders awaiting payment, with no PayPal payment in progress, can be cancelled.",
  },
  refunded: { kind: "success", text: "The refund was sent. PayPal has returned the money to the buyer." },
  refund_pending: {
    kind: "info",
    text: "PayPal accepted the refund and is still processing it. Use Check with PayPal later to update it.",
  },
  not_refundable: { kind: "error", text: "This order has no captured payment to refund." },
  synced: { kind: "success", text: "Payment status updated from PayPal." },
  sync_unchanged: { kind: "info", text: "Checked with PayPal: nothing has changed yet." },
} as const satisfies Record<string, { kind: "error" | "info" | "success"; text: string }>;

export type AdminOrderNotice = keyof typeof ADMIN_ORDER_NOTICES;

export function parseAdminOrderNotice(value: string | undefined): AdminOrderNotice | undefined {
  return value !== undefined && Object.hasOwn(ADMIN_ORDER_NOTICES, value) ? (value as AdminOrderNotice) : undefined;
}

export interface RefundFormState {
  refundKey: string;
  values: { amount: string; note: string };
  errors: FieldErrors;
  formError?: string;
}

const PAYMENT_STATUS_LABELS: Record<string, string> = {
  created: "Sent to PayPal",
  capturing: "Capturing",
  pending: "Pending at PayPal",
  captured: "Captured",
  failed: "Failed",
  voided: "Abandoned",
};

const REFUND_STATUS_LABELS: Record<string, string> = {
  requested: "Unconfirmed",
  pending: "Pending at PayPal",
  completed: "Completed",
  failed: "Failed",
};

function AdminPaymentSection(props: {
  order: OrderDetail;
  payment: PaymentSummary;
  csrfToken: string;
  refundForm: RefundFormState;
}) {
  const { order, payment, refundForm } = props;
  const captured = payment.active?.status === "captured" ? payment.active : null;
  return (
    <section class="card payment-panel" aria-labelledby="payment-heading">
      <h2 id="payment-heading">Payment</h2>
      <p data-testid="payment-status">{paymentStatusText(order, payment)}</p>
      {refundForm.formError ? (
        <Alert kind="error">
          <p data-testid="refund-error">{refundForm.formError}</p>
        </Alert>
      ) : null}
      {captured ? (
        <dl class="meta-list">
          <div>
            <dt>Captured</dt>
            <dd data-testid="payment-captured">
              <Money cents={payment.capturedCents} currency={order.currency} />
            </dd>
          </div>
          <div>
            <dt>Refunded</dt>
            <dd data-testid="payment-refunded">
              <Money cents={payment.refundedCents} currency={order.currency} />
            </dd>
          </div>
          <div>
            <dt>Refundable</dt>
            <dd data-testid="payment-refundable">
              <Money cents={payment.refundableCents} currency={order.currency} />
            </dd>
          </div>
          <div>
            <dt>PayPal capture</dt>
            <dd>
              <code>{captured.captureId}</code>
            </dd>
          </div>
        </dl>
      ) : null}

      {payment.needsSync ? (
        <form method="post" action={`/admin/orders/${order.id}/payment-sync`} class="sync-form" data-disable-on-submit>
          <CsrfField token={props.csrfToken} />
          <p class="muted">Something is still waiting on PayPal.</p>
          <button type="submit" class="button">
            Check with PayPal
          </button>
        </form>
      ) : null}

      {payment.refundableCents > 0 ? (
        <form
          method="post"
          action={`/admin/orders/${order.id}/refund`}
          class="refund-form"
          data-disable-on-submit
          novalidate
        >
          <CsrfField token={props.csrfToken} />
          <input type="hidden" name="refundKey" value={refundForm.refundKey} />
          <h3>Refund</h3>
          <div class="field-row">
            <TextField
              label="Amount (USD)"
              name="amount"
              value={refundForm.values.amount}
              error={refundForm.errors.amount}
              hint={`Up to ${formatMoney(payment.refundableCents, order.currency)}. Enter less for a partial refund.`}
              autocomplete="off"
              maxlength={16}
            />
            <TextField
              label="Note to buyer"
              name="note"
              value={refundForm.values.note}
              error={refundForm.errors.note}
              required={false}
              maxlength={255}
              autocomplete="off"
            />
          </div>
          <div>
            <button type="submit" class="button button-danger">
              Refund
            </button>
          </div>
        </form>
      ) : null}

      {payment.refunds.length > 0 ? (
        <table class="data-table" data-testid="refunds-table">
          <caption>Refunds</caption>
          <thead>
            <tr>
              <th scope="col">Date</th>
              <th scope="col" class="num">
                Amount
              </th>
              <th scope="col">Status</th>
              <th scope="col">PayPal refund</th>
              <th scope="col">By</th>
              <th scope="col">Note</th>
            </tr>
          </thead>
          <tbody>
            {payment.refunds.map((refund) => (
              <tr data-testid="refund-row">
                <td data-label="Date">{formatDate(refund.createdAt)}</td>
                <td class="num" data-label="Amount">
                  <Money cents={refund.amountCents} currency={refund.currency} />
                </td>
                <td data-label="Status">
                  {REFUND_STATUS_LABELS[refund.status] ?? refund.status}
                  {refund.failureReason ? ` (${refund.failureReason})` : ""}
                </td>
                <td data-label="PayPal refund">
                  {refund.providerRefundId ? <code>{refund.providerRefundId}</code> : "None"}
                </td>
                <td data-label="By">{refund.createdByEmail ?? "Unknown"}</td>
                <td data-label="Note">{refund.note}</td>
              </tr>
            ))}
          </tbody>
        </table>
      ) : null}

      {payment.payments.length > 0 ? (
        <table class="data-table" data-testid="payment-attempts">
          <caption>PayPal attempts</caption>
          <thead>
            <tr>
              <th scope="col">Started</th>
              <th scope="col">PayPal order</th>
              <th scope="col" class="num">
                Amount
              </th>
              <th scope="col">Status</th>
            </tr>
          </thead>
          <tbody>
            {payment.payments.map((attempt) => (
              <tr>
                <td data-label="Started">{formatDate(attempt.createdAt)}</td>
                <td data-label="PayPal order">
                  <code>{attempt.providerOrderId}</code>
                </td>
                <td class="num" data-label="Amount">
                  <Money cents={attempt.amountCents} currency={attempt.currency} />
                </td>
                <td data-label="Status">
                  {PAYMENT_STATUS_LABELS[attempt.status] ?? attempt.status}
                  {attempt.failureReason ? ` (${attempt.failureReason})` : ""}
                </td>
              </tr>
            ))}
          </tbody>
        </table>
      ) : (
        <p class="muted">The buyer hasn't started a PayPal payment yet.</p>
      )}
    </section>
  );
}

export function AdminOrderView(props: {
  ctx: PageContext;
  order: OrderDetail;
  payment: PaymentSummary;
  notice?: AdminOrderNotice | undefined;
  refundForm: RefundFormState;
}) {
  const { order, payment } = props;
  const notice = props.notice ? ADMIN_ORDER_NOTICES[props.notice] : null;
  const actions = payment.canCancel ? (
    <form method="post" action={`/admin/orders/${order.id}/cancel`} class="order-actions" data-disable-on-submit>
      <CsrfField token={props.ctx.csrfToken} />
      <button type="submit" class="button button-danger">
        Cancel order
      </button>
    </form>
  ) : null;
  return (
    <AdminLayout ctx={props.ctx} title={`Order #${order.id}`} current="orders">
      <PageHeader title={`Order #${order.id}`}>
        <a href="/admin/orders">Back to all orders</a>
      </PageHeader>
      {notice ? (
        <Alert kind={notice.kind}>
          <p data-testid="admin-notice">{notice.text}</p>
        </Alert>
      ) : null}
      <AdminPaymentSection
        order={order}
        payment={payment}
        csrfToken={props.ctx.csrfToken}
        refundForm={props.refundForm}
      />
      <OrderDetailBody order={order} showBuyer actions={actions} />
    </AdminLayout>
  );
}

export function AdminCatalogView(props: { ctx: PageContext; items: CatalogItem[] }) {
  return (
    <AdminLayout ctx={props.ctx} title="Catalog" current="catalog">
      <PageHeader title="Catalog">
        <p class="muted">Read-only. {props.items.length} products.</p>
      </PageHeader>
      <table class="data-table">
        <caption class="visually-hidden">Catalog items</caption>
        <thead>
          <tr>
            <th scope="col">ID</th>
            <th scope="col">Product</th>
            <th scope="col">Brand</th>
            <th scope="col">Type</th>
            <th scope="col" class="num">
              Price
            </th>
          </tr>
        </thead>
        <tbody>
          {props.items.map((item) => (
            <tr>
              <td data-label="ID">{item.id}</td>
              <td data-label="Product">
                <div class="line-product">
                  <img src={item.pictureUri} alt="" width="48" height="48" />
                  <span>{item.name}</span>
                </div>
              </td>
              <td data-label="Brand">{item.brand}</td>
              <td data-label="Type">{item.type}</td>
              <td class="num" data-label="Price">
                <Money cents={item.priceCents} />
              </td>
            </tr>
          ))}
        </tbody>
      </table>
    </AdminLayout>
  );
}
