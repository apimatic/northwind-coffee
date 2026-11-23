import type { ContentfulStatusCode } from "hono/utils/http-status";
import { ApiError, PaypalClient, PaypalError, type RetryAttempt } from "paypal";
import { log } from "./log";

/**
 * PayPal REST client for this Worker.
 *
 * Every call goes through the egress gateway in PAYPAL_API_BASE (never straight to api-m.paypal.com), and the
 * OAuth token request follows the same base URL. PAYPAL_ENV says which PayPal environment the credentials
 * belong to; it decides which approval host we will redirect buyers to.
 */

export type PaypalEnvironment = "sandbox" | "live";

const APPROVAL_HOSTS: Record<PaypalEnvironment, string> = {
  sandbox: "www.sandbox.paypal.com",
  live: "www.paypal.com",
};

export interface PaypalBindings {
  PAYPAL_ENV?: string;
  PAYPAL_API_BASE?: string;
  PAYPAL_CLIENT_ID?: string;
  PAYPAL_CLIENT_SECRET?: string;
}

/** What services need to talk to PayPal. */
export interface Paypal {
  client: PaypalClient;
  environment: PaypalEnvironment;
  /** Wall-clock budget for one operation's PayPal calls (every attempt, retry wait and the token request). */
  budgetMs: number;
  /** Separate budget for re-reading PayPal after a write whose outcome we did not learn. */
  rereadBudgetMs: number;
}

/**
 * Timeouts. `retry.timeout` bounds one attempt only (up to the response headers), and a GET may get a second
 * attempt, so each operation also runs under a deadline signal covering all of its calls. Worst case for one
 * request: a write phase of budgetMs plus, after an unknown outcome, a re-read of rereadBudgetMs.
 */
export interface PaypalTiming {
  attemptTimeoutMs: number;
  budgetMs: number;
  rereadBudgetMs: number;
  /** Wait before the one retry of a GET (the SDK adds jitter and honours Retry-After). */
  retryDelayMs: number;
}

export const DEFAULT_PAYPAL_TIMING: PaypalTiming = {
  attemptTimeoutMs: 10_000,
  budgetMs: 25_000,
  rereadBudgetMs: 10_000,
  retryDelayMs: 1_000,
};

/**
 * Statuses the SDK retries: its defaults (408, 429 and 5xx), plus 401, because a 401 drops the cached token and the
 * retry fetches a fresh one. On a 401, 408, 429 or 5xx PayPal either did not act or, for a write, deduplicates the
 * retry on its PayPal-Request-Id (see RETRY_METHODS).
 */
const RETRY_STATUSES = [401, 408, 429, 500, 502, 503, 504];

/**
 * POST is in the gate so that a brief 429 or 5xx on createOrder, captureOrder or refundCapturedPayment (and on the
 * token request) is retried instead of shown to the shopper. This is safe because every write we send carries a
 * PayPal-Request-Id stored on its claim, and the SDK re-sends the very same request on a retry (same
 * PayPal-Request-Id, same Idempotency-Key), which PayPal deduplicates. Our own later retries reuse the stored id too.
 */
const RETRY_METHODS: ("GET" | "HEAD" | "PUT" | "OPTIONS" | "POST")[] = ["GET", "HEAD", "PUT", "OPTIONS", "POST"];

const TOKEN_PATH = "/v1/oauth2/token";

/**
 * The SDK's method gate also re-sends a request whose answer was lost (connection dropped, attempt timed out), and
 * has no option to retry statuses only. A write whose answer was lost is settled by re-reading PayPal instead, so
 * this callback (which runs before each retry and ends the call with whatever it throws) stops a fault retry of
 * anything but a GET by rethrowing the fault exactly as an unretried call would. Status retries go ahead.
 */
function onRetry(attempt: RetryAttempt): void {
  const { reason } = attempt;
  if (reason.kind === "fault" && reason.error.method !== "GET") throw reason.error;
  log({
    event: "paypal_retry",
    attempt: attempt.attemptNumber,
    delayMs: attempt.delay,
    ...(reason.kind === "status"
      ? { status: reason.status }
      : { fault: reason.error.kind, tokenRequest: reason.error.uri.endsWith(TOKEN_PATH) }),
  });
}

