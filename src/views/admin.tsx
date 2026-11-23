import type { Child } from "hono/jsx";
import type { CatalogItem } from "../services/catalog";
import { canCancel, ORDER_STATUSES, type OrderDetail, type OrderSummary, STATUS_LABELS } from "../services/orders";
import { Alert, CsrfField, Money, PageHeader } from "./components";
import { Layout, type PageContext } from "./layout";
import { OrderDetailBody, OrdersTable } from "./orders";

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
  notice?: "cancelled" | "not_cancellable";
}) {
  const { order } = props;
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
      {props.notice === "cancelled" ? <Alert kind="success">The order was cancelled.</Alert> : null}
      {props.notice === "not_cancellable" ? (
        <Alert kind="error">Only orders awaiting payment can be cancelled.</Alert>
      ) : null}
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
