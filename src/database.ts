/**
 * Postgres schema for the repricer MVP, meant to run on Supabase's free
 * tier — decoupled from wherever the app itself is hosted (Render), so
 * the data survives even if the app's own disk doesn't.
 *
 * Set DATABASE_URL in your own environment (Supabase gives you this
 * connection string in Project Settings -> Database). Never in chat,
 * never committed.
 */
import pg from 'pg';

const { Pool } = pg;

let pool: pg.Pool | null = null;

export function getPool(): pg.Pool {
  if (!pool) {
    const connectionString = process.env.DATABASE_URL;
    if (!connectionString) {
      throw new Error('Set DATABASE_URL in your own environment (Supabase connection string).');
    }
    pool = new Pool({ connectionString, ssl: { rejectUnauthorized: false } });
  }
  return pool;
}

export async function initSchema(): Promise<void> {
  const db = getPool();
  await db.query(`
    CREATE TABLE IF NOT EXISTS products (
      id             SERIAL PRIMARY KEY,
      sku            TEXT NOT NULL UNIQUE,
      kaspi_code     TEXT,
      name           TEXT NOT NULL,
      cost_price     INTEGER NOT NULL,
      min_price      INTEGER NOT NULL,
      max_price      INTEGER NOT NULL,
      current_price  INTEGER NOT NULL,
      preorder_days  INTEGER NOT NULL DEFAULT 0,
      available      INTEGER NOT NULL DEFAULT 1,
      active         INTEGER NOT NULL DEFAULT 1,
      created_at     TIMESTAMPTZ NOT NULL DEFAULT NOW(),
      updated_at     TIMESTAMPTZ NOT NULL DEFAULT NOW()
    );

    CREATE TABLE IF NOT EXISTS competitors (
      id             SERIAL PRIMARY KEY,
      product_id     INTEGER NOT NULL REFERENCES products(id) ON DELETE CASCADE,
      kaspi_url      TEXT NOT NULL,
      label          TEXT,
      active         INTEGER NOT NULL DEFAULT 1,
      created_at     TIMESTAMPTZ NOT NULL DEFAULT NOW()
    );

    CREATE TABLE IF NOT EXISTS competitor_price_log (
      id             SERIAL PRIMARY KEY,
      competitor_id  INTEGER NOT NULL REFERENCES competitors(id) ON DELETE CASCADE,
      price          INTEGER,
      in_stock       INTEGER,
      scraped_at     TIMESTAMPTZ NOT NULL DEFAULT NOW()
    );

    CREATE TABLE IF NOT EXISTS price_change_log (
      id               SERIAL PRIMARY KEY,
      product_id       INTEGER NOT NULL REFERENCES products(id) ON DELETE CASCADE,
      old_price        INTEGER NOT NULL,
      new_price        INTEGER NOT NULL,
      reason           TEXT NOT NULL,
      best_competitor_price INTEGER,
      applied          INTEGER NOT NULL DEFAULT 0,
      created_at       TIMESTAMPTZ NOT NULL DEFAULT NOW()
    );

    CREATE TABLE IF NOT EXISTS strategy_settings (
      product_id       INTEGER PRIMARY KEY REFERENCES products(id) ON DELETE CASCADE,
      undercut_step    INTEGER NOT NULL DEFAULT 50,
      recovery_enabled INTEGER NOT NULL DEFAULT 1,
      check_interval_min INTEGER NOT NULL DEFAULT 60
    );

    CREATE INDEX IF NOT EXISTS idx_competitor_log_competitor ON competitor_price_log(competitor_id, scraped_at);
    CREATE INDEX IF NOT EXISTS idx_price_log_product ON price_change_log(product_id, created_at);
  `);

  // Unit-economics fields — added after the initial schema, so existing
  // deployments need these bolted on rather than created fresh.
  await db.query(`
    ALTER TABLE products ADD COLUMN IF NOT EXISTS bonus_cost INTEGER NOT NULL DEFAULT 0;
    ALTER TABLE products ADD COLUMN IF NOT EXISTS commission_pct NUMERIC NOT NULL DEFAULT 13.5;
    ALTER TABLE products ADD COLUMN IF NOT EXISTS weight_kg NUMERIC NOT NULL DEFAULT 0;
  `);
}

export async function closePool(): Promise<void> {
  if (pool) {
    await pool.end();
    pool = null;
  }
}
