import type { Context } from "hono";
import { z } from "zod";
import type { AppEnv } from "../env";
import { createPayPalClient, type PayPalClient, paypalConfigFromEnv } from "../lib/paypal";
import { countUnits } from "../services/basket";
import type { FieldErrors } from "../views/components";
import type { PageContext } from "../views/layout";

export type AppContext = Context<AppEnv>;

export async function pageContext(c: AppContext): Promise<PageContext> {
  return {
    user: c.var.user,
    csrfToken: c.var.csrfToken,
    basketCount: await countUnits(c.env.DB, c.var.buyerId),
    path: c.req.path,
  };
}

const idSchema = z.coerce.number().int().positive().max(Number.MAX_SAFE_INTEGER);

/** Parses a positive integer id from a route parameter; null if invalid. */
export function parseId(value: string | undefined): number | null {
  const parsed = idSchema.safeParse(value);
  return parsed.success ? parsed.data : null;
}

/** First error message per field. */
export function fieldErrors(error: z.ZodError): FieldErrors {
  const errors: FieldErrors = {};
  for (const issue of error.issues) {
    const key = String(issue.path[0] ?? "form");
    errors[key] ??= issue.message;
  }
  return errors;
}

/** Form values as strings (file uploads are ignored). */
export async function formValues(c: AppContext): Promise<Record<string, string>> {
  const body = await c.req.parseBody();
  const values: Record<string, string> = {};
  for (const [key, value] of Object.entries(body)) {
    if (typeof value === "string") values[key] = value;
  }
  return values;
}

/** PayPal client for this request; all calls go through PAYPAL_API_BASE (the egress gateway). */
export function paypalClient(c: AppContext): PayPalClient {
  return createPayPalClient(paypalConfigFromEnv(c.env));
}
