/**
 * Recovery: creating the PayPal order, capturing the payment and refunding, against a stateful PayPal stand-in that
 * deduplicates on PayPal-Request-Id and counts what actually happened to money (one PayPal order, one charge, one
 * refund).
 *
 * - A brief 429 or 5xx is retried by the SDK (POST is in the retry gate) and never reaches the shopper or admin.
 * - Retry-After is honoured, and a wait longer than the operation's deadline is cut short by it.
 * - A sustained 429/5xx (the one retry also fails) is reported, and the next attempt recovers.
 * - A lost answer (dropped connection, timeout) is not re-sent by the SDK; it is settled by re-reading PayPal.
 * - A conflict (an earlier attempt still in progress) is never treated as a refusal.
 *
 * The client is the app's own (createPaypal: same retry gate, statuses and deadlines), built over the stand-in's fetch
 * with short timings: a hung attempt ends after 150 ms and the backoff before a retry is 0 unless Retry-After says
 * otherwise.
 */
import { env } from "cloudflare:workers";
import { beforeEach, describe, expect, it } from "vitest";
import { getPayment, listRefunds } from "../src/db/payments";
import { createPaypal, type Paypal } from "../src/lib/paypal";
import { getOrder } from "../src/services/orders";
import {
  capturePaypalPayment,
  getPaymentInfo,
  reconcilePayment,
  recheckRefund,
  refundPaypalPayment,
  startPaypalCheckout,
} from "../src/services/payments";
import { Browser, checkoutKeyFrom, createTestUser, validAddress } from "./helpers";
import { type Fault, PaypalSim, SIM_BASE, type SimRequest } from "./paypal-sim";

let sim: PaypalSim;
let paypal: Paypal;

beforeEach(() => {
  sim = new PaypalSim();
  paypal = createPaypal({
    environment: "sandbox",
    baseUrl: SIM_BASE,
    clientId: "sim-client",
    clientSecret: "sim-secret",
    fetch: sim.fetch,
    timing: { attemptTimeoutMs: 150, budgetMs: 1_500, rereadBudgetMs: 1_000, retryDelayMs: 0 },
  });
});

/** A store order of 3 × $7.50 = $22.50, awaiting payment. */
async function storeOrder(): Promise<number> {
  const user = await createTestUser();
  const browser = new Browser();
  await browser.signIn(user.email);
  await browser.addToBasket(9, 3);
  const { html } = await browser.get("/checkout");
  const response = await browser.post("/checkout", { checkoutKey: checkoutKeyFrom(html), ...validAddress });
  return Number(/\/orders\/(\d+)/.exec(response.headers.get("location") ?? "")?.[1]);
}

/** The buyer clicks "Pay with PayPal". */
async function startCheckout(orderId: number) {
  const order = await getOrder(env.DB, orderId);
  if (!order) throw new Error("order missing");
  return startPaypalCheckout(env.DB, paypal, {
    order,
    returnUrl: `https://northwind.test/orders/${orderId}/paypal/return`,
    cancelUrl: `https://northwind.test/orders/${orderId}?notice=paypal_cancelled`,
  });
}

async function approvedOrder(): Promise<number> {
  const orderId = await storeOrder();
  expect((await startCheckout(orderId)).kind).toBe("redirect");
  sim.approve(sim.onlyOrderId());
  return orderId;
}

async function paidOrder(): Promise<number> {
  const orderId = await approvedOrder();
  expect(await capturePaypalPayment(env.DB, paypal, orderId)).toEqual({ kind: "paid" });
  return orderId;
}

function refund(orderId: number, refundKey: string, amountCents = 500) {
  return refundPaypalPayment(env.DB, paypal, { orderId, refundKey, amountCents, requestedByUserId: 1 });
}

const CREATE = /^\/v2\/checkout\/orders$/;
const CAPTURE = /\/capture$/;
const REFUND = /\/refund$/;
const ORDER_READ = /^\/v2\/checkout\/orders\/[^/]+$/;

