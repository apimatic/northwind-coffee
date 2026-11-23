import type { CatalogPage } from "../services/catalog";
import { CsrfField, Money } from "./components";
import { Layout, type PageContext } from "./layout";

interface Option {
  id: number;
  label: string;
}

function catalogHref(page: CatalogPage, pageIndex: number): string {
  const params = new URLSearchParams();
  if (page.brandId !== null) params.set("brand", String(page.brandId));
  if (page.typeId !== null) params.set("type", String(page.typeId));
  if (pageIndex > 0) params.set("page", String(pageIndex + 1));
  const query = params.toString();
  return query ? `/?${query}` : "/";
}

export function CatalogView(props: { ctx: PageContext; page: CatalogPage; brands: Option[]; types: Option[] }) {
  const { page } = props;
  const first = page.totalItems === 0 ? 0 : page.pageIndex * page.pageSize + 1;
  const last = Math.min((page.pageIndex + 1) * page.pageSize, page.totalItems);
  const filtered = page.brandId !== null || page.typeId !== null;
  return (
    <Layout ctx={props.ctx} title="Shop" wide>
      <section class="hero">
        <div class="container hero-inner">
          <p class="eyebrow">Small-batch roasts</p>
          <h1>Great coffee, from bean to cup</h1>
          <p class="hero-text">
            Whole bean and ground coffee, capsules and brewing gear from four roasters we love. Roasted to order and
            shipped fresh.
          </p>
        </div>
      </section>
      <div class="container main-content">
        <form class="filter-bar" method="get" action="/" aria-label="Filter products">
          <div class="filter-field">
            <label for="filter-brand">Brand</label>
            <select id="filter-brand" name="brand">
              <option value="">All brands</option>
              {props.brands.map((brand) => (
                <option value={String(brand.id)} selected={page.brandId === brand.id}>
                  {brand.label}
                </option>
              ))}
            </select>
          </div>
          <div class="filter-field">
            <label for="filter-type">Type</label>
            <select id="filter-type" name="type">
              <option value="">All types</option>
              {props.types.map((type) => (
                <option value={String(type.id)} selected={page.typeId === type.id}>
                  {type.label}
                </option>
              ))}
            </select>
          </div>
          <div class="filter-actions">
            <button type="submit" class="button">
              Apply filters
            </button>
            {filtered ? (
              <a href="/" class="button button-secondary">
                Clear
              </a>
            ) : null}
          </div>
        </form>

        <p class="result-count" role="status" data-testid="result-count">
          {page.totalItems === 0
            ? "No products match these filters."
            : `Showing ${first}–${last} of ${page.totalItems} products`}
        </p>

        <ul class="product-grid">
          {page.items.map((item) => (
            <li class="product-card" data-testid="product-card">
              <img src={item.pictureUri} alt={item.name} width="400" height="400" />
              <div class="product-body">
                <p class="product-meta">
                  {item.brand} · {item.type}
                </p>
                <h2 class="product-name">{item.name}</h2>
                <p class="product-description">{item.description}</p>
                <div class="product-footer">
                  <p class="price">
                    <Money cents={item.priceCents} />
                  </p>
                  <form method="post" action="/basket/items">
                    <CsrfField token={props.ctx.csrfToken} />
                    <input type="hidden" name="catalogItemId" value={String(item.id)} />
                    <button type="submit" class="button" aria-label={`Add to basket: ${item.name}`}>
                      Add to basket
                    </button>
                  </form>
                </div>
              </div>
            </li>
          ))}
        </ul>

        {page.pageCount > 1 ? (
          <nav class="pagination" aria-label="Pagination">
            {page.pageIndex > 0 ? (
              <a class="button button-secondary" href={catalogHref(page, page.pageIndex - 1)} rel="prev">
                Previous
              </a>
            ) : (
              <span class="button button-secondary disabled" aria-disabled="true">
                Previous
              </span>
            )}
            <span class="page-status">
              Page {page.pageIndex + 1} of {page.pageCount}
            </span>
            {page.pageIndex < page.pageCount - 1 ? (
              <a class="button button-secondary" href={catalogHref(page, page.pageIndex + 1)} rel="next">
                Next
              </a>
            ) : (
              <span class="button button-secondary disabled" aria-disabled="true">
                Next
              </span>
            )}
          </nav>
        ) : null}
      </div>
    </Layout>
  );
}
