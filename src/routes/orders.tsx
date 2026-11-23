import { Hono } from "hono";
import type { AppEnv } from "../env";
import { requireUser } from "../middleware";
import * as basketService from "../services/basket";
import * as orderService from "../services/orders";
import { CheckoutView } from "../views/checkout";
import { renderErrorPage } from "../views/errors";
import { OrderDetailView, OrdersListView } from "../views/orders";
import { fieldErrors, formValues, pageContext, parseId } from "./helpers";

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
  return c.html(
    <OrderDetailView ctx={await pageContext(c)} order={order} justPlaced={c.req.query("placed") === "1"} />,
  );
});
