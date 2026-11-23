import type { Child } from "hono/jsx";
import type { CatalogItem } from "../services/catalog";
import { canCancel, ORDER_STATUSES, type OrderDetail, type OrderSummary, STATUS_LABELS } from "../services/orders";
import type { PaymentInfo } from "../services/payments";
import { Alert, CsrfField, Money, PageHeader } from "./components";
import { Layout, type PageContext } from "./layout";
import { OrderDetailBody, OrdersTable } from "./orders";
import { AdminPaymentPanel } from "./payments";

export type AdminOrderNotice =
  "cancelled" | "not_cancellable" | "refunded" | "refund_pending" | "refund_unknown" | "refund_duplicate";

const ADMIN_NOTICES: Record<AdminOrderNotice, { kind: "success" | "info" | "error"; text: string }> = {
  cancelled: { kind: "success", text: "The order was cancelled." },
  not_cancellable: { kind: "error", text: "Only unpaid orders awaiting payment can be cancelled." },
  refunded: { kind: "success", text: "PayPal completed the refund." },
  refund_pending: { kind: "info", text: "PayPal accepted the refund and is still processing it." },
  refund_unknown: {
    kind: "info",
    text: "We couldn't confirm the refund with PayPal yet. Its amount stays reserved; use “Check refund status”.",
  },
  refund_duplicate: { kind: "info", text: "That refund was already submitted." },
};

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

export function AdminOrderView(props: {
  ctx: PageContext;
  order: OrderDetail;
  payment: PaymentInfo | null;
  refundKey: string;
  notice?: AdminOrderNotice | undefined;
  refundAmount?: string | undefined;
  refundError?: string | undefined;
}) {
  const { order } = props;
  const notice = props.notice ? ADMIN_NOTICES[props.notice] : undefined;
  const actions = canCancel(order) ? (
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
      <OrderDetailBody order={order} payment={props.payment} showBuyer actions={actions} />
      <AdminPaymentPanel
        orderId={order.id}
        payment={props.payment}
        csrfToken={props.ctx.csrfToken}
        refundKey={props.refundKey}
        refundAmount={props.refundAmount}
        refundError={props.refundError}
      />
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
