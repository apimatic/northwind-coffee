import { Hono } from "hono";
import type { AppEnv } from "../env";
import * as basketService from "../services/basket";
import * as catalogService from "../services/catalog";
import { BasketView } from "../views/basket";
import { CatalogView } from "../views/catalog";
import { renderErrorPage } from "../views/errors";
import { formValues, pageContext, parseId } from "./helpers";

export const shop = new Hono<AppEnv>();

shop.get("/", async (c) => {
  const pageNumber = Number(c.req.query("page") ?? "1");
  const query = catalogService.catalogQuerySchema.parse({
    brandId: c.req.query("brand"),
    typeId: c.req.query("type"),
    pageIndex: Number.isFinite(pageNumber) ? pageNumber - 1 : 0,
    pageSize: catalogService.DEFAULT_PAGE_SIZE,
  });
  const db = c.env.DB;
  const [page, brands, types] = await Promise.all([
    catalogService.listCatalog(db, query),
    catalogService.listBrands(db),
    catalogService.listTypes(db),
  ]);
  return c.html(
    <CatalogView
      ctx={await pageContext(c)}
      page={page}
      brands={brands.map((b) => ({ id: b.id, label: b.brand }))}
      types={types.map((t) => ({ id: t.id, label: t.type }))}
    />,
  );
});

shop.get("/basket", async (c) => {
  const basket = await basketService.getBasket(c.env.DB, c.var.buyerId);
  return c.html(<BasketView ctx={await pageContext(c)} basket={basket} />);
});

shop.post("/basket/items", async (c) => {
  const parsed = basketService.addItemSchema.safeParse(await formValues(c));
  if (!parsed.success) return renderErrorPage(c, 404);
  const result = await basketService.addItem(c.env.DB, c.var.buyerId, parsed.data);
  if (!result.ok) return renderErrorPage(c, 404);
  return c.redirect("/basket", 303);
});

shop.post("/basket", async (c) => {
  const form = await formValues(c);
  const quantities = basketService.parseQuantities(form);
  if (!quantities) {
    const basket = await basketService.getBasket(c.env.DB, c.var.buyerId);
    return c.html(
      <BasketView
        ctx={await pageContext(c)}
        basket={basket}
        error={`Quantities must be whole numbers from 0 to ${basketService.MAX_LINE_QUANTITY}.`}
      />,
    );
  }
  await basketService.setQuantities(c.env.DB, c.var.buyerId, quantities);
  return c.redirect(form.next === "checkout" ? "/checkout" : "/basket", 303);
});

shop.post("/basket/items/:id/remove", async (c) => {
  const id = parseId(c.req.param("id"));
  if (id === null) return renderErrorPage(c, 404);
  await basketService.removeItem(c.env.DB, c.var.buyerId, id);
  return c.redirect("/basket", 303);
});
