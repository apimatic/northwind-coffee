/**
 * Minimal PayPal REST client (Orders v2 and Payments v2) using `fetch` only.
 *
 * Every call goes to `apiBase` (our egress gateway, PAYPAL_API_BASE), never directly to
 * api-m.paypal.com. The base may include a path prefix, so URLs are built by concatenation.
 * Amounts cross this boundary as integer cents; PayPal's decimal strings are converted here.
 * Nothing in this file logs credentials, access tokens or request bodies.
 */
import { type Cents, centsToDecimal, parseDecimalToCents } from "./money";

export interface PayPalConfig {
  apiBase: string;
  clientId: string;
  clientSecret: string;
}

export interface PayPalCapture {
  id: string;
  status: string;
  amountCents: Cents | null;
  currency: string | null;
}

export interface PayPalOrder {
  id: string;
  status: string;
  /** Where to send the buyer to approve the payment (only while approval is outstanding). */
  approveUrl: string | null;
  captures: PayPalCapture[];
}

export interface PayPalRefund {
  id: string;
  status: string;
}

/** A non-2xx answer from PayPal. `issue` is the first `details[].issue`, e.g. "INSTRUMENT_DECLINED". */
export class PayPalApiError extends Error {
  constructor(
    readonly status: number,
    readonly errorName: string,
    readonly issue: string | null,
    readonly debugId: string | null,
  ) {
    super(
      `PayPal API error ${status} ${errorName}${issue ? ` (${issue})` : ""}${debugId ? ` debug_id=${debugId}` : ""}`,
    );
    this.name = "PayPalApiError";
  }

  /** 4xx other than auth/rate limiting: PayPal understood and refused; retrying won't help. */
  get isDefinitive(): boolean {
    return this.status >= 400 && this.status < 500 && this.status !== 401 && this.status !== 408 && this.status !== 429;
  }
}

export interface PayPalClient {
  createOrder(input: {
    requestId: string;
    referenceId: string;
    /** Must be unique per PayPal account: PayPal refuses a reused invoice id (DUPLICATE_INVOICE_ID). */
    invoiceId: string;
    description: string;
    amountCents: Cents;
    currency: string;
    returnUrl: string;
    cancelUrl: string;
  }): Promise<PayPalOrder>;
  getOrder(orderId: string): Promise<PayPalOrder>;
  /** Idempotent for the same `requestId` (PayPal-Request-Id). */
  captureOrder(orderId: string, requestId: string): Promise<PayPalOrder>;
  getCapture(captureId: string): Promise<PayPalCapture>;
  /** Idempotent for the same `requestId` (PayPal-Request-Id). */
  refundCapture(input: {
    captureId: string;
    requestId: string;
    amountCents: Cents;
    currency: string;
    noteToPayer?: string;
  }): Promise<PayPalRefund>;
  getRefund(refundId: string): Promise<PayPalRefund>;
}

const TIMEOUT_MS = 20_000;
/**
 * Attempts per call when PayPal or the gateway answers 429 or 5xx. Retrying is safe: GETs are
 * read-only and every POST that changes money carries a PayPal-Request-Id, so a retry of a request
 * PayPal already processed returns the original result instead of doing it twice.
 */
export const PAYPAL_MAX_ATTEMPTS = 3;
const RETRY_DELAYS_MS = [200, 600];
const MAX_RETRY_AFTER_MS = 2_000;
const TRANSIENT_STATUSES = new Set([429, 500, 502, 503, 504]);
/** Approval links must point at PayPal itself before we redirect a buyer there. */
const APPROVAL_HOSTS = new Set(["www.paypal.com", "www.sandbox.paypal.com"]);

interface CachedToken {
  key: string;
  token: string;
  expiresAt: number;
}
let cachedToken: CachedToken | null = null;

/** For tests: forget the cached OAuth token. */
export function resetPayPalTokenCache(): void {
  cachedToken = null;
}