export class PaypalConfigError extends Error {
  override name = "PaypalConfigError";
}

const clients = new Map<string, Paypal>();

/**
 * Builds a PayPal client with this app's retry, timeout and logging policy. Production code goes through
 * `paypalFor`; tests call this with a fake `fetch` and shorter timings, keeping the same policy.
 */
export function createPaypal(options: {
  environment: PaypalEnvironment;
  baseUrl: string;
  clientId: string;
  clientSecret: string;
  timing?: Partial<PaypalTiming>;
  fetch?: typeof fetch;
}): Paypal {
  const timing = { ...DEFAULT_PAYPAL_TIMING, ...options.timing };
  const transport = options.fetch;
  const client = new PaypalClient({
    serverOptions: { baseUrl: options.baseUrl },
    oauth2: { clientId: options.clientId, clientSecret: options.clientSecret },
    retry: {
      // Per attempt, up to the response headers. The whole operation is bounded by its deadline signal, which also
      // cuts short a backoff wait (a long Retry-After included) that would run past it.
      timeout: timing.attemptTimeoutMs,
      // One retry: GETs on a status or a fault, POSTs on a status only (see onRetry). Retry-After is honoured.
      maxRetries: 1,
      delay: timing.retryDelayMs,
      httpMethodsToRetry: RETRY_METHODS,
      statusCodesToRetry: RETRY_STATUSES,
      onRetry,
    },
    // Explicitly off, so the PAYPAL_CLIENT_LOG variable cannot turn request logging on. Our own log lines carry
    // PayPal's debug id instead; request bodies are never logged.
    logging: { level: "off" },
    // Late-bound so the Worker's global fetch is used at call time. The Request (and its signal) is forwarded.
    fetch: transport ? (request) => transport(request) : (request) => fetch(request),
  });
  return {
    client,
    environment: options.environment,
    budgetMs: timing.budgetMs,
    rereadBudgetMs: timing.rereadBudgetMs,
  };
}

/**
 * Returns the PayPal client for these bindings, built once per isolate so the OAuth token cache is shared
 * between requests. Throws PaypalConfigError when a binding is missing or malformed.
 */
export function paypalFor(env: PaypalBindings): Paypal {
  const environment = env.PAYPAL_ENV;
  if (environment !== "sandbox" && environment !== "live") {
    throw new PaypalConfigError("PAYPAL_ENV must be 'sandbox' or 'live'");
  }
  const baseUrl = env.PAYPAL_API_BASE?.trim().replace(/\/+$/, "") ?? "";
  if (!URL.canParse(baseUrl) || new URL(baseUrl).protocol !== "https:") {
    throw new PaypalConfigError("PAYPAL_API_BASE must be an https URL");
  }
  const clientId = env.PAYPAL_CLIENT_ID?.trim() ?? "";
  const clientSecret = env.PAYPAL_CLIENT_SECRET?.trim() ?? "";
  if (!clientId || !clientSecret) {
    throw new PaypalConfigError("PAYPAL_CLIENT_ID and PAYPAL_CLIENT_SECRET must be set");
  }

  const key = `${environment}\n${baseUrl}\n${clientId}`;
  let paypal = clients.get(key);
  if (!paypal) {
    paypal = createPaypal({ environment, baseUrl, clientId, clientSecret });
    clients.set(key, paypal);
  }
  return paypal;
}

/** The PayPal origins a form may be redirected to (for the CSP form-action directive). */
export const PAYPAL_FORM_ACTION_SOURCE = "https://*.paypal.com";

/**
 * Picks the buyer approval link from a PayPal order's links, accepting only an https link on the approval host
 * for this environment.
 */
export function approvalUrlFrom(
  links: readonly { href: string; rel: string }[] | undefined,
  environment: PaypalEnvironment,
): string | null {
  const link = links?.find((l) => l.rel === "payer-action" || l.rel === "approve");
  if (!link || !URL.canParse(link.href)) return null;
  const url = new URL(link.href);
  if (url.protocol !== "https:" || url.host !== APPROVAL_HOSTS[environment]) return null;
  return url.toString();
}

