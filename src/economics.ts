/**
 * Per-unit economics for a Kaspi.kz sale: what actually lands in your
 * pocket after Kaspi's commission, Kaspi Delivery, and your own ИП tax.
 *
 * Numbers here are pinned to what was verified for this seller in
 * 2026-08: commission 13.5% (already includes the 16% VAT-on-commission
 * that started 2026-01-05), delivery per Kaspi's official "По Казахстану"
 * (intercity) column (source: Kaspi's "Информация о стоимости услуг —
 * Kaspi Доставка" PDF, tariff table dated 2025-02-03 — VAT is added on
 * top per that document's own terms), ИП tax 3% of turnover (упрощёнка).
 *
 * These are business constants, not hardcoded guesses — if your category
 * commission, tax regime, or Kaspi's delivery tariffs change, update them
 * here (or override per-product via the `commission_pct` column for
 * categories priced differently).
 */

export const DEFAULT_COMMISSION_PCT = 13.5; // %, already includes VAT-on-commission
export const IP_TAX_PCT = Number(process.env.IP_TAX_PCT ?? 3); // %, упрощёнка — of turnover, not profit
const DELIVERY_VAT_MULTIPLIER = 1.16; // Kaspi Delivery tariffs are quoted without VAT; +16% applies on top

/**
 * Kaspi Delivery, "По Казахстану" (intercity) column — tariffs effective
 * 2026-01-01 (guide.kaspi.kz/partner/ru/shop/delivery/shipping/q2288,
 * confirmed via screenshot 2026-08-25 — supersedes the 2025-02-03 table
 * this used to use, which had different breakpoints, notably 15,000₸
 * instead of 10,000₸). Below 10,000₸ the fee depends only on order
 * price, not weight. At/above 10,000₸ it switches to weight bands —
 * weightKg defaults to the "до 5 кг" bracket unless you pass a real
 * weight. Rows above 60kg not yet confirmed (screenshot was cut off).
 */
function kaspiDeliveryFeeExclVat(orderPrice: number, weightKg: number): number {
  if (orderPrice < 1000) return 49;
  if (orderPrice < 3000) return 149;
  if (orderPrice < 5000) return 199;
  if (orderPrice < 10000) return 799; // independent of weight in this band
  if (weightKg <= 5) return 1299;
  if (weightKg <= 15) return 1699;
  if (weightKg <= 30) return 3599;
  return 5649; // 30-60 кг; beyond 60kg not yet confirmed
}

export interface UnitEconomicsInput {
  currentPrice: number;
  costPrice: number;
  bonusCost?: number; // e.g. a bundled freebie/keychain — 0 if none
  commissionPct?: number; // defaults to DEFAULT_COMMISSION_PCT
  weightKg?: number; // only matters above the 15,000₸ delivery band
}

export interface UnitEconomics {
  revenue: number;
  costPrice: number;
  bonusCost: number;
  commission: number;
  delivery: number;
  ipTax: number;
  profit: number;
  marginPct: number; // profit as % of revenue
}

export function calculateUnitEconomics(input: UnitEconomicsInput): UnitEconomics {
  const revenue = input.currentPrice;
  const costPrice = input.costPrice;
  const bonusCost = input.bonusCost ?? 0;
  const commissionPct = input.commissionPct ?? DEFAULT_COMMISSION_PCT;
  const weightKg = input.weightKg ?? 0;

  const commission = revenue * (commissionPct / 100);
  const delivery = kaspiDeliveryFeeExclVat(revenue, weightKg) * DELIVERY_VAT_MULTIPLIER;
  const ipTax = revenue * (IP_TAX_PCT / 100);

  const profit = revenue - costPrice - bonusCost - commission - delivery - ipTax;
  const marginPct = revenue > 0 ? (profit / revenue) * 100 : 0;

  return { revenue, costPrice, bonusCost, commission, delivery, ipTax, profit, marginPct };
}
