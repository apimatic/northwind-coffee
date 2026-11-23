import { Hono } from "hono";
import type { ContentfulStatusCode } from "hono/utils/http-status";
import type { AppEnv } from "../env";
import { requireAdmin } from "../middleware";
import { z } from "zod";
import { formatMoney, parseDecimalAmount } from "../lib/money";
import { presentPaypalFailure } from "../lib/paypal";
import * as catalogService from "../services/catalog";
import * as orderService from "../services/orders";
import * as paymentService from "../services/payments";
import { type AdminOrderNotice, AdminCatalogView, AdminOrdersView, AdminOrderView } from "../views/admin";
import { renderErrorPage } from "../views/errors";
import { type AppContext, formValues, PAYPAL_UNAVAILABLE, pageContext, parseId, paypalOrNull } from "./helpers";

export const admin = new Hono<AppEnv>();

admin.use("/admin", requireAdmin);
admin.use("/admin/*", requireAdmin);

admin.get("/admin", (c) => c.redirect("/admin/orders", 303));

admin.get("/admin/orders", async (c) => {
  const status = orderService.adminStatusFilterSchema.parse(c.req.query("status") || undefined);
  const list = await orderService.listAllOrders(c.env.DB, status);
  return c.html(<AdminOrdersView ctx={await pageContext(c)} orders={list} status={status} />);
});

const ADMIN_NOTICES = new Set<string>([
  "cancelled",
  "not_cancellable",
  "refunded",
  "refund_pending",
  "refund_unknown",
  "refund_duplicate",
]);

async function renderAdminOrder(
  c: AppContext,
  orderId: number,
  extra: { refundAmount?: string; refundError?: string; status?: ContentfulStatusCode } = {},
) {
  const order = await orderService.getOrder(c.env.DB, orderId);
  if (!order) return renderErrorPage(c, 404);
  const payment = await paymentService.getPaymentInfo(c.env.DB, orderId);
  const notice = c.req.query("notice");
  return c.html(
    <AdminOrderView
      ctx={await pageContext(c)}
      order={order}
      payment={payment}
      refundKey={crypto.randomUUID()}
      notice={notice && ADMIN_NOTICES.has(notice) ? (notice as AdminOrderNotice) : undefined}
      refundAmount={extra.refundAmount}
      refundError={extra.refundError}
    />,
    extra.status ?? 200,
  );
}

admin.get("/admin/orders/:id", async (c) => {
  const id = parseId(c.req.param("id"));
  if (id === null) return renderErrorPage(c, 404);
  const payment = await paymentService.getPaymentInfo(c.env.DB, id);
  if (payment && (payment.state === "capturing" || payment.state === "pending")) {
    const paypal = paypalOrNull(c);
    if (paypal) await paymentService.reconcilePayment(c.env.DB, paypal, id);
  }
  return renderAdminOrder(c, id);
});

const refundFormSchema = z.object({
  refundKey: z.uuid(),
  amount: z
    .string()
    .trim()
    .default("")
    .transform((value, ctx) => {
      if (value === "") return null;
      const cents = parseDecimalAmount(value.replace(/^\$/, ""));
      if (cents === null || cents <= 0) {
        ctx.addIssue({ code: "custom", message: "Enter an amount like 12.50, or leave it empty for a full refund." });
        return z.NEVER;
      }
      return cents;
    }),
});

/** Refunds a paid order with PayPal, in full (empty amount) or in part. */
admin.post("/admin/orders/:id/refund", async (c) => {
  const id = parseId(c.req.param("id"));
  const user = c.var.user;
  if (id === null || !user) return renderErrorPage(c, 404);
  if (!(await orderService.getOrder(c.env.DB, id))) return renderErrorPage(c, 404);
  const form = await formValues(c);
  const parsed = refundFormSchema.safeParse(form);
  if (!parsed.success) {
    const message = parsed.error.issues.find((i) => i.path[0] === "amount")?.message;
    if (!message) return c.redirect(`/admin/orders/${id}`, 303);
    return renderAdminOrder(c, id, { refundAmount: form.amount ?? "", refundError: message });
  }

  const paypal = paypalOrNull(c);
  if (!paypal) return renderErrorPage(c, 502, PAYPAL_UNAVAILABLE);
  const result = await paymentService.refundPaypalPayment(c.env.DB, paypal, {
    orderId: id,
    refundKey: parsed.data.refundKey,
    amountCents: parsed.data.amount,
    requestedByUserId: user.id,
  });
  switch (result.kind) {
    case "completed":
      return c.redirect(`/admin/orders/${id}?notice=refunded`, 303);
    case "pending":
      return c.redirect(`/admin/orders/${id}?notice=refund_pending`, 303);
    case "unknown":
      return c.redirect(`/admin/orders/${id}?notice=refund_unknown`, 303);
    case "duplicate":
      return c.redirect(`/admin/orders/${id}?notice=refund_duplicate`, 303);
    case "not_refundable":
      return renderAdminOrder(c, id, { refundError: "Only orders paid with PayPal can be refunded.", status: 409 });
    case "exceeds_refundable":
      return renderAdminOrder(c, id, {
        refundAmount: form.amount ?? "",
        refundError: `The amount is more than can still be refunded (${formatMoney(result.refundableCents)}).`,
      });
    case "failed": {
      const shown = presentPaypalFailure(result.failure);
      return renderAdminOrder(c, id, {
        refundAmount: form.amount ?? "",
        refundError: shown.message,
        status: shown.status,
      });
    }
  }
});

/** Re-checks a refund whose outcome PayPal has not confirmed yet. */
admin.post("/admin/orders/:id/refunds/:refundId/check", async (c) => {
  const id = parseId(c.req.param("id"));
  const refundId = parseId(c.req.param("refundId"));
  if (id === null || refundId === null) return renderErrorPage(c, 404);
  const paypal = paypalOrNull(c);
  if (!paypal) return renderErrorPage(c, 502, PAYPAL_UNAVAILABLE);
  const result = await paymentService.recheckRefund(c.env.DB, paypal, id, refundId);
  if (!result) return renderErrorPage(c, 404);
  const notice: Record<string, AdminOrderNotice> = {
    completed: "refunded",
    pending: "refund_pending",
    unknown: "refund_unknown",
  };
  const n = notice[result.kind];
  return c.redirect(`/admin/orders/${id}${n ? `?notice=${n}` : ""}`, 303);
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
