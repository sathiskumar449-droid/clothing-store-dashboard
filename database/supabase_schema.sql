-- ============================================================
-- SUPER COLLECTIONS — Supabase Schema
-- Run this in: Supabase Dashboard → SQL Editor
-- ============================================================

-- ============================================================
-- 1. PRODUCTS TABLE
-- ============================================================
CREATE TABLE IF NOT EXISTS products (
    id          BIGINT PRIMARY KEY,          -- numeric timestamp ID (e.g. 1779255844147)
    name        TEXT NOT NULL,
    code        TEXT,
    category    TEXT,
    pattern     TEXT,
    color       TEXT,
    price       TEXT,                        -- stored as text to match existing JSON
    stock       TEXT,                        -- stored as text to match existing JSON (some rows have "4", some have 4)
    sizes       JSONB    DEFAULT '[]',       -- array of size strings e.g. ["S","M","L"]
    image_uri   TEXT,
    permalink   TEXT,                        -- WooCommerce's direct product page URL (p.permalink)
    created_at  TIMESTAMPTZ DEFAULT NOW()
);

-- Safe to re-run: adds the column if this script is applied to an existing database
ALTER TABLE products ADD COLUMN IF NOT EXISTS permalink TEXT;

-- ============================================================
-- 2. ORDERS TABLE
-- Supports both legacy flat fields AND the newer items[] format
-- ============================================================
CREATE TABLE IF NOT EXISTS orders (
    -- Primary key — the string order ID used in the app (e.g. "ORD-1779257011977")
    id                  TEXT PRIMARY KEY,

    -- New-style fields (WhatsApp bot orders)
    customer_phone      TEXT,
    customer_name       TEXT,
    customer_address    TEXT,
    items               JSONB    DEFAULT '[]',   -- array of {productId, product, color, size, price}
    total_price         NUMERIC,
    status              TEXT     DEFAULT 'confirmed',
    date                TIMESTAMPTZ,

    -- Legacy flat fields (older dashboard orders) — kept for backward compatibility
    order_id            TEXT,        -- legacy "orderId" field
    shirt_code          TEXT,
    shirt_name          TEXT,
    shirt_price         NUMERIC,
    shirt_size          TEXT,
    shirt_color         TEXT,
    pant_code           TEXT,
    pant_name           TEXT,
    pant_price          NUMERIC,
    pant_size           TEXT,
    pant_color          TEXT,
    customer_details    TEXT,        -- legacy comma-separated details string
    payment_method      TEXT,
    created_at          TIMESTAMPTZ DEFAULT NOW()
);

-- ============================================================
-- 3. CHATS TABLE
-- One row per customer phone number
-- ============================================================
CREATE TABLE IF NOT EXISTS chats (
    customer_phone  TEXT PRIMARY KEY,
    customer_name   TEXT    DEFAULT 'Customer',
    last_message    TEXT    DEFAULT '',
    last_updated    TIMESTAMPTZ DEFAULT NOW(),
    bot_paused      BOOLEAN DEFAULT FALSE,
    messages        JSONB   DEFAULT '[]',  -- array of {sender, type, text, imageUrl, timestamp}
    locked_at       TIMESTAMPTZ DEFAULT NULL  -- per-customer processing lock for session rows (see getSession/acquireSessionLock)
);

-- Safe to re-run: adds the column if this script is applied to an existing database
ALTER TABLE chats ADD COLUMN IF NOT EXISTS locked_at TIMESTAMPTZ DEFAULT NULL;

-- ============================================================
-- 4. INDEXES for performance
-- ============================================================
CREATE INDEX IF NOT EXISTS idx_orders_customer_phone ON orders(customer_phone);
CREATE INDEX IF NOT EXISTS idx_orders_status         ON orders(status);
CREATE INDEX IF NOT EXISTS idx_orders_date           ON orders(date DESC);
CREATE INDEX IF NOT EXISTS idx_chats_last_updated    ON chats(last_updated DESC);
CREATE INDEX IF NOT EXISTS idx_products_category     ON products(category);

-- ============================================================
-- 5. Row Level Security (RLS)
-- Using service role key in the backend bypasses RLS,
-- but enable it for safety so anon key cannot access data.
-- ============================================================
ALTER TABLE products ENABLE ROW LEVEL SECURITY;
ALTER TABLE orders   ENABLE ROW LEVEL SECURITY;
ALTER TABLE chats    ENABLE ROW LEVEL SECURITY;

-- Allow full access with the service_role key (used by backend)
-- DROP first so this script is safe to re-run multiple times
DROP POLICY IF EXISTS "service_role_all_products" ON products;
DROP POLICY IF EXISTS "service_role_all_orders"   ON orders;
DROP POLICY IF EXISTS "service_role_all_chats"    ON chats;

CREATE POLICY "service_role_all_products" ON products FOR ALL USING (true);
CREATE POLICY "service_role_all_orders"   ON orders   FOR ALL USING (true);
CREATE POLICY "service_role_all_chats"    ON chats    FOR ALL USING (true);
