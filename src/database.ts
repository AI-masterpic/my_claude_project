/**
 * SQLite schema for the repricer MVP. One file, zero setup — good enough
 * for one seller's own catalog. Swap for Postgres later if it grows.
 *
 * Uses Node's built-in node:sqlite (no native compilation needed — avoids
 * fighting a broken node-gyp/Python toolchain for an MVP).
 */
import { DatabaseSync } from 'node:sqlite';

export function openDb(path = 'repricer.db') {
  const db = new DatabaseSync(path);
  db.exec('PRAGMA journal_mode = WAL');

  db.exec(`
    -- One row per SKU you sell.
    CREATE TABLE IF NOT EXISTS products (
      id             INTEGER PRIMARY KEY AUTOINCREMENT,
      sku            TEXT NOT NULL UNIQUE,        -- your own article, matches price-list SKU
      kaspi_code     TEXT,                        -- Kaspi's product code (from your own live card URL)
      name           TEXT NOT NULL,
      cost_price     INTEGER NOT NULL,             -- your cost, tenge — never sell below this without knowing it
      min_price      INTEGER NOT NULL,             -- floor: bot never goes below this
      max_price      INTEGER NOT NULL,             -- ceiling: base/recovery price when competitors vanish
      current_price  INTEGER NOT NULL,
      preorder_days  INTEGER NOT NULL DEFAULT 0,   -- 0..30, matches Kaspi price-list "preorder" column
      available      INTEGER NOT NULL DEFAULT 1,   -- 1 = yes, 0 = no
      active         INTEGER NOT NULL DEFAULT 1,   -- turn a product off without deleting its history
      created_at     TEXT NOT NULL DEFAULT (datetime('now')),
      updated_at     TEXT NOT NULL DEFAULT (datetime('now'))
    );

    -- Competitor cards tracked for a given product (a product can have several).
    CREATE TABLE IF NOT EXISTS competitors (
      id             INTEGER PRIMARY KEY AUTOINCREMENT,
      product_id     INTEGER NOT NULL REFERENCES products(id) ON DELETE CASCADE,
      kaspi_url      TEXT NOT NULL,                -- public product page to scrape
      label          TEXT,                         -- optional: seller name, for your own reference
      active         INTEGER NOT NULL DEFAULT 1,
      created_at     TEXT NOT NULL DEFAULT (datetime('now'))
    );

    -- One row per scrape: a snapshot of a competitor's price at a point in time.
    CREATE TABLE IF NOT EXISTS competitor_price_log (
      id             INTEGER PRIMARY KEY AUTOINCREMENT,
      competitor_id  INTEGER NOT NULL REFERENCES competitors(id) ON DELETE CASCADE,
      price          INTEGER,                      -- NULL = scrape failed or card unavailable
      in_stock       INTEGER,                      -- 1/0/NULL if unknown
      scraped_at     TEXT NOT NULL DEFAULT (datetime('now'))
    );

    -- One row per price decision the bot makes for a product (audit trail).
    CREATE TABLE IF NOT EXISTS price_change_log (
      id               INTEGER PRIMARY KEY AUTOINCREMENT,
      product_id       INTEGER NOT NULL REFERENCES products(id) ON DELETE CASCADE,
      old_price        INTEGER NOT NULL,
      new_price        INTEGER NOT NULL,
      reason           TEXT NOT NULL,               -- 'undercut' | 'floor_hit' | 'recovered_to_max' | 'manual'
      best_competitor_price INTEGER,                -- what triggered this decision, if any
      applied          INTEGER NOT NULL DEFAULT 0,  -- 1 once actually pushed to Kaspi (price-list or cabinet)
      created_at       TEXT NOT NULL DEFAULT (datetime('now'))
    );

    -- Per-product strategy knobs, kept separate from the product row so you
    -- can tune strategy without touching catalog data.
    CREATE TABLE IF NOT EXISTS strategy_settings (
      product_id       INTEGER PRIMARY KEY REFERENCES products(id) ON DELETE CASCADE,
      undercut_step    INTEGER NOT NULL DEFAULT 50,  -- tenge below best competitor
      recovery_enabled INTEGER NOT NULL DEFAULT 1,   -- climb back to max_price when no competitor threat
      check_interval_min INTEGER NOT NULL DEFAULT 60 -- how often the scraper visits this product's competitors
    );

    CREATE INDEX IF NOT EXISTS idx_competitor_log_competitor ON competitor_price_log(competitor_id, scraped_at);
    CREATE INDEX IF NOT EXISTS idx_price_log_product ON price_change_log(product_id, created_at);
  `);

  return db;
}
