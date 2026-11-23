import { Hono } from "hono";
import { HTTPException } from "hono/http-exception";
import { ping } from "./db/catalog";
import type { AppEnv } from "./env";
import { log } from "./lib/log";
import { csrfProtection, identity, requestLog, securityHeaders } from "./middleware";
import { account } from "./routes/account";
import { admin } from "./routes/admin";
import { api } from "./routes/api";
import { orders } from "./routes/orders";
import { shop } from "./routes/shop";
import { renderErrorPage } from "./views/errors";

const app = new Hono<AppEnv>();

app.use(requestLog, securityHeaders);

app.get("/healthz", async (c) => {
  try {
    const ok = await ping(c.env.DB);
    return c.json({ ok }, ok ? 200 : 503);
  } catch (error) {
    logError(c.req.method, c.req.path, error);
    return c.json({ ok: false }, 503);
  }
});

// Browsers ask for /favicon.ico regardless of the <link rel="icon">.
app.get("/favicon.ico", (c) => c.redirect("/favicon.svg", 301));

app.route("/api", api);

const web = new Hono<AppEnv>();
web.use(identity, csrfProtection);
web.route("/", shop);
web.route("/", orders);
web.route("/", account);
web.route("/", admin);
web.all("*", (c) => renderErrorPage(c, 404));
app.route("/", web);

app.notFound((c) => (c.req.path.startsWith("/api/") ? c.json({ error: "Not found" }, 404) : renderErrorPage(c, 404)));

function logError(method: string, path: string, error: unknown): void {
  const err = error instanceof Error ? error : new Error(String(error));
  log({ event: "error", method, path, name: err.name, message: err.message, stack: err.stack });
}

app.onError((error, c) => {
  if (error instanceof HTTPException && error.status < 500) {
    return error.getResponse();
  }
  logError(c.req.method, c.req.path, error);
  if (c.req.path.startsWith("/api/")) return c.json({ error: "Internal server error" }, 500);
  return renderErrorPage(c, 500);
});

export default app satisfies ExportedHandler<Env>;
