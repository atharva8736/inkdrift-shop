// Generated from the .sql files in this folder (run `npm run build:migrations`).
export const MIGRATIONS = [
  { name: "001_init.sql", sql: `-- Inkdrift schema. Money is always stored as integer paise (1 INR = 100 paise).
CREATE TABLE users (
  id             TEXT PRIMARY KEY,
  email          TEXT NOT NULL UNIQUE COLLATE NOCASE,
  name           TEXT NOT NULL,
  password_hash  TEXT,                                   -- NULL for Google-only accounts
  avatar_url     TEXT,
  google_sub     TEXT UNIQUE,                            -- Google account id, links Google login
  email_verified INTEGER NOT NULL DEFAULT 0,
  status         TEXT NOT NULL DEFAULT 'pending' CHECK (status IN ('pending','active','disabled')),
  created_at     INTEGER NOT NULL,
  updated_at     INTEGER NOT NULL,
  last_login_at  INTEGER
);

CREATE TABLE email_otps (
  id          TEXT PRIMARY KEY,
  user_id     TEXT NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  purpose     TEXT NOT NULL DEFAULT 'signup',
  code_hash   TEXT NOT NULL,                              -- HMAC of the code, never the code itself
  expires_at  INTEGER NOT NULL,
  attempts    INTEGER NOT NULL DEFAULT 0,
  consumed_at INTEGER,
  created_at  INTEGER NOT NULL
);
CREATE INDEX idx_otps_user ON email_otps(user_id, created_at);

CREATE TABLE sessions (
  id_hash    TEXT PRIMARY KEY,                            -- SHA-256 of the cookie token
  user_id    TEXT NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  csrf_token TEXT NOT NULL,
  created_at INTEGER NOT NULL,
  expires_at INTEGER NOT NULL,
  ip         TEXT,
  user_agent TEXT
);
CREATE INDEX idx_sessions_user ON sessions(user_id);

CREATE TABLE products (
  id              TEXT PRIMARY KEY,
  type            TEXT NOT NULL CHECK (type IN ('pack','bundle','wallpaper')),
  name            TEXT NOT NULL,
  tagline         TEXT,
  price_paise     INTEGER NOT NULL CHECK (price_paise >= 100),
  compare_at_paise INTEGER,
  file_name       TEXT,                                   -- file inside PACKS_DIR for downloads
  active          INTEGER NOT NULL DEFAULT 1,
  sort            INTEGER NOT NULL DEFAULT 0
);

CREATE TABLE product_items (                              -- a bundle contains packs
  product_id      TEXT NOT NULL REFERENCES products(id),
  item_product_id TEXT NOT NULL REFERENCES products(id),
  PRIMARY KEY (product_id, item_product_id)
);

CREATE TABLE wallpapers (
  id              TEXT PRIMARY KEY,
  pack_id         TEXT NOT NULL REFERENCES products(id),
  position        INTEGER NOT NULL,
  title           TEXT NOT NULL,
  preview_desktop TEXT,
  preview_phone   TEXT
);

CREATE TABLE coupons (
  code    TEXT PRIMARY KEY,
  percent INTEGER NOT NULL CHECK (percent BETWEEN 1 AND 90),
  active  INTEGER NOT NULL DEFAULT 1
);

CREATE TABLE orders (
  id               TEXT PRIMARY KEY,
  user_id          TEXT NOT NULL REFERENCES users(id),
  status           TEXT NOT NULL CHECK (status IN ('created','pending','pending_verification','paid','failed','cancelled','expired')),
  currency         TEXT NOT NULL DEFAULT 'INR',
  subtotal_paise   INTEGER NOT NULL,
  discount_paise   INTEGER NOT NULL DEFAULT 0,
  amount_paise     INTEGER NOT NULL CHECK (amount_paise >= 100),
  coupon_code      TEXT,
  items_key        TEXT NOT NULL,                         -- sorted product ids, used to detect duplicate carts
  idempotency_key  TEXT,
  created_at       INTEGER NOT NULL,
  updated_at       INTEGER NOT NULL,
  paid_at          INTEGER
);
CREATE INDEX idx_orders_user ON orders(user_id, created_at);
CREATE UNIQUE INDEX idx_orders_idem ON orders(user_id, idempotency_key) WHERE idempotency_key IS NOT NULL;

CREATE TABLE order_items (
  order_id    TEXT NOT NULL REFERENCES orders(id) ON DELETE CASCADE,
  product_id  TEXT NOT NULL REFERENCES products(id),
  name        TEXT NOT NULL,
  price_paise INTEGER NOT NULL,
  PRIMARY KEY (order_id, product_id)
);

CREATE TABLE payments (
  id                  TEXT PRIMARY KEY,
  order_id            TEXT NOT NULL UNIQUE REFERENCES orders(id),
  provider            TEXT NOT NULL DEFAULT 'youpi',
  provider_payment_id TEXT NOT NULL UNIQUE,               -- the transaction id from the gateway
  checkout_url        TEXT,
  status              TEXT NOT NULL,                      -- last gateway status we saw
  event               TEXT,
  settlement_state    TEXT,
  method              TEXT,
  amount_paise        INTEGER NOT NULL,
  utr                 TEXT,                               -- bank reference number when reported
  created_at          INTEGER NOT NULL,
  updated_at          INTEGER NOT NULL,
  verified_at         INTEGER,
  last_checked_at     INTEGER
);

CREATE TABLE webhook_events (
  delivery_id TEXT PRIMARY KEY,                           -- dedupes gateway retries
  payment_id  TEXT,
  event       TEXT,
  outcome     TEXT NOT NULL,
  received_at INTEGER NOT NULL
);

CREATE TABLE entitlements (                               -- what each user owns
  user_id    TEXT NOT NULL REFERENCES users(id),
  product_id TEXT NOT NULL REFERENCES products(id),
  order_id   TEXT NOT NULL REFERENCES orders(id),
  granted_at INTEGER NOT NULL,
  revoked_at INTEGER,
  PRIMARY KEY (user_id, product_id)
);

CREATE TABLE audit_log (
  id      INTEGER PRIMARY KEY AUTOINCREMENT,
  at      INTEGER NOT NULL,
  actor   TEXT NOT NULL,
  action  TEXT NOT NULL,
  subject TEXT,
  detail  TEXT
);
` },
];
