-- PayPal requires an invoice_id on every purchase unit of a new order from 1 Dec 2026, and invoice IDs must be
-- unique within the merchant account. Each store order gets exactly one: it is assigned the first time the order is
-- sent to PayPal and never changes, so every createOrder for that store order (a replay after a lost answer, a retry
-- after a refusal, or a new PayPal order after a decline or expiry) carries the same value.
-- NULL until the order is first sent to PayPal; the unique index allows any number of NULLs.
ALTER TABLE orders ADD COLUMN paypal_invoice_id TEXT;

CREATE UNIQUE INDEX idx_orders_paypal_invoice_id ON orders (paypal_invoice_id);