/** All attempts were the same request: one PayPal-Request-Id and, for SDK retries, one Idempotency-Key. */
function expectSameRequest(requests: SimRequest[], count: number): void {
  expect(requests).toHaveLength(count);
  expect(new Set(requests.map((r) => r.requestId)).size).toBe(1);
  expect(new Set(requests.map((r) => r.idempotencyKey)).size).toBe(1);
}

// ---------------------------------------------------------------------------------------------------------------

describe("a brief 429 or 5xx is retried by the SDK and invisible to the shopper and the admin", () => {
  // 504-after: PayPal processed the request but the gateway timed out; the retry is deduplicated by PayPal.
  const BRIEF: Fault[] = ["429", "503", "504-after"];

  for (const fault of BRIEF) {
    it(`createOrder after ${fault}`, async () => {
      const orderId = await storeOrder();
      sim.inject("POST", CREATE, fault);

      const result = await startCheckout(orderId);

      expect(result).toEqual({ kind: "redirect", approvalUrl: expect.stringContaining(`token=${sim.onlyOrderId()}`) });
      expect(sim.effects.ordersCreated).toBe(1);
      expectSameRequest(sim.requestsTo("POST", CREATE), 2);
    });

    it(`captureOrder after ${fault}`, async () => {
      const orderId = await approvedOrder();
      sim.inject("POST", CAPTURE, fault);

      expect(await capturePaypalPayment(env.DB, paypal, orderId)).toEqual({ kind: "paid" });

      expect(sim.effects.charges).toBe(1);
      expect((await getOrder(env.DB, orderId))?.status).toBe("paid");
      expectSameRequest(sim.requestsTo("POST", CAPTURE), 2);
      // Answered by the retry itself: no re-read was needed.
      expect(sim.requestsTo("GET", ORDER_READ)).toHaveLength(0);
    });

    it(`refundCapturedPayment after ${fault}`, async () => {
      const orderId = await paidOrder();
      sim.inject("POST", REFUND, fault);

      expect((await refund(orderId, crypto.randomUUID())).kind).toBe("completed");

      expect(sim.effects).toMatchObject({ refunds: 1, refundedCents: 500 });
      expect(await getPaymentInfo(env.DB, orderId)).toMatchObject({ refundedCents: 500, refundableCents: 1750 });
      expectSameRequest(sim.requestsTo("POST", REFUND), 2);
      expect(sim.requestsTo("GET", ORDER_READ)).toHaveLength(0);
    });
  }
});

describe("Retry-After", () => {
  it("is honoured before a write is retried", async () => {
    const orderId = await approvedOrder();
    sim.inject("POST", CAPTURE, "429-retry-after-1");

    expect(await capturePaypalPayment(env.DB, paypal, orderId)).toEqual({ kind: "paid" });

    const [first, second] = sim.requestsTo("POST", CAPTURE);
    expect((second?.at ?? 0) - (first?.at ?? 0)).toBeGreaterThanOrEqual(1000);
    expect(sim.effects.charges).toBe(1);
  });

  it("longer than the deadline ends the call within the deadline, and the next attempt recovers", async () => {
    const orderId = await approvedOrder();
    sim.inject("POST", CAPTURE, "429-retry-after-30");

    const started = Date.now();
    const first = await capturePaypalPayment(env.DB, paypal, orderId);

    // Budget 1.5 s, plus the re-read: nowhere near the 30 s PayPal asked for.
    expect(Date.now() - started).toBeLessThan(5_000);
    expect(first).toEqual({ kind: "unknown" });
    expect(sim.effects.charges).toBe(0);
    // The re-read showed PayPal had not captured, so the claim was released for the buyer's retry.
    expect((await getPayment(env.DB, orderId))?.state).toBe("awaiting_approval");
    expect(await capturePaypalPayment(env.DB, paypal, orderId)).toEqual({ kind: "paid" });
    expect(sim.effects.charges).toBe(1);
  });
});

