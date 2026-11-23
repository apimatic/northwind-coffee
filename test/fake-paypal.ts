/**
 * An in-memory PayPal (OAuth, Orders v2, Payments v2) behind the test egress gateway URL.
 * `installFakePayPal()` replaces global fetch for the test; any request to another host fails
 * the test, which also proves every PayPal call goes through PAYPAL_API_BASE.
 */
import { env } from "cloudflare:workers";
import { afterEach, vi } from "vitest";
import { resetPayPalTokenCache } from "../src/lib/paypal";

type Json = Record<string, unknown>;

interface FakeCapture {
  id: string;
  status: string;
  value: string;
  currency: string;
  orderId: string;
}

interface FakeOrder {
  id: string;
  status: "PAYER_ACTION_REQUIRED" | "APPROVED" | "COMPLETED";
  value: string;
  currency: string;
  body: Json;
  captureId: string | null;
}

interface FakeRefund {
  id: string;
  status: string;
  value: string;
  captureId: string;
}

export interface RecordedRequest {
  method: string;
  path: string;
  requestId: string | null;
  body: Json | null;
}

export class FakePayPal {
  readonly orders = new Map<string, FakeOrder>();
  readonly captures = new Map<string, FakeCapture>();
  readonly refunds = new Map<string, FakeRefund>();
  readonly requests: RecordedRequest[] = [];
  private readonly idempotent = new Map<string, { status: number; body: Json }>();
  private readonly tokens = new Set<string>();

  /** Status PayPal gives new captures. */
  captureStatus: "COMPLETED" | "PENDING" = "COMPLETED";
  /** Status PayPal gives new refunds. */
  refundStatus: "COMPLETED" | "PENDING" = "COMPLETED";
  /** Next capture is declined with 422 INSTRUMENT_DECLINED. */
  declineNextCapture = false;
  /** Next order creation fails with a 503. */
  failNextCreate = false;
  /** Process the next matching call, then lose the response (503), like a timeout after success. */
  loseNextResponseFor: "capture" | "refund" | null = null;
  /** Next refund is refused with 422 and this issue. */
  refuseNextRefund: string | null = null;
  /** Overrides the captured amount (to simulate a mismatch). */
  captureValueOverride: string | null = null;

  readonly base = String(env.PAYPAL_API_BASE).replace(/\/+$/, "");

  /** The buyer approves the payment on PayPal. */
  approve(orderId: string): void {
    const order = this.orders.get(orderId);
    if (!order) throw new Error(`fake PayPal: no order ${orderId}`);
    if (order.status === "PAYER_ACTION_REQUIRED") order.status = "APPROVED";
  }

  /** PayPal finishes processing pending captures/refunds. */
  settle(status: "COMPLETED" | "DECLINED" = "COMPLETED"): void {
    for (const capture of this.captures.values()) if (capture.status === "PENDING") capture.status = status;
    for (const refund of this.refunds.values()) if (refund.status === "PENDING") refund.status = "COMPLETED";
  }

  calls(method: string, pattern: RegExp): RecordedRequest[] {
    return this.requests.filter((r) => r.method === method && pattern.test(r.path));
  }

  get lastOrderId(): string {
    const ids = [...this.orders.keys()];
    const id = ids[ids.length - 1];
    if (!id) throw new Error("fake PayPal: no orders yet");
    return id;
  }

