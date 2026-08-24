/**
 * Competitor price scraper — reads PUBLIC Kaspi product pages only.
 * No login, no credentials, nothing account-specific. This is the same
 * approach already used live in this project: navigate to the public
 * product URL and pull the price straight off the page.
 *
 * Anti-detection here means "look like an ordinary browser tab", not
 * evading any protected/authenticated surface — there isn't one here.
 */
import { chromium, type Browser } from 'playwright';
import { getPool, initSchema } from './database.js';

const USER_AGENT =
  'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/151.0.0.0 Safari/537.36';

interface ScrapeResult {
  price: number | null;
  inStock: boolean | null;
}

async function scrapeProductPage(browser: Browser, url: string): Promise<ScrapeResult> {
  const page = await browser.newPage({ userAgent: USER_AGENT, locale: 'ru-RU' });
  try {
    await page.goto(url, { waitUntil: 'domcontentloaded', timeout: 20_000 });

    // Kaspi's price block renders client-side; give it a moment.
    await page.waitForTimeout(800);

    const price = await page.evaluate(() => {
      // Kaspi shows price text like "Цена\n9 990 ₸" near the top of the card.
      const text = document.body.innerText;
      const idx = text.indexOf('Цена');
      if (idx < 0) return null;
      const snippet = text.slice(idx, idx + 60);
      const match = snippet.match(/([\d\s]+)\s*₸/);
      if (!match) return null;
      const digits = match[1].replace(/\s/g, '');
      const value = parseInt(digits, 10);
      return Number.isFinite(value) ? value : null;
    });

    const inStock = await page.evaluate(() => {
      const text = document.body.innerText.toLowerCase();
      if (text.includes('нет в наличии') || text.includes('товар закончился')) return false;
      return true;
    });

    return { price, inStock };
  } catch {
    return { price: null, inStock: null };
  } finally {
    await page.close();
  }
}

export async function runParserOnce() {
  await initSchema();
  const db = getPool();
  const { rows: competitors } = await db.query<{ id: number; kaspi_url: string }>(
    `SELECT c.id, c.kaspi_url FROM competitors c
     JOIN products p ON p.id = c.product_id
     WHERE c.active = 1 AND p.active = 1`
  );

  if (competitors.length === 0) {
    console.log('No active competitors to check. Add rows to the competitors table first.');
    return;
  }

  const browser = await chromium.launch({ headless: true });

  try {
    for (const c of competitors) {
      const { price, inStock } = await scrapeProductPage(browser, c.kaspi_url);
      await db.query(`INSERT INTO competitor_price_log (competitor_id, price, in_stock) VALUES ($1, $2, $3)`, [
        c.id,
        price,
        inStock === null ? null : inStock ? 1 : 0,
      ]);
      console.log(`[${c.id}] ${c.kaspi_url} -> ${price ?? 'unknown'} ₸ (in stock: ${inStock ?? 'unknown'})`);
      // Be a normal visitor, not a hammer — small pause between pages.
      await new Promise((r) => setTimeout(r, 1500 + Math.random() * 1500));
    }
  } finally {
    await browser.close();
  }
}

// Run directly: `npm run parser`
if (import.meta.url === `file://${process.argv[1]}`) {
  runParserOnce().catch((err) => {
    console.error(err);
    process.exit(1);
  });
}
