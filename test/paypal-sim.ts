/**
 * A stateful PayPal sandbox stand-in for tests, plugged in on the SDK's `fetch` seam.
 *
 * It keeps PayPal-side state (orders, captures, refunds), answers in PayPal's wire shape (snake_case), and
 * deduplicates writes by `PayPal-Request-Id` the way PayPal documents it (createOrder/captureOrder keep keys for 6 hours,
 * refunds for 45 days): a repeated key returns the original result instead of acting again. `effects` counts what
 * actually happened to money, so a test can assert "charged once, refunded once" whatever faults it injected.
 *
 * Faults are injected per route and consumed in order:
 *   429             answers 429 without acting
 *   503             answers 503 without acting
 *   timeout-before  never answers (until the request is aborted) and does not act
 *   timeout-after   acts, then never answers
 *   lost            acts, then the connection drops
 *   429-retry-after-1 / -30  answers 429 with Retry-After: 1 / 30 (seconds), without acting
 *   504-after       acts, then answers 504 (a gateway timeout after PayPal processed the request)
 *   409-in-progress answers 409 PREVIOUS_REQUEST_IN_PROGRESS without acting (an earlier attempt still running)
 */

export type Fault =
  | "429"
  | "503"
  | "timeout-before"
  | "timeout-after"
  | "lost"
  | "429-retry-after-1"
  | "429-retry-after-30"
  | "504-after"
  | "409-in-progress";

export interface SimRequest {
  method: string;
  path: string;
  requestId: string | null;
  idempotencyKey: string | null;
  json: Record<string, unknown> | undefined;
  at: number;
}

interface SimRefund {
  id: string;
  requestId: string;
  amountCents: number;
  customId: string | undefined;
}

interface SimCapture {
  id: string;
  orderId: string;
  amountCents: number;
  currency: string;
  refunds: SimRefund[];
}

interface SimOrder {
  id: string;
  requestId: string;
  status: "PAYER_ACTION_REQUIRED" | "APPROVED" | "COMPLETED";
  amountCents: number;
  currency: string;
  captureRequestId?: string;
  capture?: SimCapture;
}

export const SIM_BASE = "https://paypal-gateway.test/s/with";
const APPROVAL_HOST = "https://www.sandbox.paypal.com";

function json(status: number, body: unknown, headers: Record<string, string> = {}): Response {
  return new Response(JSON.stringify(body), {
    status,
    headers: { "content-type": "application/json", "paypal-debug-id": "sim-debug", ...headers },
  });
}

function error(
  status: number,
  name: string,
  issue: string,
  description: string,
  headers: Record<string, string> = {},
): Response {
  return json(
    status,
    { name, message: description, debug_id: "sim-debug", details: [{ issue, description }] },
    headers,
  );
}

function toCents(value: unknown): number {
  const match = /^(\d+)(?:\.(\d{1,2}))?$/.exec(String(value));
  if (!match) throw new Error(`sim: bad amount ${String(value)}`);
  return Number(match[1]) * 100 + Number((match[2] ?? "").padEnd(2, "0"));
}

function money(cents: number, currency: string) {
  return { currency_code: currency, value: `${Math.trunc(cents / 100)}.${String(cents % 100).padStart(2, "0")}` };
}

export class PaypalSim {
  readonly requests: SimRequest[] = [];
  /** What actually happened to money and orders at "PayPal". */
  readonly effects = { ordersCreated: 0, charges: 0, refunds: 0, refundedCents: 0 };
  /** While > 0, order reads omit refunds (a read that lags behind a refund). Each read decrements it. */
  staleRefundReads = 0;

  private readonly orders = new Map<string, SimOrder>();
  private readonly ordersByRequestId = new Map<string, SimOrder>();
  private readonly captures = new Map<string, SimCapture>();
  private readonly refundsByRequestId = new Map<string, SimRefund>();
  private readonly faults: { method: string; pattern: RegExp; fault: Fault }[] = [];
  private sequence = 0;
  /** Unique per simulator, so ids never collide with another test's in the shared database. */
  private readonly prefix = crypto.randomUUID().slice(0, 8).toUpperCase();

  /** Injects faults for the next matching requests, in order. */
  inject(method: string, pattern: RegExp, ...faults: Fault[]): this {
    for (const fault of faults) this.faults.push({ method, pattern, fault });
    return this;
  }

  /** The buyer approves the order on PayPal. */
  approve(orderId: string): void {
    const order = this.orders.get(orderId);
    if (order?.status !== "PAYER_ACTION_REQUIRED") throw new Error(`sim: cannot approve ${orderId}`);
    order.status = "APPROVED";
  }

  onlyOrderId(): string {
    const ids = [...this.orders.keys()];
    if (ids.length !== 1) throw new Error(`sim: expected one order, have ${ids.length}`);
    return ids[0] as string;
  }