  async handle(request: Request): Promise<Response> {
    if (!request.url.startsWith(`${this.base}/`)) {
      throw new Error(`Unexpected outbound request (not through the PayPal gateway): ${request.url}`);
    }
    const path = request.url.slice(this.base.length).split("?")[0] ?? "";
    const text = new TextDecoder().decode(await request.arrayBuffer());
    const contentType = request.headers.get("content-type") ?? "";
    const body = text && contentType.includes("json") ? (JSON.parse(text) as Json) : null;
    const requestId = request.headers.get("paypal-request-id");
    this.requests.push({ method: request.method, path, requestId, body });

    if (request.method === "POST" && path === "/v1/oauth2/token") {
      const expected = `Basic ${btoa(`${env.PAYPAL_CLIENT_ID}:${env.PAYPAL_CLIENT_SECRET}`)}`;
      if (request.headers.get("authorization") !== expected || text !== "grant_type=client_credentials") {
        return json(401, { error: "invalid_client" });
      }
      const token = `A21AA${crypto.randomUUID().replaceAll("-", "")}`;
      this.tokens.add(token);
      return json(200, { access_token: token, token_type: "Bearer", expires_in: 32400 });
    }

    const bearer = request.headers.get("authorization")?.replace(/^Bearer /, "") ?? "";
    if (!this.tokens.has(bearer)) return json(401, { name: "AUTHENTICATION_FAILURE" });

    if (requestId && this.idempotent.has(`${path}|${requestId}`)) {
      const cached = this.idempotent.get(`${path}|${requestId}`) as { status: number; body: Json };
      return json(cached.status, cached.body);
    }
    const remember = (status: number, responseBody: Json): Response => {
      if (requestId) this.idempotent.set(`${path}|${requestId}`, { status, body: responseBody });
      return json(status, responseBody);
    };
    const lose = (kind: "capture" | "refund", response: Response): Response => {
      if (this.loseNextResponseFor !== kind) return response;
      this.loseNextResponseFor = null;
      return json(503, { name: "SERVICE_UNAVAILABLE" });
    };

    const param = (method: string, pattern: RegExp): string | null =>
      request.method === method ? (pattern.exec(path)?.[1] ?? null) : null;
    const captureOrderId = param("POST", /^\/v2\/checkout\/orders\/([A-Z0-9]+)\/capture$/);
    const getOrderId = param("GET", /^\/v2\/checkout\/orders\/([A-Z0-9]+)$/);
    const getCaptureId = param("GET", /^\/v2\/payments\/captures\/([A-Z0-9]+)$/);
    const refundCaptureId = param("POST", /^\/v2\/payments\/captures\/([A-Z0-9]+)\/refund$/);
    const getRefundId = param("GET", /^\/v2\/payments\/refunds\/([A-Z0-9]+)$/);

    if (request.method === "POST" && path === "/v2/checkout/orders") {
      if (this.failNextCreate) {
        this.failNextCreate = false;
        return json(503, { name: "SERVICE_UNAVAILABLE" });
      }
      const unit = (body?.purchase_units as Json[] | undefined)?.[0] as {
        amount: { value: string; currency_code: string };
      };
      const id = randomId();
      this.orders.set(id, {
        id,
        status: "PAYER_ACTION_REQUIRED",
        value: unit.amount.value,
        currency: unit.amount.currency_code,
        body: body ?? {},
        captureId: null,
      });
      return remember(200, {
        id,
        status: "PAYER_ACTION_REQUIRED",
        links: [
          { href: `https://api.sandbox.paypal.com/v2/checkout/orders/${id}`, rel: "self", method: "GET" },
          { href: `https://www.sandbox.paypal.com/checkoutnow?token=${id}`, rel: "payer-action", method: "GET" },
        ],
      });
    }

    if (captureOrderId) {
      const order = this.orders.get(captureOrderId);
      if (!order) return json(404, { name: "RESOURCE_NOT_FOUND", details: [{ issue: "INVALID_RESOURCE_ID" }] });
      if (order.status === "COMPLETED") return unprocessable("ORDER_ALREADY_CAPTURED");
      if (order.status !== "APPROVED") return unprocessable("ORDER_NOT_APPROVED");
      if (this.declineNextCapture) {
        this.declineNextCapture = false;
        return remember(422, { name: "UNPROCESSABLE_ENTITY", details: [{ issue: "INSTRUMENT_DECLINED" }] });
      }
      const capture: FakeCapture = {
        id: randomId(),
        status: this.captureStatus,
        value: this.captureValueOverride ?? order.value,
        currency: order.currency,
        orderId: order.id,
      };
      this.captures.set(capture.id, capture);
      order.status = "COMPLETED";
      order.captureId = capture.id;
      return lose("capture", remember(201, orderJson(order, capture)));
    }

    if (getOrderId) {
      const order = this.orders.get(getOrderId);
      if (!order) return json(404, { name: "RESOURCE_NOT_FOUND" });
      return json(200, orderJson(order, order.captureId ? this.captures.get(order.captureId) : undefined));
    }

    if (getCaptureId) {
      const capture = this.captures.get(getCaptureId);
      if (!capture) return json(404, { name: "RESOURCE_NOT_FOUND" });
      return json(200, captureJson(capture));
    }

    if (refundCaptureId) {
      const capture = this.captures.get(refundCaptureId);
      if (!capture) return json(404, { name: "RESOURCE_NOT_FOUND" });
      if (this.refuseNextRefund) {
        const issue = this.refuseNextRefund;
        this.refuseNextRefund = null;
        return remember(422, { name: "UNPROCESSABLE_ENTITY", details: [{ issue }] });
      }
      const amount = body?.amount as { value: string; currency_code: string };
      const refunded = [...this.refunds.values()]
        .filter((r) => r.captureId === capture.id && r.status !== "FAILED")
        .reduce((total, r) => total + toCents(r.value), 0);
      if (toCents(amount.value) + refunded > toCents(capture.value)) return unprocessable("REFUND_AMOUNT_EXCEEDED");
      const refund: FakeRefund = {
        id: randomId(),
        status: this.refundStatus,
        value: amount.value,
        captureId: capture.id,
      };
      this.refunds.set(refund.id, refund);
      return lose("refund", remember(201, refundJson(refund)));
    }

    if (getRefundId) {
      const refund = this.refunds.get(getRefundId);
      if (!refund) return json(404, { name: "RESOURCE_NOT_FOUND" });
      return json(200, refundJson(refund));
    }

    return json(404, { name: "RESOURCE_NOT_FOUND", message: `fake PayPal: no route for ${request.method} ${path}` });
  }
}

