-- Payments: one row per PayPal checkout attempt for an order.
--   created    PayPal order created; the buyer has been sent to PayPal to approve it
--   capturing  we are capturing it (blocks cancellation while the capture call is in flight)
--   pending    PayPal accepted the capture but is still processing it (not paid yet)
--   captured   PayPal captured the money
--   failed     the capture was declined or failed
--   voided     the buyer cancelled on PayPal, or the attempt was abandoned
CREATE TABLE payments (
  id INTEGER PRIMARY KEY,
  order_id INTEGER NOT NULL REFERENCES orders (id),
  provider TEXT NOT NULL DEFAULT 'paypal',
  provider_order_id TEXT NOT NULL UNIQUE,
  status TEXT NOT NULL CHECK (status IN ('created', 'capturing', 'pending', 'captured', 'failed', 'voided')),
  amount_cents INTEGER NOT NULL CHECK (amount_cents >= 0),
  currency TEXT NOT NULL,
  -- PayPal-Request-Id for the capture call; reused when retrying a capture whose outcome is unknown.
  capture_request_id TEXT,
  capture_id TEXT UNIQUE,
  captured_cents INTEGER NOT NULL DEFAULT 0 CHECK (captured_cents >= 0),
  failure_reason TEXT,
  created_at TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ', 'now')),
  updated_at TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ', 'now'))
);

CREATE INDEX idx_payments_order ON payments (order_id, created_at);

-- At most one attempt per order can be capturing, pending or captured.
CREATE UNIQUE INDEX idx_payments_one_active ON payments (order_id)
WHERE status IN ('capturing', 'pending', 'captured');

-- Refunds against a captured payment. request_key is the idempotency key sent to PayPal.
--   requested  reserved locally; the PayPal call is in flight or its outcome is unknown
--   pending    PayPal accepted the refund but has not completed it
--   completed  money returned to the buyer
--   failed     PayPal refused or failed the refund (the amount is refundable again)
CREATE TABLE refunds (
  id INTEGER PRIMARY KEY,
  payment_id INTEGER NOT NULL REFERENCES payments (id),
  order_id INTEGER NOT NULL REFERENCES orders (id),
  request_key TEXT NOT NULL UNIQUE,
  provider_refund_id TEXT UNIQUE,
  status TEXT NOT NULL CHECK (status IN ('requested', 'pending', 'completed', 'failed')),
  amount_cents INTEGER NOT NULL CHECK (amount_cents > 0),
  currency TEXT NOT NULL,
  note TEXT NOT NULL DEFAULT '',
  failure_reason TEXT,
  created_by_user_id INTEGER REFERENCES users (id),
  created_at TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ', 'now')),
  updated_at TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ', 'now'))
);

CREATE INDEX idx_refunds_order ON refunds (order_id, created_at);
