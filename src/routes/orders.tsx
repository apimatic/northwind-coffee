import { Hono } from "hono";
import type { ContentfulStatusCode } from "hono/utils/http-status";
import type { AppEnv } from "../env";
import { requireUser } from "../middleware";
import * as basketService from "../services/basket";
import { presentPaypalFailure } from "../lib/paypal";
import * as orderService from "../services/orders";
import * as paymentService from "../services/payments";
import { CheckoutView } from "../views/checkout";
import { renderErrorPage } from "../views/errors";
import { type OrderNotice, OrderDetailView, OrdersListView, PaypalConfirmView } from "../views/orders";
import {
  type AppContext,
  fieldErrors,
  formValues,
  PAYPAL_UNAVAILABLE,
  pageContext,
  parseId,
  paypalOrNull,
} from "./helpers";

export const orders = new Hono<AppEnv>();

orders.use("/checkout", requireUser);
orders.use("/orders", requireUser);
orders.use("/orders/*", requireUser);

orders.get("/checkout", async (c) => {
  const basket = await basketService.getBasket(c.env.DB, c.var.buyerId);
  if (basket.lines.length === 0) return c.redirect("/basket", 303);
  return c.html(
    <CheckoutView
      ctx={await pageContext(c)}
      basket={basket}
      checkoutKey={crypto.randomUUID()}
      values={{ country: "US" }}
      errors={{}}
    />,
  );
});

orders.post("/checkout", async (c) => {
  const user = c.var.user;
  if (!user) return renderErrorPage(c, 403);
  const form = await formValues(c);
  const key = orderService.checkoutKeySchema.safeParse(form.checkoutKey);
  if (!key.success) return c.redirect("/checkout", 303);

  const address = orderService.shippingAddressSchema.safeParse(form);
  if (!address.success) {
    const basket = await basketService.getBasket(c.env.DB, c.var.buyerId);
    return c.html(
      <CheckoutView
        ctx={await pageContext(c)}
        basket={basket}
        checkoutKey={key.data}
        values={form}
        errors={fieldErrors(address.error)}
      />,
    );
  }

  const result = await orderService.placeOrder(c.env.DB, {
    userId: user.id,
    checkoutKey: key.data,
    shipTo: address.data,
  });
  if (!result.ok) return c.redirect("/basket", 303);
  return c.redirect(`/orders/${result.orderId}${result.created ? "?placed=1" : ""}`, 303);
});

orders.get("/orders", async (c) => {
  const user = c.var.user;
  if (!user) return renderErrorPage(c, 403);
  const list = await orderService.listOrdersForUser(c.env.DB, user.id);
  return c.html(<OrdersListView ctx={await pageContext(c)} orders={list} />);
});

const ORDER_NOTICES = new Set<string>(["paypal_cancelled", "paid", "pending", "confirming", "declined"]);

/** Loads the signed-in user's order from the :id param, or null. */
async function ownOrder(c: AppContext) {
  const user = c.var.user;
  const id = parseId(c.req.param("id"));
  if (!user || id === null) return null;
  return orderService.getOrderForUser(c.env.DB, user.id, id);
}

async function renderOrder(
  c: AppContext,
  order: orderService.OrderDetail,
  extra: { notice?: OrderNotice; paymentError?: string; status?: ContentfulStatusCode } = {},
) {
  const payment = await paymentService.getPaymentInfo(c.env.DB, order.id);
  const queryNotice = c.req.query("notice");
  const notice =
    extra.notice ?? (queryNotice && ORDER_NOTICES.has(queryNotice) ? (queryNotice as OrderNotice) : undefined);
  return c.html(
    <OrderDetailView
      ctx={await pageContext(c)}
      order={order}
      payment={payment}
      justPlaced={c.req.query("placed") === "1"}
      notice={notice}
      paymentError={extra.paymentError}
    />,
    extra.status ?? 200,
  );
}

