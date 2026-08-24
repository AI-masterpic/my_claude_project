/**
 * Turns the DB's current prices into the exact CSV format Kaspi's
 * "Загрузить прайс-лист" accepts — same columns as the manual-upload
 * artifact tool: SKU, model, brand, price, PP1-PP5, preorder.
 *
 * This is the SAFE, official path: no login, no cabinet automation.
 * You (or a cron job) upload the resulting file in your Kaspi cabinet,
 * or point Kaspi's automatic price-list URL at wherever you host it.
 */
import { writeFileSync } from 'node:fs';
import { openDb } from './database.js';

function csvCell(value: string | number): string {
  const s = String(value);
  return /[",\n]/.test(s) ? '"' + s.replace(/"/g, '""') + '"' : s;
}

export function exportPriceListCsv(dbPath = 'repricer.db', outPath = 'price-list.csv') {
  const db = openDb(dbPath);
  const products = db
    .prepare(
      `SELECT sku, name, current_price, available, preorder_days
       FROM products WHERE active = 1`
    )
    .all() as { sku: string; name: string; current_price: number; available: number; preorder_days: number }[];
  db.close();

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

  const csv = '﻿' + [header.join(','), ...rows].join('\r\n');
  writeFileSync(outPath, csv, 'utf8');
  console.log(`Wrote ${products.length} products to ${outPath}`);
}

if (import.meta.url === `file://${process.argv[1]}`) {
  exportPriceListCsv();
}
