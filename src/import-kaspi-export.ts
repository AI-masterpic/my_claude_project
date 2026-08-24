/**
 * Bulk-loads your product catalog FROM a file you export yourself out of
 * the Kaspi cabinet (Управление товарами -> Действия с файлами -> Скачать
 * прайс-лист в Excel), INTO this service's own database.
 *
 * There is no official Kaspi API to "list all my products" — the
 * documented, supported surface is file-based (upload/download), so this
 * script reads that same export instead of guessing an endpoint. Re-run it
 * any time you add/change products in Kaspi: export again, run this again.
 * It's safe to re-run — existing SKUs get updated, new ones get inserted,
 * nothing is duplicated.
 *
 * Usage:
 *   npm run build
 *   npm run import-kaspi -- "C:/path/to/Товары ... .xlsx"
 *
 * Needs DATABASE_URL set (e.g. via a local .env — never commit it, never
 * paste it in chat). Node 22+ can load a local .env automatically with:
 *   node --env-file=.env dist/import-kaspi-export.js "..."
 */
import xlsx from 'xlsx';
import { getPool, initSchema } from './database.js';

const EXPECTED_HEADER = [
  'Артикул',
  'Наименование',
  'Бренд',
  'Цена',
  'Предзаказ',
  'Шаг',
  'Мин цена',
  'Макс цена',
];

interface ParsedRow {
  sku: string;
  name: string;
  currentPrice: number;
  preorderDays: number;
  minPrice: number;
  maxPrice: number;
  available: boolean;
}

function toInt(v: unknown): number | null {
  if (v === undefined || v === null || v === '') return null;
  const n = Number(String(v).replace(/\s/g, '').replace(',', '.'));
  return Number.isFinite(n) ? Math.round(n) : null;
}

function parseWorkbook(path: string): ParsedRow[] {
  const wb = xlsx.readFile(path);
  const sheet = wb.Sheets[wb.SheetNames[0]];
  const rows = xlsx.utils.sheet_to_json<string[]>(sheet, { header: 1, raw: false });

  const header = rows[0] ?? [];
  for (const col of EXPECTED_HEADER) {
    if (!header.includes(col)) {
      console.warn(
        `Warning: expected column "${col}" not found in this export's header — Kaspi may have changed the format. Header seen: ${JSON.stringify(header)}`
      );
    }
  }

  const idx = (label: string) => header.indexOf(label);
  const iSku = idx('Артикул');
  const iName = idx('Наименование');
  const iPrice = idx('Цена');
  const iPreorder = idx('Предзаказ');
  const iMin = idx('Мин цена');
  const iMax = idx('Макс цена');
  // Stock/availability columns are named per-warehouse ("Остаток PP1", "Остаток PP3", ...)
  // and vary by seller — pick up every column starting with "Остаток".
  const stockCols = header
    .map((h, i) => ({ h, i }))
    .filter(({ h }) => typeof h === 'string' && h.startsWith('Остаток'))
    .map(({ i }) => i);

  const out: ParsedRow[] = [];
  for (const row of rows.slice(1)) {
    if (!row || !row[iSku]) continue;
    const sku = String(row[iSku]).trim();
    const name = String(row[iName] ?? sku).trim();
    const currentPrice = toInt(row[iPrice]) ?? 0;
    const preorderDays = toInt(row[iPreorder]) ?? 0;
    const totalStock = stockCols.reduce((sum, i) => sum + (toInt(row[i]) ?? 0), 0);
    const explicitMin = iMin >= 0 ? toInt(row[iMin]) : null;
    const explicitMax = iMax >= 0 ? toInt(row[iMax]) : null;

    out.push({
      sku,
      name,
      currentPrice,
      preorderDays,
      // Kaspi's own "Мин/Макс цена" columns are usually blank for most
      // sellers (a separate Kaspi feature, not this repricer's strategy).
      // Default to current price (no-op range) when absent — tune real
      // floors/ceilings later once you decide a pricing strategy per SKU.
      minPrice: explicitMin ?? currentPrice,
      maxPrice: explicitMax ?? currentPrice,
      available: totalStock > 0,
    });
  }
  return out;
}

async function main() {
  const path = process.argv[2];
  if (!path) {
    console.error('Usage: npm run import-kaspi -- "C:/path/to/export.xlsx"');
    process.exit(1);
  }

  const products = parseWorkbook(path);
  console.log(`Parsed ${products.length} product(s) from the file.`);

  await initSchema();
  const db = getPool();

  for (const p of products) {
    await db.query(
      `INSERT INTO products (sku, name, cost_price, min_price, max_price, current_price, preorder_days, available)
       VALUES ($1, $2, $3, $4, $5, $6, $7, $8)
       ON CONFLICT (sku) DO UPDATE SET
         name = EXCLUDED.name,
         min_price = EXCLUDED.min_price,
         max_price = EXCLUDED.max_price,
         current_price = EXCLUDED.current_price,
         preorder_days = EXCLUDED.preorder_days,
         available = EXCLUDED.available,
         updated_at = NOW()`,
      [
        p.sku,
        p.name,
        // cost_price isn't in Kaspi's export (Kaspi doesn't know your cost).
        // Existing rows keep whatever cost you already set; new rows start
        // at 0 — fill in real cost later for accurate margin numbers.
        0,
        p.minPrice,
        p.maxPrice,
        p.currentPrice,
        p.preorderDays,
        p.available ? 1 : 0,
      ]
    );
  }

  console.log(`Done. ${products.length} product(s) inserted/updated.`);
  process.exit(0);
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