  requestsTo(method: string, pattern: RegExp): SimRequest[] {
    return this.requests.filter((r) => r.method === method && pattern.test(r.path));
  }

  readonly fetch = async (input: RequestInfo | URL, init?: RequestInit): Promise<Response> => {
    const request = new Request(input, init);
    const url = new URL(request.url);
    if (!url.href.startsWith(SIM_BASE)) throw new Error(`sim: unexpected host ${url.origin}`);
    const path = url.pathname.slice(new URL(SIM_BASE).pathname.length);
    const text = request.body === null ? "" : new TextDecoder().decode(await request.arrayBuffer());
    const parsed =
      text && request.headers.get("content-type")?.includes("json")
        ? (JSON.parse(text) as Record<string, unknown>)
        : undefined;
    this.requests.push({
      method: request.method,
      path,
      requestId: request.headers.get("paypal-request-id"),
      idempotencyKey: request.headers.get("idempotency-key"),
      json: parsed,
      at: Date.now(),
    });

    const act = () => this.handle(request.method, path, request.headers, parsed);
    const index = this.faults.findIndex((f) => f.method === request.method && f.pattern.test(path));
    if (index === -1) return act();
    const fault = this.faults.splice(index, 1)[0]?.fault;
    if (!fault) return act();
    switch (fault) {
      case "429":
        return error(429, "RATE_LIMIT_REACHED", "RATE_LIMIT_REACHED", "Too many requests.");
      case "503":
        return json(503, { name: "SERVICE_UNAVAILABLE", message: "Service unavailable.", debug_id: "sim-debug" });
      case "timeout-before":
        return hangUntilAborted(request.signal);
      case "timeout-after":
        act();
        return hangUntilAborted(request.signal);
      case "lost":
        act();
        throw new TypeError("sim: connection lost after PayPal acted");
      case "429-retry-after-1":
        return error(429, "RATE_LIMIT_REACHED", "RATE_LIMIT_REACHED", "Too many requests.", { "retry-after": "1" });
      case "429-retry-after-30":
        return error(429, "RATE_LIMIT_REACHED", "RATE_LIMIT_REACHED", "Too many requests.", { "retry-after": "30" });
      case "504-after":
        act();
        return json(504, { name: "GATEWAY_TIMEOUT", message: "Upstream timed out.", debug_id: "sim-debug" });
      case "409-in-progress":
        return error(
          409,
          "RESOURCE_CONFLICT",
          "PREVIOUS_REQUEST_IN_PROGRESS",
          "A previous request on this resource is currently in progress.",
        );
    }
  };

  private nextId(prefix: string): string {
    this.sequence += 1;
    return `${prefix}${this.prefix}${String(this.sequence).padStart(4, "0")}`;
  }

