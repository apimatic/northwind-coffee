import { type Basket, MAX_LINE_QUANTITY } from "../services/basket";
import { Alert, CsrfField, Money, PageHeader } from "./components";
import { Layout, type PageContext } from "./layout";

const FORM_ID = "basket-form";

export function BasketView(props: { ctx: PageContext; basket: Basket; error?: string }) {
  const { basket, ctx } = props;
  return (
    <Layout ctx={ctx} title="Basket">
      <PageHeader title="Your basket" />
      {props.error ? <Alert kind="error">{props.error}</Alert> : null}
      {basket.lines.length === 0 ? (
        <div class="empty-state">
          <p>Your basket is empty.</p>
          <a class="button" href="/">
            Continue shopping
          </a>
        </div>
      ) : (
        <>
          <table class="data-table basket-table">
            <caption class="visually-hidden">Items in your basket</caption>
            <thead>
              <tr>
                <th scope="col">Product</th>
                <th scope="col" class="num">
                  Price
                </th>
                <th scope="col" class="num">
                  Quantity
                </th>
                <th scope="col" class="num">
                  Total
                </th>
                <th scope="col">
                  <span class="visually-hidden">Actions</span>
                </th>
              </tr>
            </thead>
            <tbody>
              {basket.lines.map((line) => (
                <tr data-testid="basket-line">
                  <td data-label="Product">
                    <div class="line-product">
                      <img src={line.pictureUri} alt="" width="64" height="64" />
                      <span>{line.name}</span>
                    </div>
                  </td>
                  <td class="num" data-label="Price">
                    <Money cents={line.unitPriceCents} />
                  </td>
                  <td class="num" data-label="Quantity">
                    <label class="visually-hidden" for={`qty-${line.id}`}>
                      Quantity of {line.name}
                    </label>
                    <input
                      class="qty-input"
                      id={`qty-${line.id}`}
                      name={`qty-${line.id}`}
                      form={FORM_ID}
                      type="number"
                      inputmode="numeric"
                      min="0"
                      max={String(MAX_LINE_QUANTITY)}
                      value={String(line.quantity)}
                      required
                    />
                  </td>
                  <td class="num" data-label="Total">
                    <Money cents={line.lineTotalCents} />
                  </td>
                  <td class="actions">
                    <form method="post" action={`/basket/items/${line.id}/remove`}>
                      <CsrfField token={ctx.csrfToken} />
                      <button type="submit" class="button button-link" aria-label={`Remove ${line.name}`}>
                        Remove
                      </button>
                    </form>
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
          <form method="post" action="/basket" id={FORM_ID} class="basket-summary">
            <CsrfField token={ctx.csrfToken} />
            <p class="total-row">
              <span>Total</span>
              <strong data-testid="basket-total">
                <Money cents={basket.totalCents} />
              </strong>
            </p>
            <p class="muted small">Shipping is free. Payment is arranged after you place your order.</p>
            <div class="button-row">
              <button type="submit" class="button button-secondary">
                Update basket
              </button>
              <button type="submit" class="button" name="next" value="checkout">
                Checkout
              </button>
            </div>
            <a href="/">Continue shopping</a>
          </form>
        </>
      )}
    </Layout>
  );
}
