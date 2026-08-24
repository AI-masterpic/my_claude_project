/**
 * Pricing decision engine. Pure logic, no network calls — takes the latest
 * competitor snapshots already sitting in the DB (from parser.ts) and
 * decides what YOUR price should be. Writing the decision out to Kaspi is
 * a separate step (price-list file, or cabinet-sync.ts) — this only decides.
 */
import { openDb } from './database.js';

export type PriceDecisionReason = 'undercut' | 'floor_hit' | 'recovered_to_max' | 'no_change';

export interface PriceDecision {
  productId: number;
  oldPrice: number;
  newPrice: number;
  reason: PriceDecisionReason;
  bestCompetitorPrice: number | null;
}

/**
 * Core rule, deliberately simple and easy to audit:
 *  - No competitor price known -> recover to max_price (your best price).
 *  - Competitor price known -> undercut by `undercutStep`, but never below min_price.
 *  - If undercutting would exceed max_price (competitor is already expensive),
 *    cap at max_price — don't leave money on the table just because you can.
 */
export function decidePrice(params: {
  currentPrice: number;
  minPrice: number;
  maxPrice: number;
  undercutStep: number;
  bestCompetitorPrice: number | null;
  recoveryEnabled: boolean;
}): { newPrice: number; reason: PriceDecisionReason } {
  const { currentPrice, minPrice, maxPrice, undercutStep, bestCompetitorPrice, recoveryEnabled } = params;

  if (bestCompetitorPrice === null) {
    if (recoveryEnabled && currentPrice !== maxPrice) {
      return { newPrice: maxPrice, reason: 'recovered_to_max' };
    }
    return { newPrice: currentPrice, reason: 'no_change' };
  }

  const desired = bestCompetitorPrice - undercutStep;
  const clampedLow = Math.max(desired, minPrice);
  const newPrice = Math.min(clampedLow, maxPrice);

  if (newPrice === currentPrice) {
    return { newPrice, reason: 'no_change' };
  }
  if (newPrice === minPrice && desired < minPrice) {
    return { newPrice, reason: 'floor_hit' };
  }
  return { newPrice, reason: 'undercut' };
}

/** Runs the rule for every active product using the freshest competitor snapshot per competitor row. */
export function runPricingOnce(dbPath = 'repricer.db'): PriceDecision[] {
  const db = openDb(dbPath);
  const decisions: PriceDecision[] = [];

  const products = db
    .prepare(
      `SELECT p.id, p.current_price, p.min_price, p.max_price,
              s.undercut_step, s.recovery_enabled
       FROM products p
       LEFT JOIN strategy_settings s ON s.product_id = p.id
       WHERE p.active = 1`
    )
    .all() as {
    id: number;
    current_price: number;
    min_price: number;
    max_price: number;
    undercut_step: number | null;
    recovery_enabled: number | null;
  }[];

  const bestCompetitorStmt = db.prepare(
    `SELECT MIN(l.price) as best_price
     FROM competitor_price_log l
     JOIN competitors c ON c.id = l.competitor_id
     WHERE c.product_id = ?
       AND l.price IS NOT NULL
       AND l.scraped_at = (
         SELECT MAX(l2.scraped_at) FROM competitor_price_log l2 WHERE l2.competitor_id = l.competitor_id
       )`
  );

  const insertDecision = db.prepare(
    `INSERT INTO price_change_log (product_id, old_price, new_price, reason, best_competitor_price)
     VALUES (?, ?, ?, ?, ?)`
  );
  const updatePrice = db.prepare(`UPDATE products SET current_price = ?, updated_at = datetime('now') WHERE id = ?`);

  for (const p of products) {
    const row = bestCompetitorStmt.get(p.id) as { best_price: number | null } | undefined;
    const bestCompetitorPrice = row?.best_price ?? null;

    const { newPrice, reason } = decidePrice({
      currentPrice: p.current_price,
      minPrice: p.min_price,
      maxPrice: p.max_price,
      undercutStep: p.undercut_step ?? 50,
      bestCompetitorPrice,
      recoveryEnabled: (p.recovery_enabled ?? 1) === 1,
    });

    decisions.push({ productId: p.id, oldPrice: p.current_price, newPrice, reason, bestCompetitorPrice });

    if (reason !== 'no_change') {
      insertDecision.run(p.id, p.current_price, newPrice, reason, bestCompetitorPrice);
      updatePrice.run(newPrice, p.id);
    }
  }

  db.close();
  return decisions;
}

if (import.meta.url === `file://${process.argv[1]}`) {
  const decisions = runPricingOnce();
  for (const d of decisions) {
    console.log(
      `product ${d.productId}: ${d.oldPrice}₸ -> ${d.newPrice}₸ (${d.reason}, competitor best: ${d.bestCompetitorPrice ?? 'n/a'})`
    );
  }
}
