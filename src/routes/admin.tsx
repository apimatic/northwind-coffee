import { Hono } from "hono";
import type { AppEnv } from "../env";
import { requireAdmin } from "../middleware";
import * as catalogService from "../services/catalog";
import { z } from "zod";
import { centsToDecimal, formatMoney, parseDecimalToCents } from "../lib/money";
import * as orderService from "../services/orders";
import * as paymentService from "../services/payments";
import {
  AdminCatalogView,
  AdminOrdersView,
  AdminOrderView,
  parseAdminOrderNotice,
  type RefundFormState,
} from "../views/admin";
import { renderErrorPage } from "../views/errors";
import { type AppContext, fieldErrors, formValues, pageContext, parseId, paypalClient } from "./helpers";

export const admin = new Hono<AppEnv>();

admin.use("/admin", requireAdmin);
admin.use("/admin/*", requireAdmin);

admin.get("/admin", (c) => c.redirect("/admin/orders", 303));

admin.get("/admin/orders", async (c) => {
  const status = orderService.adminStatusFilterSchema.parse(c.req.query("status") || undefined);
  const list = await orderService.listAllOrders(c.env.DB, status);
  return c.html(<AdminOrdersView ctx={await pageContext(c)} orders={list} status={status} />);
});

async function renderOrder(c: AppContext, orderId: number, refundForm?: RefundFormState) {
  const order = await orderService.getOrder(c.env.DB, orderId);
  if (!order) return renderErrorPage(c, 404);
  const payment = await paymentService.getPaymentSummary(c.env.DB, order);
  return c.html(
    <AdminOrderView
      ctx={await pageContext(c)}
      order={order}
      payment={payment}
      notice={parseAdminOrderNotice(c.req.query("notice"))}
      refundForm={
        refundForm ?? {
          refundKey: crypto.randomUUID(),
          values: { amount: centsToDecimal(payment.refundableCents), note: "" },
          errors: {},
        }
      }
    />,
  );
}

admin.get("/admin/orders/:id", async (c) => {
  const id = parseId(c.req.param("id"));
  if (id === null) return renderErrorPage(c, 404);
  return renderOrder(c, id);
});

admin.post("/admin/orders/:id/cancel", async (c) => {
  const id = parseId(c.req.param("id"));
  if (id === null) return renderErrorPage(c, 404);
  const result = await orderService.cancelOrder(c.env.DB, id);
  if (!result.ok && result.reason === "not_found") return renderErrorPage(c, 404);
  return c.redirect(`/admin/orders/${id}?notice=${result.ok ? "cancelled" : "not_cancellable"}`, 303);
});

const refundFormSchema = z.object({
  amount: z
    .string()
    .trim()
    .min(1, "Enter the amount to refund.")
    .transform((value, ctx) => {
      const cents = parseDecimalToCents(value);
      if (cents === null || cents <= 0) {
        ctx.addIssue({ code: "custom", message: "Enter an amount greater than zero, like 12.50." });
        return z.NEVER;
      }
      return cents;
    }),
  note: z
    .string()
    .trim()
    .max(paymentService.REFUND_NOTE_MAX, `Use at most ${paymentService.REFUND_NOTE_MAX} characters.`)
    .refine((value) => ![...value].some((ch) => ch.charCodeAt(0) < 32), "Remove control characters.")
    .default(""),
});

admin.post("/admin/orders/:id/refund", async (c) => {
  const user = c.var.user;
  const id = parseId(c.req.param("id"));
  if (!user || id === null) return renderErrorPage(c, 404);
  const order = await orderService.getOrder(c.env.DB, id);
  if (!order) return renderErrorPage(c, 404);
  const form = await formValues(c);
  const key = z.uuid().safeParse(form.refundKey);
  if (!key.success) return c.redirect(`/admin/orders/${id}`, 303);
  const values = { amount: form.amount ?? "", note: form.note ?? "" };

  const parsed = refundFormSchema.safeParse(values);
  if (!parsed.success) {
    return renderOrder(c, id, { refundKey: key.data, values, errors: fieldErrors(parsed.error) });
  }
  const result = await paymentService.refundOrder(c.env.DB, paypalClient(c), {
    orderId: id,
    amountCents: parsed.data.amount,
    note: parsed.data.note,
    requestKey: key.data,
    userId: user.id,
  });
  if (result.ok) {
    return c.redirect(
      `/admin/orders/${id}?notice=${result.status === "completed" ? "refunded" : "refund_pending"}`,
      303,
    );
  }
  switch (result.reason) {
    case "exceeds_refundable": {
      const summary = await paymentService.getPaymentSummary(c.env.DB, order);
      const max = formatMoney(summary.refundableCents, order.currency);
      return renderOrder(c, id, {
        refundKey: crypto.randomUUID(),
        values,
        errors: { amount: `Enter at most ${max}, the amount not yet refunded.` },
      });
    }
    case "not_refundable":
      return c.redirect(`/admin/orders/${id}?notice=not_refundable`, 303);
    case "provider_refused":
      return renderOrder(c, id, {
        refundKey: crypto.randomUUID(),
        values,
        errors: {},
        formError: `PayPal refused the refund${result.issue ? ` (${result.issue})` : ""}. No money was returned.`,
      });
    case "provider_unavailable":
      // The refund stays reserved as "unconfirmed"; Check with PayPal retries it with the same
      // idempotency key, so it can never be sent twice.
      return renderOrder(c, id, {
        refundKey: crypto.randomUUID(),
        values: { amount: "", note: "" },
        errors: {},
        formError:
          "We couldn't confirm the refund with PayPal. It's saved as unconfirmed: use Check with PayPal to retry it. It will never be sent twice.",
      });
  }
});

admin.post("/admin/orders/:id/payment-sync", async (c) => {
  const id = parseId(c.req.param("id"));
  if (id === null) return renderErrorPage(c, 404);
  const order = await orderService.getOrder(c.env.DB, id);
  if (!order) return renderErrorPage(c, 404);
  const changed = await paymentService.syncOrderPayments(c.env.DB, paypalClient(c), id);
  return c.redirect(`/admin/orders/${id}?notice=${changed ? "synced" : "sync_unchanged"}`, 303);
});

admin.get("/admin/catalog", async (c) => {
  const items = await catalogService.listAllCatalogItems(c.env.DB);
  return c.html(<AdminCatalogView ctx={await pageContext(c)} items={items} />);
});