orders.get("/orders/:id", async (c) => {
  let order = await ownOrder(c);
  if (!order) return renderErrorPage(c, 404);
  const payment = await paymentService.getPaymentInfo(c.env.DB, order.id);
  if (payment && (payment.state === "capturing" || payment.state === "pending")) {
    const paypal = paypalOrNull(c);
    if (paypal) {
      await paymentService.reconcilePayment(c.env.DB, paypal, order.id);
      order = (await ownOrder(c)) ?? order;
    }
  }
  return renderOrder(c, order);
});

/** Starts (or resumes) the PayPal checkout and sends the buyer to PayPal to approve the payment. */
orders.post("/orders/:id/pay", async (c) => {
  const order = await ownOrder(c);
  if (!order) return renderErrorPage(c, 404);
  const paypal = paypalOrNull(c);
  if (!paypal) return renderErrorPage(c, 502, PAYPAL_UNAVAILABLE);

  const origin = new URL(c.req.url).origin;
  const result = await paymentService.startPaypalCheckout(c.env.DB, paypal, {
    order,
    returnUrl: `${origin}/orders/${order.id}/paypal/return`,
    cancelUrl: `${origin}/orders/${order.id}?notice=paypal_cancelled`,
  });
  switch (result.kind) {
    case "redirect":
      return c.redirect(result.approvalUrl, 303);
    case "approved":
      return c.redirect(`/orders/${order.id}/paypal/confirm`, 303);
    case "not_payable":
      return c.redirect(`/orders/${order.id}`, 303);
    case "unknown":
      return renderOrder(c, order, {
        paymentError:
          "We couldn't confirm the PayPal checkout was created. Please try again; you won't be charged twice.",
        status: 502,
      });
    case "failed": {
      const shown = presentPaypalFailure(result.failure);
      return renderOrder(c, order, { paymentError: shown.message, status: shown.status });
    }
  }
});

/** PayPal sends the buyer back here after they approve the payment. */
orders.get("/orders/:id/paypal/return", async (c) => {
  const order = await ownOrder(c);
  if (!order) return renderErrorPage(c, 404);
  const token = c.req.query("token") ?? "";
  const payment = token ? await paymentService.paymentForReturn(c.env.DB, order.id, token) : null;
  if (!payment) return c.redirect(`/orders/${order.id}`, 303);
  return c.redirect(`/orders/${order.id}/paypal/confirm`, 303);
});

orders.get("/orders/:id/paypal/confirm", async (c) => {
  const order = await ownOrder(c);
  if (!order) return renderErrorPage(c, 404);
  const payment = await paymentService.getPaymentInfo(c.env.DB, order.id);
  if (order.status !== "awaiting_payment" || payment?.state !== "awaiting_approval") {
    return c.redirect(`/orders/${order.id}`, 303);
  }
  return c.html(<PaypalConfirmView ctx={await pageContext(c)} order={order} />);
});

/** Captures the approved payment. The order is marked paid only when PayPal reports the capture COMPLETED. */
orders.post("/orders/:id/paypal/capture", async (c) => {
  const order = await ownOrder(c);
  if (!order) return renderErrorPage(c, 404);
  const paypal = paypalOrNull(c);
  if (!paypal) return renderErrorPage(c, 502, PAYPAL_UNAVAILABLE);

  const result = await paymentService.capturePaypalPayment(c.env.DB, paypal, order.id);
  switch (result.kind) {
    case "paid":
      return c.redirect(`/orders/${order.id}?notice=paid`, 303);
    case "pending":
      return c.redirect(`/orders/${order.id}?notice=pending`, 303);
    case "declined":
      return c.redirect(`/orders/${order.id}?notice=declined`, 303);
    case "unknown":
      return c.redirect(`/orders/${order.id}?notice=confirming`, 303);
    case "not_capturable":
      return c.redirect(`/orders/${order.id}`, 303);
    case "failed": {
      const shown = presentPaypalFailure(result.failure);
      const fresh = (await ownOrder(c)) ?? order;
      return c.html(<PaypalConfirmView ctx={await pageContext(c)} order={fresh} error={shown.message} />, shown.status);
    }
  }
});
