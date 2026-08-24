/**
 * Pricing decision engine. Pure logic in decidePrice() — no network calls.
 * runPricingOnce() reads the latest competitor snapshots from Postgres and
 * writes the decision back; pushing it out to Kaspi is a separate step
 * (pricelist-export.ts / server.ts).
 */
import { getPool, initSchema } from './database.js';

export type PriceDecisionReason = 'undercut' | 'floor_hit' | 'recovered_to_max' | 'no_change';

export interface PriceDecision {
  productId: number;
  oldPrice: number;
  newPrice: number;
  reason: PriceDecisionReason;
  bestCompetitorPrice: number | null;
}

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

export async function runPricingOnce(): Promise<PriceDecision[]> {
  await initSchema();
  const db = getPool();
  const decisions: PriceDecision[] = [];

  const { rows: products } = await db.query<{
    id: number;
    current_price: number;
    min_price: number;
    max_price: number;
    undercut_step: number | null;
    recovery_enabled: number | null;
  }>(
    `SELECT p.id, p.current_price, p.min_price, p.max_price,
            s.undercut_step, s.recovery_enabled
     FROM products p
     LEFT JOIN strategy_settings s ON s.product_id = p.id
     WHERE p.active = 1`
  );

  for (const p of products) {
    const { rows: bestRows } = await db.query<{ best_price: number | null }>(
      `SELECT MIN(l.price) as best_price
       FROM competitor_price_log l
       JOIN competitors c ON c.id = l.competitor_id
       WHERE c.product_id = $1
         AND l.price IS NOT NULL
         AND l.scraped_at = (
           SELECT MAX(l2.scraped_at) FROM competitor_price_log l2 WHERE l2.competitor_id = l.competitor_id
         )`,
      [p.id]
    );
    const bestCompetitorPrice = bestRows[0]?.best_price ?? null;

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
      await db.query(
        `INSERT INTO price_change_log (product_id, old_price, new_price, reason, best_competitor_price)
         VALUES ($1, $2, $3, $4, $5)`,
        [p.id, p.current_price, newPrice, reason, bestCompetitorPrice]
      );
      await db.query(`UPDATE products SET current_price = $1, updated_at = NOW() WHERE id = $2`, [newPrice, p.id]);
    }
  }

  return decisions;
}

if (import.meta.url === `file://${process.argv[1]}`) {
  runPricingOnce()
    .then((decisions) => {
      for (const d of decisions) {
        console.log(
          `product ${d.productId}: ${d.oldPrice}₸ -> ${d.newPrice}₸ (${d.reason}, конкурент: ${d.bestCompetitorPrice ?? 'n/a'})`
        );
      }
      process.exit(0);
    })
    .catch((err) => {
      console.error(err);
      process.exit(1);
    });
}
