/**
 * One-time (or repeatable) product loader — adds/updates rows in the
 * `products` table without needing to open Supabase's SQL Editor by hand.
 *
 * Edit the PRODUCTS array below with whatever you're selling, then run:
 *   npm run build && npm run seed
 * with DATABASE_URL set in your own environment (e.g. a local .env — never
 * commit it, never paste it in chat).
 *
 * Safe to re-run: uses ON CONFLICT (sku) so it updates existing rows
 * instead of erroring or duplicating.
 */
import { getPool, initSchema } from './database.js';

interface SeedProduct {
  sku: string;
  name: string;
  costPrice: number;
  minPrice: number;
  maxPrice: number;
  currentPrice: number;
  preorderDays?: number; // 0-30, matches the edit page's input range
  available?: boolean;
}

const PRODUCTS: SeedProduct[] = [
  {
    sku: 'ADIAN-001',
    name: 'ADIAN 5-in-1 стайлер для волос',
    costPrice: 15000,
    minPrice: 34990,
    maxPrice: 39900,
    currentPrice: 36990,
    preorderDays: 0,
    available: true,
  },
];

async function seed() {
  await initSchema();
  const db = getPool();

  for (const p of PRODUCTS) {
    await db.query(
      `INSERT INTO products (sku, name, cost_price, min_price, max_price, current_price, preorder_days, available)
       VALUES ($1, $2, $3, $4, $5, $6, $7, $8)
       ON CONFLICT (sku) DO UPDATE SET
         name = EXCLUDED.name,
         cost_price = EXCLUDED.cost_price,
         min_price = EXCLUDED.min_price,
         max_price = EXCLUDED.max_price,
         current_price = EXCLUDED.current_price,
         preorder_days = EXCLUDED.preorder_days,
         available = EXCLUDED.available,
         updated_at = NOW()`,
      [
        p.sku,
        p.name,
        p.costPrice,
        p.minPrice,
        p.maxPrice,
        p.currentPrice,
        p.preorderDays ?? 0,
        p.available === false ? 0 : 1,
      ]
    );
    console.log(`Upserted ${p.sku} — ${p.name}`);
  }

  console.log(`Done. ${PRODUCTS.length} product(s) written.`);
  process.exit(0);
}

seed().catch((err) => {
  console.error(err);
  process.exit(1);
});
