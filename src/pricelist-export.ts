/**
 * Turns the DB's current prices into the exact CSV format Kaspi's
 * "Загрузить прайс-лист" accepts — SKU, model, brand, price, PP1-PP5, preorder.
 * Safe, official path: no login, no cabinet automation.
 */
import { writeFileSync } from 'node:fs';
import { getPool, initSchema } from './database.js';

function csvCell(value: string | number): string {
  const s = String(value);
  return /[",\n]/.test(s) ? '"' + s.replace(/"/g, '""') + '"' : s;
}

export async function buildPriceListCsv(): Promise<string> {
  await initSchema();
  const db = getPool();
  const { rows: products } = await db.query<{
    sku: string;
    name: string;
    current_price: number;
    available: number;
    preorder_days: number;
  }>(`SELECT sku, name, current_price, available, preorder_days FROM products WHERE active = 1`);

  const header = ['SKU', 'model', 'brand', 'price', 'PP1', 'PP2', 'PP3', 'PP4', 'PP5', 'preorder'];
  const rows = products.map((p) =>
    [
      p.sku,
      p.name,
      'Без бренда',
      p.current_price,
      p.available ? 'yes' : 'no',
      '',
      '',
      '',
      '',
      p.preorder_days > 0 ? p.preorder_days : '',
    ]
      .map(csvCell)
      .join(',')
  );

  return '﻿' + [header.join(','), ...rows].join('\r\n');
}

export async function exportPriceListCsv(outPath = 'price-list.csv') {
  const csv = await buildPriceListCsv();
  writeFileSync(outPath, csv, 'utf8');
  console.log(`Wrote price list to ${outPath}`);
}

if (import.meta.url === `file://${process.argv[1]}`) {
  exportPriceListCsv().catch((err) => {
    console.error(err);
    process.exit(1);
  });
}