function randomId(): string {
  return crypto.randomUUID().replaceAll("-", "").slice(0, 17).toUpperCase();
}

function toCents(value: string): number {
  const [whole = "0", fraction = ""] = value.split(".");
  return Number(whole) * 100 + Number(fraction.padEnd(2, "0"));
}

function json(status: number, body: Json): Response {
  return new Response(JSON.stringify(body), {
    status,
    headers: { "content-type": "application/json", "paypal-debug-id": "fakedebug123" },
  });
}

function unprocessable(issue: string): Response {
  return json(422, { name: "UNPROCESSABLE_ENTITY", details: [{ issue }], debug_id: "fakedebug123" });
}

function captureJson(capture: FakeCapture): Json {
  return {
    id: capture.id,
    status: capture.status,
    amount: { currency_code: capture.currency, value: capture.value },
    final_capture: true,
  };
}

function orderJson(order: FakeOrder, capture?: FakeCapture): Json {
  return {
    id: order.id,
    status: order.status,
    purchase_units: [
      {
        reference_id: (order.body.purchase_units as Json[] | undefined)?.[0]?.reference_id,
        payments: capture ? { captures: [captureJson(capture)] } : undefined,
      },
    ],
    links: [],
  };
}

function refundJson(refund: FakeRefund): Json {
  return { id: refund.id, status: refund.status, amount: { currency_code: "USD", value: refund.value } };
}

/** Routes all fetches in this test to a fresh fake PayPal. */
export function installFakePayPal(): FakePayPal {
  const fake = new FakePayPal();
  resetPayPalTokenCache();
  vi.spyOn(globalThis, "fetch").mockImplementation((input, init) => fake.handle(new Request(input, init)));
  return fake;
}

afterEach(() => {
  vi.restoreAllMocks();
  resetPayPalTokenCache();
});