  private handle(method: string, path: string, headers: Headers, body: Record<string, unknown> | undefined): Response {
    const requestId = headers.get("paypal-request-id");
    if (method === "POST" && path === "/v1/oauth2/token") {
      return json(200, { access_token: "sim-access-token", token_type: "Bearer", expires_in: 3600 });
    }
    if (headers.get("authorization") !== "Bearer sim-access-token") {
      return error(401, "AUTHENTICATION_FAILURE", "INVALID_TOKEN", "Authentication failed.");
    }

    if (method === "POST" && path === "/v2/checkout/orders") {
      if (!requestId) return error(400, "INVALID_REQUEST", "MISSING_REQUEST_ID", "PayPal-Request-Id is required.");
      const existing = this.ordersByRequestId.get(requestId);
      if (existing) return json(200, this.minimal(existing));
      const unit = (body?.purchase_units as { amount: { currency_code: string; value: string } }[] | undefined)?.[0];
      if (!unit) return error(400, "INVALID_REQUEST", "MISSING_REQUIRED_PARAMETER", "purchase_units is required.");
      const order: SimOrder = {
        id: this.nextId("SIMORDER"),
        requestId,
        status: "PAYER_ACTION_REQUIRED",
        amountCents: toCents(unit.amount.value),
        currency: unit.amount.currency_code,
      };
      this.orders.set(order.id, order);
      this.ordersByRequestId.set(requestId, order);
      this.effects.ordersCreated += 1;
      return json(200, this.minimal(order));
    }

    const capturePath = /^\/v2\/checkout\/orders\/([^/]+)\/capture$/.exec(path);
    if (method === "POST" && capturePath) {
      const order = this.orders.get(capturePath[1] as string);
      if (!order)
        return error(404, "RESOURCE_NOT_FOUND", "INVALID_RESOURCE_ID", "Specified resource ID does not exist.");
      if (order.capture) {
        if (requestId !== null && requestId === order.captureRequestId) return json(201, this.full(order));
        return error(422, "UNPROCESSABLE_ENTITY", "ORDER_ALREADY_CAPTURED", "Order already captured.");
      }
      if (order.status !== "APPROVED") {
        return error(422, "UNPROCESSABLE_ENTITY", "ORDER_NOT_APPROVED", "Payer has not yet approved the Order.");
      }
      const capture: SimCapture = {
        id: this.nextId("SIMCAPTURE"),
        orderId: order.id,
        amountCents: order.amountCents,
        currency: order.currency,
        refunds: [],
      };
      order.capture = capture;
      order.captureRequestId = requestId ?? undefined;
      order.status = "COMPLETED";
      this.captures.set(capture.id, capture);
      this.effects.charges += 1;
      return json(201, this.full(order));
    }

    const orderPath = /^\/v2\/checkout\/orders\/([^/]+)$/.exec(path);
    if (method === "GET" && orderPath) {
      const order = this.orders.get(orderPath[1] as string);
      if (!order)
        return error(404, "RESOURCE_NOT_FOUND", "INVALID_RESOURCE_ID", "Specified resource ID does not exist.");
      const hideRefunds = this.staleRefundReads > 0;
      if (hideRefunds) this.staleRefundReads -= 1;
      return json(200, this.full(order, hideRefunds));
    }

    const refundPath = /^\/v2\/payments\/captures\/([^/]+)\/refund$/.exec(path);
    if (method === "POST" && refundPath) {
      const capture = this.captures.get(refundPath[1] as string);
      if (!capture)
        return error(404, "RESOURCE_NOT_FOUND", "INVALID_RESOURCE_ID", "Specified resource ID does not exist.");
      if (!requestId) return error(400, "INVALID_REQUEST", "MISSING_REQUEST_ID", "PayPal-Request-Id is required.");
      const replay = this.refundsByRequestId.get(requestId);
      if (replay) return json(201, { id: replay.id, status: "COMPLETED" });
      const refunded = capture.refunds.reduce((sum, r) => sum + r.amountCents, 0);
      const amount = body?.amount as { value: string } | undefined;
      const amountCents = amount ? toCents(amount.value) : capture.amountCents - refunded;
      if (amountCents > capture.amountCents - refunded) {
        return error(422, "UNPROCESSABLE_ENTITY", "REFUND_AMOUNT_EXCEEDED", "The refund amount exceeds the capture.");
      }
      const refund: SimRefund = {
        id: this.nextId("SIMREFUND"),
        requestId,
        amountCents,
        customId: typeof body?.custom_id === "string" ? body.custom_id : undefined,
      };
      capture.refunds.push(refund);
      this.refundsByRequestId.set(requestId, refund);
      this.effects.refunds += 1;
      this.effects.refundedCents += amountCents;
      return json(201, { id: refund.id, status: "COMPLETED" });
    }

    const captureGet = /^\/v2\/payments\/captures\/([^/]+)$/.exec(path);
    if (method === "GET" && captureGet) {
      const capture = this.captures.get(captureGet[1] as string);
      if (!capture)
        return error(404, "RESOURCE_NOT_FOUND", "INVALID_RESOURCE_ID", "Specified resource ID does not exist.");
      return json(200, { id: capture.id, status: "COMPLETED", amount: money(capture.amountCents, capture.currency) });
    }

    return error(404, "NOT_FOUND", "UNKNOWN_ROUTE", `sim has no route for ${method} ${path}`);
  }

  private minimal(order: SimOrder) {
    return {
      id: order.id,
      status: order.status,
      links: [
        { href: `https://api.sandbox.paypal.com/v2/checkout/orders/${order.id}`, rel: "self", method: "GET" },
        { href: `${APPROVAL_HOST}/checkoutnow?token=${order.id}`, rel: "payer-action", method: "GET" },
      ],
    };
  }

  private full(order: SimOrder, hideRefunds = false) {
    const capture = order.capture;
    const refunded = capture?.refunds.reduce((sum, r) => sum + r.amountCents, 0) ?? 0;
    const captureStatus =
      capture && refunded >= capture.amountCents ? "REFUNDED" : refunded > 0 ? "PARTIALLY_REFUNDED" : "COMPLETED";
    return {
      ...this.minimal(order),
      intent: "CAPTURE",
      purchase_units: [
        {
          reference_id: "default",
          amount: money(order.amountCents, order.currency),
          ...(capture
            ? {
                payments: {
                  captures: [
                    { id: capture.id, status: captureStatus, amount: money(capture.amountCents, capture.currency) },
                  ],
                  ...(hideRefunds
                    ? {}
                    : {
                        refunds: capture.refunds.map((r) => ({
                          id: r.id,
                          status: "COMPLETED",
                          amount: money(r.amountCents, capture.currency),
                          ...(r.customId ? { custom_id: r.customId } : {}),
                        })),
                      }),
                },
              }
            : {}),
        },
      ],
    };
  }
}

function hangUntilAborted(signal: AbortSignal): Promise<Response> {
  return new Promise((_resolve, reject) => {
    if (signal.aborted) reject(signal.reason);
    signal.addEventListener("abort", () => reject(signal.reason), { once: true });
  });
}
