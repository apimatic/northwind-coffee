import type { Context } from "hono";
import type { ContentfulStatusCode } from "hono/utils/http-status";
import type { AppEnv } from "../env";
import { Layout, type PageContext } from "./layout";

const defaults: Record<number, { title: string; message: string }> = {
  403: { title: "Access denied", message: "You don't have permission to view this page." },
  404: { title: "Page not found", message: "We couldn't find the page you were looking for." },
  500: { title: "Something went wrong", message: "Sorry, we hit a problem on our side. Please try again in a moment." },
};

export function ErrorView(props: { ctx: PageContext; status: number; title: string; message: string }) {
  return (
    <Layout ctx={props.ctx} title={props.title}>
      <div class="error-page">
        <p class="error-code">{props.status}</p>
        <h1>{props.title}</h1>
        <p>{props.message}</p>
        <a class="button" href="/">
          Back to the shop
        </a>
      </div>
    </Layout>
  );
}

/** Renders a friendly error page. Uses only request state, never the database. */
export function renderErrorPage(
  c: Context<AppEnv>,
  status: ContentfulStatusCode,
  text?: { title: string; message: string },
) {
  const content = text ?? defaults[status] ?? (defaults[500] as { title: string; message: string });
  const ctx: PageContext = {
    user: c.var.user ?? null,
    csrfToken: c.var.csrfToken ?? "",
    basketCount: null,
    path: c.req.path,
  };
  return c.html(<ErrorView ctx={ctx} status={status} title={content.title} message={content.message} />, status);
}