describe("a sustained 429 or 503 (the one retry also fails) is reported, and the next attempt recovers", () => {
  const cases: { fault: Fault; create: string; capture: string; refund: string }[] = [
    { fault: "429", create: "failed", capture: "failed", refund: "failed" },
    { fault: "503", create: "failed", capture: "unknown", refund: "unknown" },
  ];

  for (const { fault, ...first } of cases) {
    it(`createOrder after ${fault} twice`, async () => {
      const orderId = await storeOrder();
      sim.inject("POST", CREATE, fault, fault);

      expect((await startCheckout(orderId)).kind).toBe(first.create);
      expect((await startCheckout(orderId)).kind).toBe("redirect");

      expect(sim.effects.ordersCreated).toBe(1);
      expect(sim.requestsTo("POST", CREATE)).toHaveLength(3);
    });

    it(`captureOrder after ${fault} twice`, async () => {
      const orderId = await approvedOrder();
      sim.inject("POST", CAPTURE, fault, fault);

      expect((await capturePaypalPayment(env.DB, paypal, orderId)).kind).toBe(first.capture);
      expect((await getOrder(env.DB, orderId))?.status).toBe("awaiting_payment");
      expect(await capturePaypalPayment(env.DB, paypal, orderId)).toEqual({ kind: "paid" });

      expect(sim.effects.charges).toBe(1);
      // Every capture attempt, the SDK's and the buyer's, carried the same PayPal-Request-Id.
      expect(new Set(sim.requestsTo("POST", CAPTURE).map((r) => r.requestId)).size).toBe(1);
    });

    it(`refundCapturedPayment after ${fault} twice`, async () => {
      const orderId = await paidOrder();
      const refundKey = crypto.randomUUID();
      sim.inject("POST", REFUND, fault, fault);

      const result = await refund(orderId, refundKey);
      expect(result.kind).toBe(first.refund);
      if (result.kind === "failed") {
        // PayPal refused it outright: the amount is refundable again, from the re-rendered form (new key).
        expect((await refund(orderId, crypto.randomUUID())).kind).toBe("completed");
      } else {
        // Unknown: the amount stays reserved until "Check refund status" settles it.
        expect((await getPaymentInfo(env.DB, orderId))?.refundableCents).toBe(1750);
        const [row] = await listRefunds(env.DB, orderId);
        expect((await recheckRefund(env.DB, paypal, orderId, row?.id ?? 0))?.kind).toBe("completed");
      }
      expect((await refund(orderId, refundKey)).kind).toBe("duplicate");

      expect(sim.effects).toMatchObject({ refunds: 1, refundedCents: 500 });
      expect(await getPaymentInfo(env.DB, orderId)).toMatchObject({ refundedCents: 500, refundableCents: 1750 });
    });
  }
});

