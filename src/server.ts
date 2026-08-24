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
import { calculateUnitEconomics, DEFAULT_COMMISSION_PCT } from './economics.js';
import { hasValidSession, checkPassword, sessionCookieHeader, clearCookieHeader, renderLoginPage } from './auth.js';
import { requestLoginCode, confirmLoginCode, isConnected, fetchRawProductList } from './kaspi-cabinet.js';

const PORT = Number(process.env.PORT) || 3000;

interface ProductRow {
  id: number;
  sku: string;
  name: string;
  current_price: number;
  available: number;
  preorder_days: number;
  cost_price: number;
  bonus_cost: number;
  commission_pct: number;
  weight_kg: number;
}

async function getProducts(): Promise<ProductRow[]> {
  const db = getPool();
  const { rows } = await db.query<ProductRow>(
    `SELECT id, sku, name, current_price, available, preorder_days,
            cost_price, bonus_cost, commission_pct, weight_kg
     FROM products WHERE active = 1 ORDER BY sku`
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
    .map((p) => {
      const econ = calculateUnitEconomics({
        currentPrice: p.current_price,
        costPrice: p.cost_price,
        bonusCost: p.bonus_cost,
        commissionPct: p.commission_pct,
        weightKg: p.weight_kg,
      });
      const profitClass = econ.profit < 0 ? 'neg' : '';
      return `
    <tr>
      <td>${escapeHtml(p.sku)}</td>
      <td>${escapeHtml(p.name)}</td>
      <td><input type="number" name="price_${p.id}" value="${p.current_price}" step="10"></td>
      <td><input type="checkbox" name="available_${p.id}" ${p.available ? 'checked' : ''}></td>
      <td><input type="number" name="preorder_${p.id}" value="${p.preorder_days}" min="0" max="30"></td>
      <td><input type="number" name="cost_${p.id}" value="${p.cost_price}" step="10"></td>
      <td><input type="number" name="bonus_${p.id}" value="${p.bonus_cost}" step="10"></td>
      <td class="calc ${profitClass}">${Math.round(econ.profit).toLocaleString('ru-RU')}₸</td>
      <td class="calc ${profitClass}">${econ.marginPct.toFixed(1)}%</td>
    </tr>`;
    })
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
  td.calc { font-variant-numeric: tabular-nums; color: #2e7d32; font-weight: 600; }
  td.calc.neg { color: #8c2a32; }
  .econ-note { font-size: 12px; color: #9c9086; max-width: 720px; margin: -8px 0 20px; }
  .tabs { display: flex; gap: 4px; margin-bottom: 24px; border-bottom: 1px solid #e4dad0; max-width: 720px; }
  .tab { font-size: 13px; color: #756a60; text-decoration: none; padding: 8px 14px; border-bottom: 2px solid transparent; }
  .tab.active { color: #8c2a32; border-bottom-color: #8c2a32; font-weight: 600; }
  .calc-grid { display: grid; grid-template-columns: 1fr 1fr; gap: 24px; max-width: 900px; }
  .calc-field { margin-bottom: 16px; }
  .calc-field label { display: flex; justify-content: space-between; font-size: 13px; color: #756a60; margin-bottom: 4px; }
  .calc-field input[type="number"] { width: 100%; padding: 6px 8px; box-sizing: border-box; }
  .calc-field input[type="range"] { width: 100%; }
  .calc-field .val { font-weight: 600; color: #201c1a; }
  .result-table { width: 100%; border-collapse: collapse; }
  .result-table td { padding: 7px 10px; border-bottom: 1px solid #e4dad0; font-size: 14px; }
  .result-table td:last-child { text-align: right; font-variant-numeric: tabular-nums; }
  .result-table tr.total td { font-weight: 700; font-size: 16px; border-top: 2px solid #201c1a; border-bottom: none; }
  .result-table tr.total.neg td { color: #8c2a32; }
  .result-table tr.total.pos td { color: #2e7d32; }
  .const-badge { font-size: 10px; text-transform: uppercase; background: #f3ede6; color: #9c9086; padding: 1px 6px; border-radius: 4px; margin-left: 6px; }
</style>
</head>
<body>
  <nav class="tabs"><a class="tab active" href="/">Заказы и цены</a><a class="tab" href="/unit-economics">Юнит-экономика</a><a class="tab" href="/connect-kaspi">Kaspi кабинет</a><form method="POST" action="/logout" style="margin-left:auto"><button type="submit" class="tab" style="background:none;border:none;cursor:pointer;font:inherit;padding:8px 14px;margin-top:0">Выйти</button></form></nav>
  <h1>Заказы</h1>
  ${renderOrdersBlock(summary, error)}
  <h1>Цены и предзаказ</h1>
  <form method="POST" action="/api/save">
    <table>
      <thead><tr><th>SKU</th><th>Название</th><th>Цена</th><th>В наличии</th><th>Предзаказ, дн.</th><th>Себестоимость</th><th>Бонус</th><th>Прибыль/шт</th><th>Маржа</th></tr></thead>
      <tbody>${rows}</tbody>
    </table>
    <button type="submit">Сохранить</button>
  </form>
  <p class="econ-note">Прибыль/маржа считаются автоматически: комиссия Kaspi ${DEFAULT_COMMISSION_PCT}% (с НДС), доставка по Казахстану (799,11₸ + НДС 16% для заказов 5 000–15 000₸), налог ИП на упрощёнке 3% с оборота.</p>
  <p class="link">Ссылка для автозагрузки в Kaspi (вставить один раз в Товары → Загрузить прайс-лист → Автоматическая загрузка):<br><code>${'{ДОМЕН_ПОСЛЕ_ДЕПЛОЯ}'}/price-list.csv</code></p>
</body>
</html>`;
}

function renderUnitEconomicsPage(): string {
  return `<!doctype html>
<html lang="ru">
<head>
<meta charset="utf-8">
<title>Kaspi — юнит-экономика</title>
<style>
  body { font-family: -apple-system, "Segoe UI", Arial, sans-serif; background: #faf7f3; color: #201c1a; padding: 32px; }
  .tabs { display: flex; gap: 4px; margin-bottom: 24px; border-bottom: 1px solid #e4dad0; max-width: 900px; }
  .tab { font-size: 13px; color: #756a60; text-decoration: none; padding: 8px 14px; border-bottom: 2px solid transparent; }
  .tab.active { color: #8c2a32; border-bottom-color: #8c2a32; font-weight: 600; }
  .calc-grid { display: grid; grid-template-columns: 1fr 1fr; gap: 0 32px; max-width: 900px; align-items: start; }
  .calc-field { margin-bottom: 16px; }
  .calc-field label { display: flex; justify-content: space-between; font-size: 13px; color: #756a60; margin-bottom: 4px; }
  .calc-field input[type="number"] { width: 100%; padding: 6px 8px; box-sizing: border-box; font-size: 14px; }
  .calc-field input[type="range"] { width: 100%; }
  .calc-field .val { font-weight: 600; color: #201c1a; }
  .const-badge { font-size: 10px; text-transform: uppercase; background: #f3ede6; color: #9c9086; padding: 1px 6px; border-radius: 4px; margin-left: 6px; }
  .result-card { background: #fff; border: 1px solid #e4dad0; border-radius: 12px; padding: 18px 20px; max-width: 420px; }
  .result-table { width: 100%; border-collapse: collapse; }
  .result-table td { padding: 7px 0; border-bottom: 1px solid #e4dad0; font-size: 14px; }
  .result-table td:last-child { text-align: right; font-variant-numeric: tabular-nums; }
  .result-table tr.total td { font-weight: 700; font-size: 16px; border-top: 2px solid #201c1a; border-bottom: none; padding-top: 12px; }
  .result-table tr.total.neg td { color: #8c2a32; }
  .result-table tr.total.pos td { color: #2e7d32; }
  .muted { font-size: 12px; color: #9c9086; margin: 4px 0 0; }
</style>
</head>
<body>
  <nav class="tabs"><a class="tab" href="/">Заказы и цены</a><a class="tab active" href="/unit-economics">Юнит-экономика</a><a class="tab" href="/connect-kaspi">Kaspi кабинет</a><form method="POST" action="/logout" style="margin-left:auto"><button type="submit" class="tab" style="background:none;border:none;cursor:pointer;font:inherit;padding:8px 14px;margin-top:0">Выйти</button></form></nav>
  <h1>Юнит-экономика</h1>
  <p class="muted">Калькулятор одной штуки товара — все поля переменные, кроме налога ИП (3%, упрощёнка). Доставка Kaspi считается сама по цене товара, по официальному тарифу "по Казахстану".</p>

  <div class="calc-grid">
    <div>
      <div class="calc-field">
        <label>Цена продажи на Kaspi, ₸ <span class="val" id="v-price">8990</span></label>
        <input type="number" id="price" value="8990" step="10" min="0">
      </div>
      <div class="calc-field">
        <label>Себестоимость товара, ₸ <span class="val" id="v-cost">4105</span></label>
        <input type="number" id="cost" value="4105" step="10" min="0">
      </div>
      <div class="calc-field">
        <label>Комиссия Kaspi, % <span class="val" id="v-commission">13.5%</span></label>
        <input type="number" id="commission" value="13.5" step="0.1" min="0" max="100">
      </div>
      <div class="calc-field">
        <label>Бонус на товар (от продавца), % <span class="val">обычно 5–15%</span></label>
        <input type="number" id="bonusPct" value="0" step="0.5" min="0">
      </div>
      <div class="calc-field">
        <label>Бонус за отзыв, ₸ <span class="val">обычно 100–2000</span></label>
        <input type="number" id="reviewBonus" value="0" step="50" min="0">
      </div>
      <div class="calc-field">
        <label>Реклама, % <span class="val">обычно 5–50%</span></label>
        <input type="number" id="adsPct" value="0" step="1" min="0">
      </div>
      <div class="calc-field">
        <label>Налог ИП (упрощёнка) <span class="const-badge">константа</span></label>
        <input type="number" value="3" disabled style="opacity:.6">
      </div>
    </div>

    <div class="result-card">
      <table class="result-table">
        <tr><td>Цена продажи</td><td id="r-price">—</td></tr>
        <tr><td>Себестоимость</td><td id="r-cost">—</td></tr>
        <tr><td>Комиссия Kaspi</td><td id="r-commission">—</td></tr>
        <tr><td>Kaspi Доставка, по РК (авто + НДС 16%)</td><td id="r-delivery">—</td></tr>
        <tr><td>Бонус на товар</td><td id="r-bonusPct">—</td></tr>
        <tr><td>Бонус за отзыв</td><td id="r-reviewBonus">—</td></tr>
        <tr><td>Реклама</td><td id="r-ads">—</td></tr>
        <tr><td>Налог ИП (3%)</td><td id="r-tax">—</td></tr>
        <tr class="total" id="row-profit"><td>Чистая прибыль/шт</td><td id="r-profit">—</td></tr>
        <tr class="total" id="row-margin"><td>Маржа (от цены продажи)</td><td id="r-margin">—</td></tr>
        <tr class="total" id="row-roi"><td>Рентабельность (от себестоимости)</td><td id="r-roi">—</td></tr>
      </table>
    </div>
  </div>

<script>
// Kaspi Delivery, "По Казахстану" column — official tariff table (Kaspi's
// "Информация о стоимости услуг — Kaspi Доставка" PDF). Independent of
// weight below 15,000₸; mirrors src/economics.ts on the server side.
function kaspiDeliveryExclVat(price) {
  if (price < 5000) return 0;
  if (price <= 15000) return 799.11;
  return 1299.11; // >15,000₸, "до 5 кг" band — this calculator assumes light goods
}
const DELIVERY_VAT = 1.16;
const TAX_PCT = 3;

function fmt(n) {
  return Math.round(n).toLocaleString('ru-RU') + '₸';
}

function recalc() {
  const price = Number(document.getElementById('price').value) || 0;
  const cost = Number(document.getElementById('cost').value) || 0;
  const commissionPct = Number(document.getElementById('commission').value) || 0;
  const bonusPct = Number(document.getElementById('bonusPct').value) || 0;
  const reviewBonus = Number(document.getElementById('reviewBonus').value) || 0;
  const adsPct = Number(document.getElementById('adsPct').value) || 0;

  document.getElementById('v-price').textContent = price.toLocaleString('ru-RU');
  document.getElementById('v-cost').textContent = cost.toLocaleString('ru-RU');
  document.getElementById('v-commission').textContent = commissionPct + '%';

  const commission = price * (commissionPct / 100);
  const delivery = kaspiDeliveryExclVat(price) * DELIVERY_VAT;
  const bonusAmount = price * (bonusPct / 100);
  const adsAmount = price * (adsPct / 100);
  const tax = price * (TAX_PCT / 100);

  const profit = price - cost - commission - delivery - bonusAmount - reviewBonus - adsAmount - tax;
  const margin = price > 0 ? (profit / price) * 100 : 0;
  const roi = cost > 0 ? (profit / cost) * 100 : 0;

  document.getElementById('r-price').textContent = fmt(price);
  document.getElementById('r-cost').textContent = '−' + fmt(cost);
  document.getElementById('r-commission').textContent = '−' + fmt(commission);
  document.getElementById('r-delivery').textContent = '−' + fmt(delivery);
  document.getElementById('r-bonusPct').textContent = '−' + fmt(bonusAmount);
  document.getElementById('r-reviewBonus').textContent = '−' + fmt(reviewBonus);
  document.getElementById('r-ads').textContent = '−' + fmt(adsAmount);
  document.getElementById('r-tax').textContent = '−' + fmt(tax);
  document.getElementById('r-profit').textContent = fmt(profit);
  document.getElementById('r-margin').textContent = margin.toFixed(1) + '%';
  document.getElementById('r-roi').textContent = roi.toFixed(1) + '%';

  const cls = profit < 0 ? 'neg' : 'pos';
  ['row-profit', 'row-margin', 'row-roi'].forEach((id) => {
    const row = document.getElementById(id);
    row.classList.remove('neg', 'pos');
    row.classList.add(cls);
  });
}

document.querySelectorAll('input').forEach((el) => el.addEventListener('input', recalc));
recalc();
</script>
</body>
</html>`;
}

function renderConnectKaspiPage(opts: {
  step: 'form' | 'code' | 'connected';
  merchantUid?: string;
  error?: string;
  notice?: string;
}): string {
  const nav = `<nav class="tabs"><a class="tab" href="/">Заказы и цены</a><a class="tab" href="/unit-economics">Юнит-экономика</a><a class="tab active" href="/connect-kaspi">Kaspi кабинет</a><form method="POST" action="/logout" style="margin-left:auto"><button type="submit" class="tab" style="background:none;border:none;cursor:pointer;font:inherit;padding:8px 14px;margin-top:0">Выйти</button></form></nav>`;

  let body = '';
  if (opts.step === 'connected') {
    body = `
    <div class="card" style="max-width:480px">
      <p>✅ Kaspi кабинет подключён.</p>
      <form method="POST" action="/connect-kaspi/sync">
        <button type="submit">Синхронизировать товары сейчас</button>
      </form>
      <p class="muted">Первый запуск: посмотри логи Render (вкладка Logs) — там будет выведена одна полная запись товара в сыром виде, чтобы проверить структуру перед тем, как включать это на постоянку.</p>
    </div>`;
  } else if (opts.step === 'code') {
    body = `
    <div class="card" style="max-width:420px">
      <p>Код отправлен SMS. Введи его:</p>
      <form method="POST" action="/connect-kaspi/verify">
        <input type="hidden" name="merchantUid" value="${escapeHtml(opts.merchantUid ?? '')}">
        <input type="text" name="code" placeholder="Код из SMS" autofocus required style="width:100%;padding:8px;box-sizing:border-box;margin-bottom:10px">
        <button type="submit">Подтвердить</button>
      </form>
    </div>`;
  } else {
    body = `
    <div class="card" style="max-width:420px">
      <p class="muted">Подключи свой кабинет продавца Kaspi — сервис сможет сам забирать список товаров, без ручного экспорта/импорта каждый раз.</p>
      <form method="POST" action="/connect-kaspi">
        <label style="font-size:13px;color:#756a60">Номер телефона (от кабинета Kaspi)</label>
        <input type="text" name="phone" placeholder="7XXXXXXXXXX" required style="width:100%;padding:8px;box-sizing:border-box;margin:4px 0 10px">
        <label style="font-size:13px;color:#756a60">ID продавца (видно в кабинете Kaspi, вверху)</label>
        <input type="text" name="merchantUid" placeholder="30475177" required style="width:100%;padding:8px;box-sizing:border-box;margin:4px 0 10px">
        <button type="submit">Отправить код</button>
      </form>
    </div>`;
  }

  return `<!doctype html>
<html lang="ru">
<head>
<meta charset="utf-8">
<title>Kaspi — подключение кабинета</title>
<style>
  body { font-family: -apple-system, "Segoe UI", Arial, sans-serif; background: #faf7f3; color: #201c1a; padding: 32px; }
  .tabs { display: flex; gap: 4px; margin-bottom: 24px; border-bottom: 1px solid #e4dad0; max-width: 900px; }
  .tab { font-size: 13px; color: #756a60; text-decoration: none; padding: 8px 14px; border-bottom: 2px solid transparent; }
  .tab.active { color: #8c2a32; border-bottom-color: #8c2a32; font-weight: 600; }
  .card { background: #fff; border: 1px solid #e4dad0; border-radius: 12px; padding: 20px; }
  input[type="text"] { font-size: 14px; }
  button { background: #8c2a32; color: #fff; border: none; padding: 10px 18px; border-radius: 8px; font-size: 14px; cursor: pointer; }
  .muted { font-size: 12px; color: #9c9086; margin: 4px 0 12px; }
  .err { color: #8c2a32; font-size: 13px; }
</style>
</head>
<body>
  ${nav}
  <h1>Kaspi кабинет</h1>
  ${opts.error ? `<p class="err">${escapeHtml(opts.error)}</p>` : ''}
  ${opts.notice ? `<p class="muted">${escapeHtml(opts.notice)}</p>` : ''}
  ${body}
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

    // Kaspi's own servers fetch this on a schedule with no way to log in
    // first — never gate it behind the password.
    const isPublicPath = url.pathname === '/price-list.csv';

    if (req.method === 'GET' && url.pathname === '/login') {
      res.writeHead(200, { 'content-type': 'text/html; charset=utf-8' });
      res.end(renderLoginPage());
      return;
    }

    if (req.method === 'POST' && url.pathname === '/login') {
      const body = await readBody(req);
      const params = new URLSearchParams(body);
      const password = params.get('password') ?? '';
      if (checkPassword(password)) {
        res.writeHead(302, { location: '/', 'set-cookie': sessionCookieHeader(password) });
        res.end();
      } else {
        res.writeHead(401, { 'content-type': 'text/html; charset=utf-8' });
        res.end(renderLoginPage('Неверный пароль'));
      }
      return;
    }

    if (req.method === 'POST' && url.pathname === '/logout') {
      res.writeHead(302, { location: '/login', 'set-cookie': clearCookieHeader() });
      res.end();
      return;
    }

    if (!isPublicPath && !hasValidSession(req.headers.cookie)) {
      res.writeHead(302, { location: '/login' });
      res.end();
      return;
    }

    if (req.method === 'GET' && url.pathname === '/') {
      res.writeHead(200, { 'content-type': 'text/html; charset=utf-8' });
      res.end(await renderPage());
      return;
    }

    if (req.method === 'GET' && url.pathname === '/connect-kaspi') {
      const connected = await isConnected();
      res.writeHead(200, { 'content-type': 'text/html; charset=utf-8' });
      res.end(renderConnectKaspiPage({ step: connected ? 'connected' : 'form' }));
      return;
    }

    if (req.method === 'POST' && url.pathname === '/connect-kaspi') {
      const body = await readBody(req);
      const params = new URLSearchParams(body);
      const phone = params.get('phone') ?? '';
      const merchantUid = params.get('merchantUid') ?? '';
      try {
        await requestLoginCode(phone);
        res.writeHead(200, { 'content-type': 'text/html; charset=utf-8' });
        res.end(renderConnectKaspiPage({ step: 'code', merchantUid }));
      } catch (err) {
        res.writeHead(200, { 'content-type': 'text/html; charset=utf-8' });
        res.end(renderConnectKaspiPage({ step: 'form', error: (err as Error).message }));
      }
      return;
    }

    if (req.method === 'POST' && url.pathname === '/connect-kaspi/verify') {
      const body = await readBody(req);
      const params = new URLSearchParams(body);
      const code = params.get('code') ?? '';
      const merchantUid = params.get('merchantUid') ?? '';
      try {
        await confirmLoginCode(code, merchantUid);
        res.writeHead(302, { location: '/connect-kaspi' });
        res.end();
      } catch (err) {
        res.writeHead(200, { 'content-type': 'text/html; charset=utf-8' });
        res.end(renderConnectKaspiPage({ step: 'code', merchantUid, error: (err as Error).message }));
      }
      return;
    }

    if (req.method === 'POST' && url.pathname === '/connect-kaspi/sync') {
      try {
        const products = await fetchRawProductList();
        console.log(`Kaspi cabinet sync: fetched ${products.length} raw product record(s).`);
        console.log('First raw record (for verifying field shape):', JSON.stringify(products[0], null, 2));
        res.writeHead(200, { 'content-type': 'text/html; charset=utf-8' });
        res.end(
          renderConnectKaspiPage({
            step: 'connected',
            notice: `Синхронизация прошла: ${products.length} товар(ов) получено. Полная первая запись — в логах Render (вкладка Logs).`,
          })
        );
      } catch (err) {
        res.writeHead(200, { 'content-type': 'text/html; charset=utf-8' });
        res.end(renderConnectKaspiPage({ step: 'connected', error: (err as Error).message }));
      }
      return;
    }

    if (req.method === 'GET' && url.pathname === '/unit-economics') {
      res.writeHead(200, { 'content-type': 'text/html; charset=utf-8' });
      res.end(renderUnitEconomicsPage());
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
        const cost = Number(params.get(`cost_${p.id}`) ?? p.cost_price);
        const bonus = Number(params.get(`bonus_${p.id}`) ?? p.bonus_cost);
        await db.query(
          `UPDATE products SET current_price = $1, available = $2, preorder_days = $3,
                                cost_price = $4, bonus_cost = $5, updated_at = NOW()
           WHERE id = $6`,
          [price, available, preorder, cost, bonus, p.id]
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
