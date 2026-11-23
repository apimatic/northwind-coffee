-- Catalog
CREATE TABLE catalog_brands (
  id INTEGER PRIMARY KEY,
  brand TEXT NOT NULL UNIQUE
);

CREATE TABLE catalog_types (
  id INTEGER PRIMARY KEY,
  type TEXT NOT NULL UNIQUE
);

CREATE TABLE catalog_items (
  id INTEGER PRIMARY KEY,
  name TEXT NOT NULL,
  description TEXT NOT NULL,
  price_cents INTEGER NOT NULL CHECK (price_cents >= 0),
  picture_uri TEXT NOT NULL,
  catalog_type_id INTEGER NOT NULL REFERENCES catalog_types (id),
  catalog_brand_id INTEGER NOT NULL REFERENCES catalog_brands (id)
);

CREATE INDEX idx_catalog_items_type ON catalog_items (catalog_type_id);
CREATE INDEX idx_catalog_items_brand ON catalog_items (catalog_brand_id);

-- Identity
CREATE TABLE users (
  id INTEGER PRIMARY KEY,
  email TEXT NOT NULL UNIQUE COLLATE NOCASE,
  password_hash TEXT NOT NULL,
  role TEXT NOT NULL DEFAULT 'customer' CHECK (role IN ('customer', 'admin')),
  created_at TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ', 'now'))
);

-- Only the SHA-256 hash of the session token is stored.
CREATE TABLE sessions (
  token_hash TEXT PRIMARY KEY,
  user_id INTEGER NOT NULL REFERENCES users (id) ON DELETE CASCADE,
  created_at TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ', 'now')),
  expires_at TEXT NOT NULL
);

CREATE INDEX idx_sessions_user ON sessions (user_id);

-- Basket. buyer_id is 'u:<userId>' for signed-in users, 'a:<uuid>' for anonymous visitors.
CREATE TABLE baskets (
  id INTEGER PRIMARY KEY,
  buyer_id TEXT NOT NULL UNIQUE,
  created_at TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ', 'now'))
);

CREATE TABLE basket_items (
  id INTEGER PRIMARY KEY,
  basket_id INTEGER NOT NULL REFERENCES baskets (id) ON DELETE CASCADE,
  catalog_item_id INTEGER NOT NULL REFERENCES catalog_items (id),
  unit_price_cents INTEGER NOT NULL CHECK (unit_price_cents >= 0),
  quantity INTEGER NOT NULL CHECK (quantity > 0),
  UNIQUE (basket_id, catalog_item_id)
);

-- Orders. Item names, pictures and prices are snapshotted at checkout.
CREATE TABLE orders (
  id INTEGER PRIMARY KEY,
  buyer_user_id INTEGER NOT NULL REFERENCES users (id),
  checkout_key TEXT NOT NULL,
  status TEXT NOT NULL,
  currency TEXT NOT NULL DEFAULT 'USD',
  total_cents INTEGER NOT NULL CHECK (total_cents >= 0),
  ship_name TEXT NOT NULL,
  ship_line1 TEXT NOT NULL,
  ship_line2 TEXT NOT NULL DEFAULT '',
  ship_city TEXT NOT NULL,
  ship_region TEXT NOT NULL,
  ship_postal_code TEXT NOT NULL,
  ship_country TEXT NOT NULL,
  created_at TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ', 'now')),
  updated_at TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ', 'now')),
  UNIQUE (buyer_user_id, checkout_key)
);

CREATE INDEX idx_orders_buyer ON orders (buyer_user_id, created_at);
CREATE INDEX idx_orders_status ON orders (status, created_at);

CREATE TABLE order_items (
  id INTEGER PRIMARY KEY,
  order_id INTEGER NOT NULL REFERENCES orders (id) ON DELETE CASCADE,
  catalog_item_id INTEGER NOT NULL,
  product_name TEXT NOT NULL,
  picture_uri TEXT NOT NULL,
  unit_price_cents INTEGER NOT NULL CHECK (unit_price_cents >= 0),
  quantity INTEGER NOT NULL CHECK (quantity > 0)
);

CREATE INDEX idx_order_items_order ON order_items (order_id);