describe("a lost answer is settled by re-reading PayPal, not by the SDK re-sending the write", () => {
  const LOST: { fault: Fault; acted: boolean; create: string; capture: string; refund: string }[] = [
    { fault: "timeout-before", acted: false, create: "unknown", capture: "unknown", refund: "unknown" },
    { fault: "timeout-after", acted: true, create: "unknown", capture: "paid", refund: "completed" },
    { fault: "lost", acted: true, create: "unknown", capture: "paid", refund: "completed" },
  ];

  for (const { fault, acted, ...first } of LOST) {
    it(`createOrder after ${fault}`, async () => {
      const orderId = await storeOrder();
      sim.inject("POST", CREATE, fault);

      expect((await startCheckout(orderId)).kind).toBe(first.create);
      expect(sim.requestsTo("POST", CREATE)).toHaveLength(1);

      // The buyer clicks again: the kept claim replays the same PayPal-Request-Id.
      const second = await startCheckout(orderId);
      expect(second).toEqual({ kind: "redirect", approvalUrl: expect.stringContaining(`token=${sim.onlyOrderId()}`) });
      expect(sim.effects.ordersCreated).toBe(1);
      expect(new Set(sim.requestsTo("POST", CREATE).map((r) => r.requestId)).size).toBe(1);
      expect(await getPayment(env.DB, orderId)).toMatchObject({ state: "awaiting_approval" });
    });

    it(`captureOrder after ${fault}`, async () => {
      const orderId = await approvedOrder();
      sim.inject("POST", CAPTURE, fault);

      expect((await capturePaypalPayment(env.DB, paypal, orderId)).kind).toBe(first.capture);
      expect(sim.requestsTo("POST", CAPTURE)).toHaveLength(1);
      expect(sim.requestsTo("GET", ORDER_READ).length).toBeGreaterThanOrEqual(1);

      expect(await capturePaypalPayment(env.DB, paypal, orderId)).toEqual({ kind: "paid" });
      expect(await capturePaypalPayment(env.DB, paypal, orderId)).toEqual({ kind: "paid" });
      expect(sim.effects.charges).toBe(1);
      expect(sim.requestsTo("POST", CAPTURE)).toHaveLength(acted ? 1 : 2);
      expect(await getPayment(env.DB, orderId)).toMatchObject({ state: "completed", captured_cents: 2250 });
    });

    it(`refundCapturedPayment after ${fault}`, async () => {
      const orderId = await paidOrder();
      const refundKey = crypto.randomUUID();
      sim.inject("POST", REFUND, fault);

      const result = await refund(orderId, refundKey);
      expect(result.kind).toBe(first.refund);
      expect(sim.requestsTo("POST", REFUND)).toHaveLength(1);
      if (result.kind === "unknown") {
        expect((await getPaymentInfo(env.DB, orderId))?.refundableCents).toBe(1750);
        const [row] = await listRefunds(env.DB, orderId);
        expect((await recheckRefund(env.DB, paypal, orderId, row?.id ?? 0))?.kind).toBe("completed");
      }
      expect((await refund(orderId, refundKey)).kind).toBe("duplicate");

      expect(sim.effects).toMatchObject({ refunds: 1, refundedCents: 500 });
      expect(new Set(sim.requestsTo("POST", REFUND).map((r) => r.requestId))).toEqual(new Set([refundKey]));
    });
  }
});

describe("a conflict (an earlier attempt still in progress) is never treated as a refusal", () => {
  it("refund: 504 after PayPal acted, then 409 on the retry, keeps the amount reserved until it is confirmed", async () => {
    const orderId = await paidOrder();
    sim.inject("POST", REFUND, "504-after", "409-in-progress");
    // The refund is not visible on the order yet when we re-read it.
    sim.staleRefundReads = 1;

    const result = await refund(orderId, crypto.randomUUID());

    // Not "failed": releasing the amount here would let staff refund the same money twice.
    expect(result.kind).toBe("unknown");
    expect((await getPaymentInfo(env.DB, orderId))?.refundableCents).toBe(1750);
    const [row] = await listRefunds(env.DB, orderId);
    expect((await recheckRefund(env.DB, paypal, orderId, row?.id ?? 0))?.kind).toBe("completed");
    expect(sim.effects).toMatchObject({ refunds: 1, refundedCents: 500 });
  });

  it("capture: 504 after PayPal acted, then 409 on the retry, is settled from the order as paid", async () => {
    const orderId = await approvedOrder();
    sim.inject("POST", CAPTURE, "504-after", "409-in-progress");

    expect(await capturePaypalPayment(env.DB, paypal, orderId)).toEqual({ kind: "paid" });
    expect(sim.effects.charges).toBe(1);
  });

  it("createOrder: a conflict is not retried by the SDK, keeps the claim, and the next click replays it", async () => {
    const orderId = await storeOrder();
    sim.inject("POST", CREATE, "409-in-progress");

    const first = await startCheckout(orderId);
    expect(first).toMatchObject({ kind: "failed", failure: { kind: "conflict" } });
    // 409 is not a retryable status: PayPal is not hammered while the earlier attempt runs.
    expect(sim.requestsTo("POST", CREATE)).toHaveLength(1);
    expect((await getPayment(env.DB, orderId))?.state).toBe("creating");

    expect((await startCheckout(orderId)).kind).toBe("redirect");
    expect(sim.effects.ordersCreated).toBe(1);
    expect(new Set(sim.requestsTo("POST", CREATE).map((r) => r.requestId)).size).toBe(1);
  });
});

