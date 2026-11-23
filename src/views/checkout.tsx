import type { Basket } from "../services/basket";
import { COUNTRIES, type ShippingAddress } from "../services/orders";
import { Alert, CsrfField, type FieldErrors, Money, PageHeader, TextField } from "./components";
import { Layout, type PageContext } from "./layout";

export function CheckoutView(props: {
  ctx: PageContext;
  basket: Basket;
  checkoutKey: string;
  values: Partial<ShippingAddress>;
  errors: FieldErrors;
}) {
  const { values, errors, basket } = props;
  const hasErrors = Object.keys(errors).length > 0;
  return (
    <Layout ctx={props.ctx} title="Checkout">
      <PageHeader title="Checkout" />
      <div class="checkout-grid">
        <form method="post" action="/checkout" class="card form-card" data-disable-on-submit novalidate>
          <CsrfField token={props.ctx.csrfToken} />
          <input type="hidden" name="checkoutKey" value={props.checkoutKey} />
          <h2>Shipping address</h2>
          {hasErrors ? (
            <Alert kind="error" title="Please check the highlighted fields.">
              <ul>
                {Object.entries(errors).map(([field, message]) => (
                  <li>
                    <a href={`#field-${field}`}>{message}</a>
                  </li>
                ))}
              </ul>
            </Alert>
          ) : null}
          <TextField label="Full name" name="name" value={values.name} error={errors.name} autocomplete="name" />
          <TextField
            label="Street address"
            name="line1"
            value={values.line1}
            error={errors.line1}
            autocomplete="address-line1"
          />
          <TextField
            label="Apartment, suite, etc."
            name="line2"
            value={values.line2}
            error={errors.line2}
            autocomplete="address-line2"
            required={false}
          />
          <div class="field-row">
            <TextField label="City" name="city" value={values.city} error={errors.city} autocomplete="address-level2" />
            <TextField
              label="State / region"
              name="region"
              value={values.region}
              error={errors.region}
              autocomplete="address-level1"
            />
          </div>
          <div class="field-row">
            <TextField
              label="Postal code"
              name="postalCode"
              value={values.postalCode}
              error={errors.postalCode}
              autocomplete="postal-code"
            />
            <div class={errors.country ? "field has-error" : "field"}>
              <label for="field-country">Country</label>
              <select
                id="field-country"
                name="country"
                autocomplete="country"
                required
                aria-invalid={errors.country ? "true" : undefined}
                aria-describedby={errors.country ? "field-country-error" : undefined}
              >
                {COUNTRIES.map(([code, name]) => (
                  <option value={code} selected={(values.country ?? "US") === code}>
                    {name}
                  </option>
                ))}
              </select>
              {errors.country ? (
                <p class="field-error" id="field-country-error">
                  {errors.country}
                </p>
              ) : null}
            </div>
          </div>
          <button type="submit" class="button button-large">
            Place order
          </button>
          <p class="muted small">
            You won't be charged now. Online payment isn't available yet; we'll be in touch about payment.
          </p>
        </form>

        <aside class="card summary-card" aria-labelledby="summary-heading">
          <h2 id="summary-heading">Order summary</h2>
          <ul class="summary-lines">
            {basket.lines.map((line) => (
              <li>
                <img src={line.pictureUri} alt="" width="48" height="48" />
                <span class="summary-name">
                  {line.name}
                  <span class="muted"> × {line.quantity}</span>
                </span>
                <span class="summary-amount">
                  <Money cents={line.lineTotalCents} />
                </span>
              </li>
            ))}
          </ul>
          <p class="total-row">
            <span>Total</span>
            <strong data-testid="checkout-total">
              <Money cents={basket.totalCents} />
            </strong>
          </p>
          <a href="/basket">Edit basket</a>
        </aside>
      </div>
    </Layout>
  );
}
