import { Hono } from "hono";
import type { AppEnv } from "../env";
import { ANON_COOKIE, clearCookie, SESSION_COOKIE, writeCookie } from "../lib/cookies";
import * as basketService from "../services/basket";
import * as identityService from "../services/identity";
import type { SessionUser } from "../services/identity";
import { RegisterView, SignInView } from "../views/account";
import { type AppContext, fieldErrors, formValues, pageContext } from "./helpers";

export const account = new Hono<AppEnv>();

function returnUrlOf(c: AppContext): string {
  return identityService.safeReturnUrl(c.req.query("returnUrl"));
}

/** Starts a new session (fresh token) and merges the anonymous basket into the user's. */
async function signIn(c: AppContext, user: SessionUser): Promise<void> {
  const token = await identityService.createSession(c.env.DB, user.id);
  writeCookie(c, SESSION_COOKIE, token, identityService.SESSION_TTL_SECONDS);
  if (c.var.anonId) {
    await basketService.transferBasket(c.env.DB, c.var.anonId, user.id);
    clearCookie(c, ANON_COOKIE);
  }
}

account.get("/account/login", async (c) => {
  if (c.var.user) return c.redirect(returnUrlOf(c), 303);
  return c.html(<SignInView ctx={await pageContext(c)} returnUrl={returnUrlOf(c)} />);
});

account.post("/account/login", async (c) => {
  const returnUrl = returnUrlOf(c);
  const form = await formValues(c);
  const parsed = identityService.signInSchema.safeParse(form);
  if (!parsed.success) {
    return c.html(
      <SignInView
        ctx={await pageContext(c)}
        returnUrl={returnUrl}
        email={form.email}
        errors={fieldErrors(parsed.error)}
      />,
    );
  }
  const user = await identityService.authenticate(c.env.DB, parsed.data.email, parsed.data.password);
  if (!user) {
    return c.html(<SignInView ctx={await pageContext(c)} returnUrl={returnUrl} email={form.email} failed />);
  }
  await signIn(c, user);
  return c.redirect(returnUrl, 303);
});

account.get("/account/register", async (c) => {
  if (c.var.user) return c.redirect(returnUrlOf(c), 303);
  return c.html(<RegisterView ctx={await pageContext(c)} returnUrl={returnUrlOf(c)} />);
});

account.post("/account/register", async (c) => {
  const returnUrl = returnUrlOf(c);
  const form = await formValues(c);
  const parsed = identityService.registerSchema.safeParse(form);
  if (!parsed.success) {
    return c.html(
      <RegisterView
        ctx={await pageContext(c)}
        returnUrl={returnUrl}
        email={form.email}
        errors={fieldErrors(parsed.error)}
      />,
    );
  }
  const result = await identityService.createUser(c.env.DB, parsed.data);
  if (!result.ok) {
    return c.html(
      <RegisterView
        ctx={await pageContext(c)}
        returnUrl={returnUrl}
        email={form.email}
        errors={{ email: "An account with this email already exists. Sign in instead." }}
      />,
    );
  }
  await signIn(c, result.user);
  return c.redirect(returnUrl, 303);
});

account.post("/account/logout", async (c) => {
  if (c.var.sessionToken) await identityService.endSession(c.env.DB, c.var.sessionToken);
  clearCookie(c, SESSION_COOKIE);
  return c.redirect("/", 303);
});