/** Our own deadline for an operation's PayPal calls ran out (the abort reason the SDK hands back unwrapped). */
export class PaypalDeadlineError extends Error {
  override name = "PaypalDeadlineError";
  constructor(readonly budgetMs: number) {
    super(`PayPal calls exceeded their ${budgetMs} ms budget`);
  }
}

/** A signal that aborts with PaypalDeadlineError after `ms`. Pass it to every SDK call of one operation. */
export function paypalDeadline(ms: number): AbortSignal {
  const controller = new AbortController();
  setTimeout(() => controller.abort(new PaypalDeadlineError(ms)), ms);
  return controller.signal;
}

/** A PayPal failure, translated once so every call site handles each kind the same way. */
export type PaypalFailure =
  /** PayPal refused what we sent for the caller (4xx other than 401/403/429). Nothing happened at PayPal. */
  | { kind: "rejected"; status: number; reason: string; issue: string | undefined; debugId: string | undefined }
  /**
   * PayPal reported a conflict on a write (409, or an "in progress"/duplicate-request issue): typically an earlier
   * attempt with the same PayPal-Request-Id is still being processed. PayPal may yet act, so on a write the outcome is
   * unknown and is settled by re-reading, never treated as a refusal.
   */
  | { kind: "conflict"; status: number; issue: string | undefined; debugId: string | undefined }
  /** PayPal refused our credentials (401/403). Nothing happened at PayPal. */
  | { kind: "credentials"; status: number; debugId: string | undefined }
  /** Our PayPal quota is spent (429). Nothing happened at PayPal. */
  | { kind: "rate_limited"; debugId: string | undefined }
  /** PayPal answered 5xx (or an unexpected status). On a write the outcome is unknown. */
  | { kind: "server_error"; status: number; debugId: string | undefined }
  /** No usable answer (connection, timeout, unreadable 2xx body). On a write the outcome is unknown. */
  | { kind: "no_response"; detail: string }
  /**
   * The request never left: the token endpoint refused our credentials, could not be reached, or a value would not
   * encode. Nothing happened at PayPal.
   */
  | { kind: "not_sent"; why: "credentials" | "unreachable" | "encode"; detail: string };

interface PaypalErrorBody {
  message?: unknown;
  debugId?: unknown;
  details?: unknown;
}

/**
 * The error body, whichever arm it landed in: a declared arm's decoded body, or the raw bytes of an undeclared one
 * (a status the operation does not describe, or a body that did not fit PayPal's error schema, e.g. from the
 * gateway). Raw bytes are parsed as JSON when they are JSON; anything else (an HTML page) yields undefined.
 */
function errorBodyOf(payload: unknown): PaypalErrorBody | undefined {
  if (typeof payload !== "object" || payload === null) return undefined;
  let body: unknown;
  if ("rawBody" in payload && payload.rawBody instanceof ArrayBuffer) {
    try {
      body = JSON.parse(new TextDecoder().decode(payload.rawBody));
    } catch {
      return undefined;
    }
  } else if ("body" in payload) {
    body = payload.body;
  }
  if (typeof body !== "object" || body === null) return undefined;
  const raw = body as PaypalErrorBody & { debug_id?: unknown };
  return { message: raw.message, details: raw.details, debugId: raw.debugId ?? raw.debug_id };
}

function firstDetail(body: PaypalErrorBody | undefined): { issue?: string; description?: string } {
  if (!Array.isArray(body?.details)) return {};
  const first: unknown = body.details[0];
  if (typeof first !== "object" || first === null) return {};
  const { issue, description } = first as { issue?: unknown; description?: unknown };
  return {
    ...(typeof issue === "string" ? { issue } : {}),
    ...(typeof description === "string" ? { description } : {}),
  };
}

const MAX_REASON_LENGTH = 300;

/** Issue codes that mean "an earlier attempt of this request may still be in progress", not a refusal. */
const CONFLICT_ISSUES = new Set(["PREVIOUS_REQUEST_IN_PROGRESS", "DUPLICATE_REQUEST_ID"]);

