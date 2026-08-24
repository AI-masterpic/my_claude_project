/**
 * The "automatic" piece: one small always-on web server that:
 *   GET  /            -> an edit page (price / available / preorder per product)
 *   POST /api/save    -> writes your edits to the DB
 *   GET  /price-list.csv -> always-current export, in Kaspi's exact format
 *
 * You paste the /price-list.csv URL into Kaspi's cabinet ONCE
 * (Товары -> Загрузить прайс-лист -> Автоматическая загрузка). From then
 * on: edit here, save, and Kaspi picks it up within ~60 minutes on its own.
 *
 * Data lives in Postgres (Supabase free tier) via DATABASE_URL — decoupled
 * from wherever this app itself runs, so a redeploy/restart of the app
 * never touches the data. No Kaspi login anywhere in this file.
 */
import http from 'node:http';
import { getPool, initSchema } from './database.js';
import { buildPriceListCsv } from './pricelist-export.js';
import { fetchRecentOrders, summarize, type OrdersDashboard } from './orders.js';

const PORT = Number(process.env.PORT) || 3000;

interface ProductRow {
  id: number;
  sku: string;
  name: string;
  current_price: number;
  available: number;
  preorder_days: number;
}

async function getProducts(): Promise<ProductRow[]> {
  const db = getPool();
  const { rows } = await db.query<ProductRow>(
    `SELECT id, sku, name, current_price, available, preorder_days FROM products WHERE active = 1 ORDER BY sku`
  );
  return rows;
}

function escapeHtml(s: string): string {
  return String(s).replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/"/g, '&quot;');
}

// Simple time-based cache so every page load doesn't hammer Kaspi's API.
let ordersCache: { summary: OrdersDashboard; fetchedAt: number } | null = null;
const ORDERS_CACHE_MS = 2 * 60 * 1000; // 2 minutes — close enough to "real time" without spamming the API

async function getOrdersSummary(): Promise<{ summary: OrdersDashboard | null; error: string | null }> {
  if (!process.env.KASPI_API_TOKEN) {
    return { summary: null, error: 'KASPI_API_TOKEN не задан — раздел заказов выключен.' };
  }
  if (ordersCache && Date.now() - ordersCache.fetchedAt < ORDERS_CACHE_MS) {
    return { summary: ordersCache.summary, error: null };
  }
  try {
    const orders = await fetchRecentOrders(14);
    const summary = summarize(orders);
    ordersCache = { summary, fetchedAt: Date.now() };
    return { summary, error: null };
  } catch (err) {
    return { summary: ordersCache?.summary ?? null, error: (err as Error).message };
  }
}

function renderOrdersBlock(summary: OrdersDashboard | null, error: string | null): string {
  if (!summary) {
    return `<div class="card orders-card"><p class="muted">${escapeHtml(error ?? 'Заказы недоступны')}</p></div>`;
  }
  return `
  <div class="card orders-card">
    <div class="orders-grid">
      <div class="stat"><span class="num">${summary.total}</span><span class="label">заказов за 14 дней</span></div>
      <div class="stat highlight"><span class="num">${summary.needsShipping}</span><span class="label">нужно отправить</span></div>
      <div class="stat"><span class="num">${summary.inDelivery}</span><span class="label">в доставке</span></div>
      <div class="stat"><span class="num">${summary.completed}</span><span class="label">выполнено</span></div>
      <div class="stat"><span class="num">${summary.totalRevenue.toLocaleString('ru-RU')}₸</span><span class="label">оборот</span></div>
    </div>
    ${error ? `<p class="muted">Показаны старые данные — обновить не удалось: ${escapeHtml(error)}</p>` : ''}
  </div>`;
}

