import type { MiddlewareHandler } from "hono";
import type { AppEnv } from "../env";
import { ANON_COOKIE, clearCookie, readCookie, SESSION_COOKIE, writeCookie } from "../lib/cookies";
import { CSRF_FIELD, CSRF_HEADER, csrfTokenFor, csrfTokensMatch } from "../lib/csrf";
import { log } from "../lib/log";
import { anonBuyerId, userBuyerId } from "../services/basket";
import { resolveSession } from "../services/identity";
import { renderErrorPage } from "../views/errors";

const ANON_TTL_SECONDS = 30 * 24 * 60 * 60;
const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/;

/** One JSON line per request: {"event":"request","method","path","status","ms"}. */
export const requestLog: MiddlewareHandler<AppEnv> = async (c, next) => {
  const started = Date.now();
  await next();
  log({ event: "request", method: c.req.method, path: c.req.path, status: c.res.status, ms: Date.now() - started });
};

export const securityHeaders: MiddlewareHandler<AppEnv> = async (c, next) => {
  await next();
  const headers = c.res.headers;
  headers.set(
    "Content-Security-Policy",
    // form-action also governs where a form POST may redirect: "Pay with PayPal" redirects to PayPal.
    "default-src 'self'; img-src 'self' data:; style-src 'self'; script-src 'self'; object-src 'none'; base-uri 'none'; form-action 'self' https://www.paypal.com https://www.sandbox.paypal.com; frame-ancestors 'none'",
  );
  headers.set("X-Content-Type-Options", "nosniff");
  headers.set("Referrer-Policy", "strict-origin-when-cross-origin");
  headers.set("X-Frame-Options", "DENY");
  if (!headers.has("Cache-Control")) headers.set("Cache-Control", "no-store");
};

/**
 * Resolves the session cookie to a user. Anonymous visitors get a random id cookie that keys
 * their basket. Also derives the CSRF token for this visitor.
 */
export const identity: MiddlewareHandler<AppEnv> = async (c, next) => {
  let sessionToken = readCookie(c, SESSION_COOKIE) ?? null;
  const user = sessionToken ? await resolveSession(c.env.DB, sessionToken) : null;
  if (sessionToken && !user) {
    clearCookie(c, SESSION_COOKIE);
    sessionToken = null;
  }

  let anonId = readCookie(c, ANON_COOKIE) ?? null;
  if (anonId !== null && !UUID.test(anonId)) anonId = null;
  if (!user && anonId === null) {
    anonId = crypto.randomUUID();
    writeCookie(c, ANON_COOKIE, anonId, ANON_TTL_SECONDS);
  }

  c.set("user", user);
  c.set("sessionToken", user ? sessionToken : null);
  c.set("anonId", anonId);
  c.set("buyerId", user ? userBuyerId(user.id) : anonBuyerId(anonId as string));
  c.set("csrfToken", await csrfTokenFor(c.env.CSRF_SECRET, user ? `s:${sessionToken}` : `a:${anonId}`));
  await next();
};

/** Rejects state-changing requests without a valid CSRF token for this visitor. */
export const csrfProtection: MiddlewareHandler<AppEnv> = async (c, next) => {
  if (c.req.method === "GET" || c.req.method === "HEAD" || c.req.method === "OPTIONS") return next();
  let received: unknown = c.req.header(CSRF_HEADER);
  if (received === undefined) {
    const contentType = c.req.header("content-type") ?? "";
    if (contentType.startsWith("application/x-www-form-urlencoded") || contentType.startsWith("multipart/form-data")) {
      received = (await c.req.parseBody())[CSRF_FIELD];
    }
  }
  if (!csrfTokensMatch(c.var.csrfToken, received)) {
    return renderErrorPage(c, 403, {
      title: "This form has expired",
      message: "For your security we couldn't accept that form. Go back, reload the page and try again.",
    });
  }
  return next();
};

export const requireUser: MiddlewareHandler<AppEnv> = async (c, next) => {
  if (!c.var.user) {
    const url = new URL(c.req.url);
    const returnUrl = c.req.method === "GET" ? url.pathname + url.search : url.pathname;
    return c.redirect(`/account/login?returnUrl=${encodeURIComponent(returnUrl)}`, 303);
  }
  return next();
};

export const requireAdmin: MiddlewareHandler<AppEnv> = async (c, next) => {
  if (!c.var.user) {
    return c.redirect(`/account/login?returnUrl=${encodeURIComponent(new URL(c.req.url).pathname)}`, 303);
  }
  if (c.var.user.role !== "admin") {
    return renderErrorPage(c, 403, {
      title: "Access denied",
      message: "You don't have permission to view this page.",
    });
  }
  return next();
};