function fromStatus(status: number, payload: unknown, headers: Headers): PaypalFailure {
  const body = errorBodyOf(payload);
  // PayPal's correlation id: from the error body, else the Paypal-Debug-Id response header (e.g. a bodiless 500).
  const debugId =
    (typeof body?.debugId === "string" ? body.debugId : undefined) ?? headers.get("paypal-debug-id") ?? undefined;
  if (status === 401 || status === 403) return { kind: "credentials", status, debugId };
  if (status === 429) return { kind: "rate_limited", debugId };
  if (status >= 400 && status < 500) {
    const detail = firstDetail(body);
    if (status === 409 || (detail.issue !== undefined && CONFLICT_ISSUES.has(detail.issue))) {
      return { kind: "conflict", status, issue: detail.issue, debugId };
    }
    const message = typeof body?.message === "string" ? body.message : undefined;
    const reason = (detail.description ?? message ?? "PayPal could not accept this request.").slice(
      0,
      MAX_REASON_LENGTH,
    );
    return { kind: "rejected", status, reason, issue: detail.issue, debugId };
  }
  return { kind: "server_error", status, debugId };
}

/**
 * Translates anything a PayPal SDK call threw, by `err.kind` and then the HTTP status (never by an operation's arm
 * tags). Our own deadline is a lost answer. Anything else outside the SDK's family (a bug, a configuration fault, a
 * foreign abort) is rethrown.
 */
export function classifyPaypalError(error: unknown): PaypalFailure {
  if (error instanceof PaypalDeadlineError) return { kind: "no_response", detail: "deadline" };
  if (!(error instanceof PaypalError)) throw error;
  switch (error.kind) {
    case "api":
      return fromStatus(error.status, error.payload, error.headers);
    case "decode":
      // A 2xx we could not read means PayPal may have acted. An error status we could not read is still that status.
      if (error.status >= 200 && error.status < 300) {
        return { kind: "no_response", detail: `unreadable ${error.status} response` };
      }
      return fromStatus(error.status, undefined, error.headers);
    case "connection":
    case "timeout":
      // A fault on the OAuth token request reaches us unwrapped, naming the token endpoint: the operation itself
      // was never sent, so there is nothing to re-read.
      if (error.uri.endsWith(TOKEN_PATH)) {
        return { kind: "not_sent", why: "unreachable", detail: `${error.kind} on token request` };
      }
      return { kind: "no_response", detail: error.kind };
    case "auth":
      // The token endpoint's own answer is on `cause`; keep its status for the log.
      return {
        kind: "not_sent",
        why: "credentials",
        detail: error.cause instanceof ApiError ? `auth: token endpoint answered ${error.cause.status}` : "auth",
      };
    case "encode":
      return { kind: "not_sent", why: "encode", detail: "encode" };
  }
}

/** True when PayPal certainly did not act on the request. */
export function definitelyNotApplied(failure: PaypalFailure): boolean {
  return (
    failure.kind === "rejected" ||
    failure.kind === "credentials" ||
    failure.kind === "rate_limited" ||
    failure.kind === "not_sent"
  );
}

/** HTTP status and message for the person who triggered the call. */
export function presentPaypalFailure(failure: PaypalFailure): { status: ContentfulStatusCode; message: string } {
  switch (failure.kind) {
    case "rejected":
      // The same 4xx PayPal answered, with PayPal's own reason.
      return {
        status: failure.status as ContentfulStatusCode,
        message: `PayPal declined the request: ${failure.reason}`,
      };
    case "not_sent":
      if (failure.why === "unreachable") return { status: 502, message: "We couldn't reach PayPal. Please try again." };
      return { status: 502, message: "PayPal is not available right now because of a store configuration problem." };
    case "credentials":
      return { status: 502, message: "PayPal is not available right now because of a store configuration problem." };
    case "rate_limited":
      return { status: 503, message: "PayPal is busy right now. Please try again in a minute." };
    case "conflict":
      return { status: 503, message: "PayPal is still processing an earlier attempt. Please try again in a moment." };
    case "server_error":
      return { status: 502, message: "PayPal had a problem handling the request. Please try again." };
    case "no_response":
      return { status: 502, message: "We couldn't reach PayPal. Please try again." };
  }
}
