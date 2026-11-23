import { Hono } from "hono";
import type { AppEnv } from "../env";
import { requireAdmin } from "../middleware";
import * as catalogService from "../services/catalog";
import * as orderService from "../services/orders";
import { AdminCatalogView, AdminOrdersView, AdminOrderView } from "../views/admin";
import { renderErrorPage } from "../views/errors";
import { pageContext, parseId } from "./helpers";

export const admin = new Hono<AppEnv>();

admin.use("/admin", requireAdmin);
admin.use("/admin/*", requireAdmin);

admin.get("/admin", (c) => c.redirect("/admin/orders", 303));

admin.get("/admin/orders", async (c) => {
  const status = orderService.adminStatusFilterSchema.parse(c.req.query("status") || undefined);
  const list = await orderService.listAllOrders(c.env.DB, status);
  return c.html(<AdminOrdersView ctx={await pageContext(c)} orders={list} status={status} />);
});

admin.get("/admin/orders/:id", async (c) => {
  const id = parseId(c.req.param("id"));
  if (id === null) return renderErrorPage(c, 404);
  const order = await orderService.getOrder(c.env.DB, id);
  if (!order) return renderErrorPage(c, 404);
  const notice = c.req.query("notice");
  return c.html(
    <AdminOrderView
      ctx={await pageContext(c)}
      order={order}
      notice={notice === "cancelled" || notice === "not_cancellable" ? notice : undefined}
    />,
  );
});

admin.post("/admin/orders/:id/cancel", async (c) => {
  const id = parseId(c.req.param("id"));
  if (id === null) return renderErrorPage(c, 404);
  const result = await orderService.cancelOrder(c.env.DB, id);
  if (!result.ok && result.reason === "not_found") return renderErrorPage(c, 404);
  return c.redirect(`/admin/orders/${id}?notice=${result.ok ? "cancelled" : "not_cancellable"}`, 303);
});

admin.get("/admin/catalog", async (c) => {
  const items = await catalogService.listAllCatalogItems(c.env.DB);
  return c.html(<AdminCatalogView ctx={await pageContext(c)} items={items} />);
});