export function paypalConfigFromEnv(env: {
  PAYPAL_API_BASE?: string;
  PAYPAL_CLIENT_ID?: string;
  PAYPAL_CLIENT_SECRET?: string;
}): PayPalConfig {
  const apiBase = env.PAYPAL_API_BASE?.trim();
  const clientId = env.PAYPAL_CLIENT_ID?.trim();
  const clientSecret = env.PAYPAL_CLIENT_SECRET?.trim();
  if (!apiBase || !clientId || !clientSecret) {
    throw new Error("PayPal is not configured: set PAYPAL_API_BASE, PAYPAL_CLIENT_ID and PAYPAL_CLIENT_SECRET.");
  }
  const url = new URL(apiBase);
  if (url.protocol !== "https:" && url.hostname !== "localhost") {
    throw new Error("PAYPAL_API_BASE must use https.");
  }
  return { apiBase: apiBase.replace(/\/+$/, ""), clientId, clientSecret };
}

export function createPayPalClient(config: PayPalConfig): PayPalClient {
  const url = (path: string) => `${config.apiBase}${path}`;

  /** Sends a request, retrying transient failures (429, 5xx). `init` is called per attempt. */
  async function send(path: string, init: () => Promise<RequestInit>): Promise<Response> {
    for (let attempt = 1; ; attempt += 1) {
      const response = await fetch(url(path), { ...(await init()), signal: AbortSignal.timeout(TIMEOUT_MS) });
      if (!TRANSIENT_STATUSES.has(response.status) || attempt >= PAYPAL_MAX_ATTEMPTS) return response;
      await response.body?.cancel();
      await sleep(retryDelayMs(response, attempt));
    }
  }

  async function accessToken(): Promise<string> {
    const key = `${config.apiBase}|${config.clientId}`;
    if (cachedToken && cachedToken.key === key && cachedToken.expiresAt > Date.now()) return cachedToken.token;
    const response = await send("/v1/oauth2/token", async () => ({
      method: "POST",
      headers: {
        authorization: `Basic ${btoa(`${config.clientId}:${config.clientSecret}`)}`,
        "content-type": "application/x-www-form-urlencoded",
        accept: "application/json",
      },
      body: "grant_type=client_credentials",
    }));
    if (!response.ok) throw await apiError(response);
    const body = (await response.json()) as { access_token?: unknown; expires_in?: unknown };
    if (typeof body.access_token !== "string") throw new Error("PayPal token response had no access_token");
    const lifetime = typeof body.expires_in === "number" ? body.expires_in : 300;
    // Refresh a little early so a token never expires mid-request.
    cachedToken = { key, token: body.access_token, expiresAt: Date.now() + Math.max(lifetime - 120, 30) * 1000 };
    return body.access_token;
  }

  async function call(
    method: "GET" | "POST",
    path: string,
    options: { body?: unknown; requestId?: string } = {},
  ): Promise<unknown> {
    for (let attempt = 0; ; attempt += 1) {
      const response = await send(path, async () => {
        const headers: Record<string, string> = {
          authorization: `Bearer ${await accessToken()}`,
          accept: "application/json",
          prefer: "return=representation",
        };
        // PayPal rejects POSTs without a JSON content type (415 UNSUPPORTED_MEDIA_TYPE), even with no
        // body, e.g. capturing an order.
        if (method === "POST") headers["content-type"] = "application/json";
        // The same key on every retry, so PayPal processes the request at most once.
        if (options.requestId) headers["paypal-request-id"] = options.requestId;
        return { method, headers, body: options.body === undefined ? undefined : JSON.stringify(options.body) };
      });
      if (response.status === 401 && attempt === 0) {
        // Token revoked or expired early: fetch a new one and retry once.
        cachedToken = null;
        await response.body?.cancel();
        continue;
      }
      if (!response.ok) throw await apiError(response);
      return response.status === 204 ? {} : await response.json();
    }
  }

  return {
    async createOrder(input) {
      const body = {
        intent: "CAPTURE",
        purchase_units: [
          {
            reference_id: input.referenceId,
            custom_id: input.referenceId,
            invoice_id: input.invoiceId,
            description: input.description,
            amount: { currency_code: input.currency, value: centsToDecimal(input.amountCents) },
          },
        ],
        payment_source: {
          paypal: {
            experience_context: {
              brand_name: "Northwind Coffee",
              user_action: "PAY_NOW",
              shipping_preference: "NO_SHIPPING",
              return_url: input.returnUrl,
              cancel_url: input.cancelUrl,
            },
          },
        },
      };
      return toOrder(await call("POST", "/v2/checkout/orders", { body, requestId: input.requestId }));
    },
    async getOrder(orderId) {
      return toOrder(await call("GET", `/v2/checkout/orders/${encodeURIComponent(orderId)}`));
    },
    async captureOrder(orderId, requestId) {
      return toOrder(await call("POST", `/v2/checkout/orders/${encodeURIComponent(orderId)}/capture`, { requestId }));
    },
    async getCapture(captureId) {
      return toCapture(await call("GET", `/v2/payments/captures/${encodeURIComponent(captureId)}`));
    },
    async refundCapture(input) {
      const body: Record<string, unknown> = {
        amount: { currency_code: input.currency, value: centsToDecimal(input.amountCents) },
      };
      if (input.noteToPayer) body.note_to_payer = input.noteToPayer;
      return toRefund(
        await call("POST", `/v2/payments/captures/${encodeURIComponent(input.captureId)}/refund`, {
          body,
          requestId: input.requestId,
        }),
      );
    },
    async getRefund(refundId) {
      return toRefund(await call("GET", `/v2/payments/refunds/${encodeURIComponent(refundId)}`));
    },
  };
}

