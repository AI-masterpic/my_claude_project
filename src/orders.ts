/**
 * Reads real order data via Kaspi's OFFICIAL Partner API — the token from
 * Settings -> API Token in your seller cabinet, NOT the private login flow
 * from cabinet-sync.ts. This is exactly the sanctioned, documented use case
 * for that token (orders), so it's safe by design: scoped, revocable in one
 * click, no session/cookie handling.
 *
 * Set KASPI_API_TOKEN as an environment variable on YOUR OWN deployment —
 * never in chat, never in this file, never committed.
 *
 * Field names below are best-effort from Kaspi's documentation (code,
 * totalPrice, status, state, creationDate) — NOT yet verified against a
 * real response. First real call should be checked against the actual
 * JSON shape before trusting this in production; adjust field paths if
 * Kaspi's real response differs.
 */

const KASPI_API_BASE = 'https://kaspi.kz/shop/api/v2';

export interface OrderSummary {
  code: string;
  status: string; // e.g. APPROVED_BY_BANK, ACCEPTED_BY_MERCHANT, COMPLETED, CANCELLED, RETURNED
  state: string; // e.g. NEW, PICKUP, DELIVERY, KASPI_DELIVERY, ARCHIVE
  totalPrice: number;
  creationDate: number; // epoch ms, per Kaspi's filter format
}

function requireToken(): string {
  const token = process.env.KASPI_API_TOKEN;
  if (!token) {
    throw new Error('Set KASPI_API_TOKEN in your own environment — never hardcode it here.');
  }
  return token;
}

/**
 * Fetches one page of orders. Kaspi's filters use JSON:API-style query
 * params (see general API docs) — this pulls everything from the last N
 * days and lets the caller bucket by status/state locally, which is more
 * robust than guessing the exact filter param names until verified live.
 */
export async function fetchRecentOrders(daysBack = 14): Promise<OrderSummary[]> {
  const token = requireToken();
  const since = Date.now() - daysBack * 24 * 60 * 60 * 1000;

  const url = new URL(`${KASPI_API_BASE}/orders`);
  url.searchParams.set('page[size]', '100');
  url.searchParams.set('filter[orders][creationDate][$ge]', String(since));

  const res = await fetch(url, {
    headers: {
      'X-Auth-Token': token,
      'Content-Type': 'application/vnd.api+json',
    },
  });

  if (!res.ok) {
    throw new Error(`Kaspi orders API returned ${res.status}: ${await res.text()}`);
  }

  const json = (await res.json()) as { data?: any[] };
  const rows = json.data ?? [];

  // Best-effort field mapping — VERIFY against a real response and adjust.
  return rows.map((row) => ({
    code: row.attributes?.code ?? row.id ?? 'unknown',
    status: row.attributes?.status ?? 'unknown',
    state: row.attributes?.state ?? 'unknown',
    totalPrice: row.attributes?.totalPrice ?? 0,
    creationDate: row.attributes?.creationDate ?? 0,
  }));
}

export interface OrdersDashboard {
  total: number;
  needsShipping: number; // state NEW or PICKUP — action needed from you
  inDelivery: number; // state DELIVERY or KASPI_DELIVERY
  completed: number; // status COMPLETED
  cancelled: number; // status CANCELLED or RETURNED
  totalRevenue: number; // sum of totalPrice for non-cancelled orders
}

export function summarize(orders: OrderSummary[]): OrdersDashboard {
  const needsShipping = orders.filter((o) => o.state === 'NEW' || o.state === 'PICKUP').length;
  const inDelivery = orders.filter((o) => o.state === 'DELIVERY' || o.state === 'KASPI_DELIVERY').length;
  const completed = orders.filter((o) => o.status === 'COMPLETED').length;
  const cancelled = orders.filter((o) => o.status === 'CANCELLED' || o.status === 'RETURNED').length;
  const totalRevenue = orders
    .filter((o) => o.status !== 'CANCELLED' && o.status !== 'RETURNED')
    .reduce((sum, o) => sum + o.totalPrice, 0);

  return { total: orders.length, needsShipping, inDelivery, completed, cancelled, totalRevenue };
}

if (import.meta.url === `file://${process.argv[1]}`) {
  fetchRecentOrders()
    .then((orders) => {
      const summary = summarize(orders);
      console.log(summary);
    })
    .catch((err) => {
      console.error(err.message);
      process.exit(1);
    });
}