describe("recovery edge cases", () => {
  it("a refund PayPal made but the re-reads missed is replayed with the same key and not refunded twice", async () => {
    const orderId = await paidOrder();
    sim.inject("POST", REFUND, "lost");
    // The order reads after the lost answer lag behind the refund: the first settle and the re-check's read.
    sim.staleRefundReads = 2;

    expect((await refund(orderId, crypto.randomUUID(), 700)).kind).toBe("unknown");
    const [row] = await listRefunds(env.DB, orderId);

    expect((await recheckRefund(env.DB, paypal, orderId, row?.id ?? 0))?.kind).toBe("completed");
    expect(sim.requestsTo("POST", REFUND)).toHaveLength(2);
    expect(sim.effects).toMatchObject({ refunds: 1, refundedCents: 700 });
  });

  it("a replayed refund that stays rate-limited stays unknown with its amount reserved", async () => {
    const orderId = await paidOrder();
    // The first send's answer is lost; the replay and its SDK retry are both answered 429.
    sim.inject("POST", REFUND, "timeout-before", "429", "429");

    await refund(orderId, crypto.randomUUID());
    const [row] = await listRefunds(env.DB, orderId);
    const checked = await recheckRefund(env.DB, paypal, orderId, row?.id ?? 0);

    expect(checked?.kind).toBe("unknown");
    expect((await getPaymentInfo(env.DB, orderId))?.refundableCents).toBe(1750);
    expect((await recheckRefund(env.DB, paypal, orderId, row?.id ?? 0))?.kind).toBe("completed");
    expect(sim.effects).toMatchObject({ refunds: 1, refundedCents: 500 });
  });

  it("an unknown refund whose re-read fails is not replayed blindly", async () => {
    const orderId = await paidOrder();
    sim.inject("POST", REFUND, "lost");
    // Both attempts (the SDK retries a GET once) of each of two re-reads fail.
    sim.inject("GET", ORDER_READ, "503", "503", "503", "503");

    await refund(orderId, crypto.randomUUID());
    const [row] = await listRefunds(env.DB, orderId);
    expect((await recheckRefund(env.DB, paypal, orderId, row?.id ?? 0))?.kind).toBe("unknown");

    expect(sim.requestsTo("POST", REFUND)).toHaveLength(1);
    expect(sim.effects.refunds).toBe(1);
    // PayPal readable again: settled from the order, still without re-sending.
    expect((await recheckRefund(env.DB, paypal, orderId, row?.id ?? 0))?.kind).toBe("completed");
    expect(sim.requestsTo("POST", REFUND)).toHaveLength(1);
  });

  it("the re-read after a lost capture is itself retried on 429", async () => {
    const orderId = await approvedOrder();
    sim.inject("POST", CAPTURE, "lost");
    sim.inject("GET", ORDER_READ, "429");

    expect(await capturePaypalPayment(env.DB, paypal, orderId)).toEqual({ kind: "paid" });
    expect(sim.requestsTo("GET", ORDER_READ)).toHaveLength(2);
    expect(sim.effects.charges).toBe(1);
  });

  it("a capture whose answer and re-reads all time out is settled later, charging once", async () => {
    const orderId = await approvedOrder();
    sim.inject("POST", CAPTURE, "timeout-after");
    sim.inject("GET", ORDER_READ, "timeout-before", "timeout-before");

    expect(await capturePaypalPayment(env.DB, paypal, orderId)).toEqual({ kind: "unknown" });
    // Unknown, never failed: the claim stays, so no second checkout or capture can start.
    expect((await getPayment(env.DB, orderId))?.state).toBe("capturing");
    expect((await startCheckout(orderId)).kind).toBe("not_payable");
    expect(await capturePaypalPayment(env.DB, paypal, orderId)).toEqual({ kind: "unknown" });
    expect(sim.requestsTo("POST", CAPTURE)).toHaveLength(1);

    // Later, the order page reconciles the stale claim (simulate its age) and finds the capture.
    await env.DB.prepare("UPDATE paypal_payments SET updated_at = '2000-01-01T00:00:00.000Z' WHERE order_id = ?1")
      .bind(orderId)
      .run();
    await reconcilePayment(env.DB, paypal, orderId);

    expect((await getOrder(env.DB, orderId))?.status).toBe("paid");
    expect(sim.effects.charges).toBe(1);
  });
});
