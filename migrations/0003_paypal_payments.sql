-- PayPal payments. One PayPal checkout per store order (order_id is the primary key), which is also the
-- claim that stops two "Pay with PayPal" clicks from creating two PayPal orders.
--   creating           claim taken; createOrder sent (replayed with request_id until PayPal answers)
--   awaiting_approval  PayPal order created; buyer approves on PayPal
--   capturing          capture claim taken; captureOrder sent (outcome may be unknown)
--   completed          PayPal reported a COMPLETED capture
--   pending            PayPal accepted the capture but it is still PENDING
--   declined           the capture was DECLINED or FAILED; the buyer can start again
CREATE TABLE paypal_payments (
  order_id INTEGER PRIMARY KEY REFERENCES orders (id),
  request_id TEXT NOT NULL UNIQUE,
  paypal_order_id TEXT UNIQUE,
  state TEXT NOT NULL CHECK (
    state IN ('creating', 'awaiting_approval', 'capturing', 'completed', 'pending', 'declined')
  ),
  amount_cents INTEGER NOT NULL CHECK (amount_cents > 0),
  currency TEXT NOT NULL,
  capture_id TEXT,
  captured_cents INTEGER CHECK (captured_cents IS NULL OR captured_cents >= 0),
  failure_reason TEXT,
  created_at TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ', 'now')),
  updated_at TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ', 'now'))
);

CREATE INDEX idx_paypal_payments_state ON paypal_payments (state);

-- Refunds of a captured PayPal payment. refund_key comes from the admin refund form, so a resubmitted
-- form is rejected by the unique constraint instead of refunding twice.
--   requested  claim taken; refund sent to PayPal
--   pending    PayPal accepted the refund but it is still PENDING
--   completed  PayPal reported the refund COMPLETED
--   failed     PayPal refused it, or it was never sent (its amount is refundable again)
--   unknown    PayPal may have acted; not found when we re-read the order
CREATE TABLE paypal_refunds (
  id INTEGER PRIMARY KEY,
  order_id INTEGER NOT NULL REFERENCES orders (id),
  refund_key TEXT NOT NULL,
  amount_cents INTEGER NOT NULL CHECK (amount_cents > 0),
  currency TEXT NOT NULL,
  state TEXT NOT NULL CHECK (state IN ('requested', 'pending', 'completed', 'failed', 'unknown')),
  paypal_refund_id TEXT,
  failure_reason TEXT,
  requested_by_user_id INTEGER REFERENCES users (id),
  created_at TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ', 'now')),
  updated_at TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ', 'now')),
  UNIQUE (order_id, refund_key)
);

CREATE INDEX idx_paypal_refunds_order ON paypal_refunds (order_id, created_at);