function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

/** Backoff before the next attempt; honours a numeric Retry-After (capped) when PayPal sends one. */
function retryDelayMs(response: Response, attempt: number): number {
  const fallback = RETRY_DELAYS_MS[Math.min(attempt, RETRY_DELAYS_MS.length) - 1] ?? 0;
  const retryAfter = Number(response.headers.get("retry-after"));
  if (!Number.isFinite(retryAfter) || retryAfter <= 0) return fallback;
  return Math.min(Math.max(retryAfter * 1000, fallback), MAX_RETRY_AFTER_MS);
}

async function apiError(response: Response): Promise<PayPalApiError> {
  let name = response.statusText || "HTTP_ERROR";
  let issue: string | null = null;
  let debugId: string | null = response.headers.get("paypal-debug-id");
  try {
    const body = (await response.json()) as {
      name?: unknown;
      error?: unknown;
      debug_id?: unknown;
      details?: { issue?: unknown }[];
    };
    if (typeof body.name === "string") name = body.name;
    else if (typeof body.error === "string") name = body.error;
    if (typeof body.debug_id === "string") debugId = body.debug_id;
    const first = body.details?.[0]?.issue;
    if (typeof first === "string") issue = first;
  } catch {
    // Not JSON (e.g. a gateway error page); status and name are enough.
  }
  return new PayPalApiError(response.status, name, issue, debugId);
}

function str(value: unknown): string | null {
  return typeof value === "string" ? value : null;
}

function toCapture(raw: unknown): PayPalCapture {
  const capture = (raw ?? {}) as {
    id?: unknown;
    status?: unknown;
    amount?: { value?: unknown; currency_code?: unknown };
  };
  const id = str(capture.id);
  const status = str(capture.status);
  if (!id || !status) throw new Error("PayPal capture response was missing id or status");
  const value = str(capture.amount?.value);
  return {
    id,
    status,
    amountCents: value === null ? null : parseDecimalToCents(value),
    currency: str(capture.amount?.currency_code),
  };
}

function toOrder(raw: unknown): PayPalOrder {
  const order = (raw ?? {}) as {
    id?: unknown;
    status?: unknown;
    links?: { rel?: unknown; href?: unknown }[];
    purchase_units?: { payments?: { captures?: unknown[] } }[];
  };
  const id = str(order.id);
  const status = str(order.status);
  if (!id || !status) throw new Error("PayPal order response was missing id or status");
  const link = order.links?.find((l) => l.rel === "payer-action" || l.rel === "approve");
  const href = str(link?.href);
  let approveUrl: string | null = null;
  if (href) {
    const parsed = new URL(href);
    if (parsed.protocol !== "https:" || !APPROVAL_HOSTS.has(parsed.hostname)) {
      throw new Error(`PayPal approval link has an unexpected host: ${parsed.hostname}`);
    }
    approveUrl = parsed.toString();
  }
  const captures = (order.purchase_units ?? []).flatMap((unit) => (unit.payments?.captures ?? []).map(toCapture));
  return { id, status, approveUrl, captures };
}

function toRefund(raw: unknown): PayPalRefund {
  const refund = (raw ?? {}) as { id?: unknown; status?: unknown };
  const id = str(refund.id);
  const status = str(refund.status);
  if (!id || !status) throw new Error("PayPal refund response was missing id or status");
  return { id, status };
}