async function renderPage(): Promise<string> {
  const [{ summary, error }, products] = await Promise.all([getOrdersSummary(), getProducts()]);

  const rows = products
    .map(
      (p) => `
    <tr>
      <td>${escapeHtml(p.sku)}</td>
      <td>${escapeHtml(p.name)}</td>
      <td><input type="number" name="price_${p.id}" value="${p.current_price}" step="10"></td>
      <td><input type="checkbox" name="available_${p.id}" ${p.available ? 'checked' : ''}></td>
      <td><input type="number" name="preorder_${p.id}" value="${p.preorder_days}" min="0" max="30"></td>
    </tr>`
    )
    .join('');

  return `<!doctype html>
<html lang="ru">
<head>
<meta charset="utf-8">
<title>Kaspi — прайс-лист (авто)</title>
<style>
  body { font-family: -apple-system, "Segoe UI", Arial, sans-serif; background: #faf7f3; color: #201c1a; padding: 32px; }
  table { border-collapse: collapse; width: 100%; max-width: 720px; }
  th, td { padding: 8px 10px; border-bottom: 1px solid #e4dad0; text-align: left; font-size: 14px; }
  th { font-size: 11px; text-transform: uppercase; color: #9c9086; }
  input[type="number"] { width: 90px; padding: 4px 6px; }
  button { background: #8c2a32; color: #fff; border: none; padding: 10px 18px; border-radius: 8px; font-size: 14px; cursor: pointer; margin-top: 16px; }
  .link { font-size: 13px; color: #756a60; margin-top: 20px; }
  .link code { background: #f3ede6; padding: 2px 6px; border-radius: 4px; }
  .card { background: #fff; border: 1px solid #e4dad0; border-radius: 12px; padding: 16px 18px; margin-bottom: 20px; max-width: 720px; }
  .orders-grid { display: flex; flex-wrap: wrap; gap: 20px; }
  .stat { display: flex; flex-direction: column; gap: 2px; min-width: 90px; }
  .stat .num { font-size: 22px; font-weight: 600; font-variant-numeric: tabular-nums; }
  .stat .label { font-size: 11px; text-transform: uppercase; letter-spacing: .04em; color: #9c9086; }
  .stat.highlight .num { color: #8c2a32; }
  .muted { font-size: 12px; color: #9c9086; margin: 4px 0 0; }
</style>
</head>
<body>
  <h1>Заказы</h1>
  ${renderOrdersBlock(summary, error)}
  <h1>Цены и предзаказ</h1>
  <form method="POST" action="/api/save">
    <table>
      <thead><tr><th>SKU</th><th>Название</th><th>Цена</th><th>В наличии</th><th>Предзаказ, дн.</th></tr></thead>
      <tbody>${rows}</tbody>
    </table>
    <button type="submit">Сохранить</button>
  </form>
  <p class="link">Ссылка для автозагрузки в Kaspi (вставить один раз в Товары → Загрузить прайс-лист → Автоматическая загрузка):<br><code>${'{ДОМЕН_ПОСЛЕ_ДЕПЛОЯ}'}/price-list.csv</code></p>
</body>
</html>`;
}

async function readBody(req: http.IncomingMessage): Promise<string> {
  const chunks: Buffer[] = [];
  for await (const chunk of req) chunks.push(chunk as Buffer);
  return Buffer.concat(chunks).toString('utf8');
}

const server = http.createServer(async (req, res) => {
  try {
    const url = new URL(req.url ?? '/', `http://${req.headers.host}`);

    if (req.method === 'GET' && url.pathname === '/') {
      res.writeHead(200, { 'content-type': 'text/html; charset=utf-8' });
      res.end(await renderPage());
      return;
    }

    if (req.method === 'GET' && url.pathname === '/price-list.csv') {
      res.writeHead(200, {
        'content-type': 'text/csv; charset=utf-8',
        'cache-control': 'no-store',
      });
      res.end(await buildPriceListCsv());
      return;
    }

    if (req.method === 'POST' && url.pathname === '/api/save') {
      const body = await readBody(req);
      const params = new URLSearchParams(body);
      const db = getPool();
      const products = await getProducts();
      for (const p of products) {
        const price = Number(params.get(`price_${p.id}`) ?? p.current_price);
        const available = params.get(`available_${p.id}`) ? 1 : 0;
        const preorder = Number(params.get(`preorder_${p.id}`) ?? 0);
        await db.query(
          `UPDATE products SET current_price = $1, available = $2, preorder_days = $3, updated_at = NOW() WHERE id = $4`,
          [price, available, preorder, p.id]
        );
      }
      res.writeHead(302, { location: '/' });
      res.end();
      return;
    }

    res.writeHead(404, { 'content-type': 'text/plain' });
    res.end('Not found');
  } catch (err) {
    console.error(err);
    res.writeHead(500, { 'content-type': 'text/plain; charset=utf-8' });
    res.end('Server error: ' + (err as Error).message);
  }
});

initSchema()
  .then(() => {
    server.listen(PORT, () => {
      console.log(`Server running on port ${PORT}`);
      console.log(`Edit page: http://localhost:${PORT}/`);
      console.log(`Price-list feed: http://localhost:${PORT}/price-list.csv`);
    });
  })
  .catch((err) => {
    console.error('Failed to initialize database schema:', err.message);
    process.exit(1);
  });
