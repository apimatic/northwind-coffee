import type { Child } from "hono/jsx";
import { raw } from "hono/html";
import type { SessionUser } from "../services/identity";
import { CsrfField } from "./components";

export interface PageContext {
  user: SessionUser | null;
  csrfToken: string;
  /** Units in the basket; null when it couldn't be loaded (e.g. on error pages). */
  basketCount: number | null;
  path: string;
}

function NavLink(props: { href: string; current: string; children: Child }) {
  const active = props.href === "/" ? props.current === "/" : props.current.startsWith(props.href);
  return (
    <a href={props.href} class={active ? "nav-link active" : "nav-link"} aria-current={active ? "page" : undefined}>
      {props.children}
    </a>
  );
}

export function Layout(props: { ctx: PageContext; title: string; children: Child; wide?: boolean }) {
  const { ctx } = props;
  const count = ctx.basketCount;
  return (
    <>
      {raw("<!DOCTYPE html>")}
      <html lang="en">
        <head>
          <meta charset="utf-8" />
          <meta name="viewport" content="width=device-width, initial-scale=1" />
          <title>{`${props.title} | Northwind Coffee`}</title>
          <meta name="description" content="Northwind Coffee: freshly roasted beans, capsules and brewing gear." />
          <link rel="icon" href="/favicon.svg" type="image/svg+xml" />
          <link rel="stylesheet" href="/css/site.css" />
          <script src="/js/site.js" defer></script>
        </head>
        <body>
          <a class="skip-link" href="#main">
            Skip to content
          </a>
          <header class="site-header">
            <div class="container header-inner">
              <a class="brand" href="/">
                <img src="/images/logo.svg" alt="" width="40" height="40" />
                <span>Northwind Coffee</span>
              </a>
              <nav class="main-nav" aria-label="Main">
                <NavLink href="/" current={ctx.path}>
                  Shop
                </NavLink>
                {ctx.user ? (
                  <NavLink href="/orders" current={ctx.path}>
                    My orders
                  </NavLink>
                ) : null}
                {ctx.user?.role === "admin" ? (
                  <NavLink href="/admin" current={ctx.path}>
                    Admin
                  </NavLink>
                ) : null}
              </nav>
              <div class="header-actions">
                <a class="basket-link" href="/basket">
                  <span>Basket</span>
                  {count !== null ? (
                    <span class="badge" data-testid="basket-count">
                      {count}
                      <span class="visually-hidden">{count === 1 ? " item" : " items"}</span>
                    </span>
                  ) : null}
                </a>
                {ctx.user ? (
                  <form method="post" action="/account/logout" class="inline-form">
                    <CsrfField token={ctx.csrfToken} />
                    <span class="user-email" title={ctx.user.email}>
                      {ctx.user.email}
                    </span>
                    <button type="submit" class="button button-ghost">
                      Sign out
                    </button>
                  </form>
                ) : (
                  <a class="button button-ghost" href="/account/login">
                    Sign in
                  </a>
                )}
              </div>
            </div>
          </header>
          <main id="main" class={props.wide ? "" : "container main-content"} tabindex={-1}>
            {props.children}
          </main>
          <footer class="site-footer">
            <div class="container footer-inner">
              <p>
                <strong>Northwind Coffee</strong>. Roasted in small batches, shipped within two business days.
              </p>
              <p class="muted">Prices in US dollars. A sample store built on Cloudflare Workers.</p>
            </div>
          </footer>
        </body>
      </html>
    </>
  );
}
