import { Hono } from "hono";
import type { AppEnv } from "../env";
import { requireUser } from "../middleware";
import * as basketService from "../services/basket";
import * as orderService from "../services/orders";
import * as paymentService from "../services/payments";
import { CheckoutView } from "../views/checkout";
import { renderErrorPage } from "../views/errors";
import { OrderDetailView, OrdersListView, parsePaymentNotice } from "../views/orders";
import { fieldErrors, formValues, pageContext, parseId, paypalClient } from "./helpers";

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

orders.get("/orders/:id", async (c) => {
  const user = c.var.user;
  const id = parseId(c.req.param("id"));
  if (!user || id === null) return renderErrorPage(c, 404);
  const order = await orderService.getOrderForUser(c.env.DB, user.id, id);
  if (!order) return renderErrorPage(c, 404);
  const payment = await paymentService.getPaymentSummary(c.env.DB, order);
  return c.html(
    <OrderDetailView
      ctx={await pageContext(c)}
      order={order}
      payment={payment}
      justPlaced={c.req.query("placed") === "1"}
      notice={parsePaymentNotice(c.req.query("payment"))}
    />,
  );
});

// Start PayPal checkout: create a PayPal order and send the buyer to PayPal to approve it.
orders.post("/orders/:id/pay", async (c) => {
  const user = c.var.user;
  const id = parseId(c.req.param("id"));
  if (!user || id === null) return renderErrorPage(c, 404);
  const order = await orderService.getOrderForUser(c.env.DB, user.id, id);
  if (!order) return renderErrorPage(c, 404);
  const result = await paymentService.startPayPalCheckout(c.env.DB, paypalClient(c), {
    order,
    origin: new URL(c.req.url).origin,
  });
  if (result.ok) return c.redirect(result.approveUrl, 303);
  return c.redirect(`/orders/${id}?payment=${result.reason}`, 303);
});

// PayPal sends the buyer here after they approve. Capture, then show the order.
orders.get("/orders/:id/paypal/return", async (c) => {
  const user = c.var.user;
  const id = parseId(c.req.param("id"));
  if (!user || id === null) return renderErrorPage(c, 404);
  const order = await orderService.getOrderForUser(c.env.DB, user.id, id);
  if (!order) return renderErrorPage(c, 404);
  const token = paymentService.paypalTokenSchema.safeParse(c.req.query("token"));
  if (!token.success) return c.redirect(`/orders/${id}?payment=unknown`, 303);
  const outcome = await paymentService.completePayPalReturn(c.env.DB, paypalClient(c), {
    orderId: id,
    token: token.data,
  });
  return c.redirect(`/orders/${id}?payment=${outcome}`, 303);
});

// PayPal sends the buyer here if they cancel on PayPal. Nothing was charged.
orders.get("/orders/:id/paypal/cancel", async (c) => {
  const user = c.var.user;
  const id = parseId(c.req.param("id"));
  if (!user || id === null) return renderErrorPage(c, 404);
  const order = await orderService.getOrderForUser(c.env.DB, user.id, id);
  if (!order) return renderErrorPage(c, 404);
  const token = paymentService.paypalTokenSchema.safeParse(c.req.query("token"));
  if (token.success) await paymentService.cancelPayPalReturn(c.env.DB, { orderId: id, token: token.data });
  return c.redirect(`/orders/${id}?payment=cancelled`, 303);
});
