/**
 * Live Kaspi seller-cabinet connection (phone + SMS login), so this
 * service can re-fetch your product list on its own instead of you
 * exporting/importing a file every time you add something.
 *
 * This is a PRIVATE, undocumented Kaspi surface (the same one the
 * cabinet's own web app calls) — not the official Partner API. It can
 * break without notice on any Kaspi frontend update. That risk was
 * explicitly accepted for this account; if it starts failing, the
 * fallback is always import-kaspi-export.ts (the file-based path).
 *
 * The session cookie captured here is as sensitive as a password — it's
 * a live, working login to the real seller cabinet. Stored in Postgres,
 * never logged, never returned in any HTTP response from this server.
 */
import { getPool, initSchema } from './database.js';

const LOGIN_BASE = 'https://idmc.shop.kaspi.kz';
const CABINET_BASE = 'https://mc.shop.kaspi.kz';

// Kaspi's login endpoint checks Origin/Referer like a real browser tab —
// set them to match, same spirit as parser.ts's realistic User-Agent.
const BROWSER_HEADERS = {
  origin: 'https://kaspi.kz',
  referer: 'https://kaspi.kz/',
  'user-agent':
    'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/151.0.0.0 Safari/537.36',
};

function formatKaspiPhone(rawDigits: string): string {
  // Kaspi's login form sends the phone as "+7 (7XX) XXX-XX-XX" — the
  // confirmed working shape (captured 2026-08-24). rawDigits: 10 digits,
  // no country code (e.g. "7751375910").
  const d = rawDigits.replace(/\D/g, '');
  const local = d.length === 11 && d.startsWith('7') ? d.slice(1) : d;
  return `+7 (${local.slice(0, 3)}) ${local.slice(3, 6)}-${local.slice(6, 8)}-${local.slice(8, 10)}`;
}

/**
 * Step 1: request an SMS code. Kaspi sets a short-lived cookie on this
 * response that ties "waiting for a code" to this specific phone — it
 * MUST be sent back on step 2, or the code confirms against no session
 * and fails with a generic {"errorCode":"FAILED"}. Returned here so the
 * caller can carry it forward (this server has no browser-style cookie
 * jar between separate requests).
 */
export async function requestLoginCode(phoneDigits: string): Promise<string> {
  const res = await fetch(`${LOGIN_BASE}/api/p/login`, {
    method: 'POST',
    headers: { 'content-type': 'application/json', ...BROWSER_HEADERS },
    body: JSON.stringify({ _ph: formatKaspiPhone(phoneDigits) }),
  });
  if (!res.ok) {
    throw new Error(`Failed to request SMS code: ${res.status} ${await res.text()}`);
  }
  const setCookie = res.headers.getSetCookie?.() ?? [];
  return setCookie.map((c) => c.split(';')[0]).join('; ');
}

/**
 * Step 2: confirm the SMS code, capture the session cookie, store it.
 * loginCookie is whatever requestLoginCode() returned — required so
 * Kaspi can match this code to the phone from step 1.
 */
export async function confirmLoginCode(code: string, merchantUid: string, loginCookie: string): Promise<void> {
  const res = await fetch(`${LOGIN_BASE}/api/p/login`, {
    method: 'POST',
    headers: { 'content-type': 'application/json', cookie: loginCookie, ...BROWSER_HEADERS },
    body: JSON.stringify({ _c: code }),
  });
  if (!res.ok) {
    throw new Error(`Wrong or expired code: ${res.status} ${await res.text()}`);
  }

  const setCookie = res.headers.getSetCookie?.() ?? [];
  // Merge step 1's cookie with any new/updated ones from step 2 — some
  // auth flows keep the original session id and just mark it verified,
  // rather than issuing an entirely fresh cookie. Same-named cookies from
  // step 2 override step 1's value.
  const merged = new Map<string, string>();
  for (const pair of loginCookie.split(';')) {
    const [name, ...rest] = pair.trim().split('=');
    if (name) merged.set(name, rest.join('='));
  }
  for (const raw of setCookie) {
    const pair = raw.split(';')[0];
    const [name, ...rest] = pair.trim().split('=');
    if (name) merged.set(name, rest.join('='));
  }
  if (merged.size === 0) {
    throw new Error('Login succeeded but no session cookie was returned — Kaspi may have changed how sessions work.');
  }
  const cookiePairs = Array.from(merged.entries())
    .map(([k, v]) => `${k}=${v}`)
    .join('; ');

  await initSchema();
  const db = getPool();
  await db.query(
    `INSERT INTO kaspi_session (id, cookie, merchant_uid, updated_at) VALUES (1, $1, $2, NOW())
     ON CONFLICT (id) DO UPDATE SET cookie = EXCLUDED.cookie, merchant_uid = EXCLUDED.merchant_uid, updated_at = NOW()`,
    [cookiePairs, merchantUid]
  );
}

/**
 * Manual path: paste the mc-session/mc-sid cookie values straight from
 * Chrome's own DevTools -> Application -> Cookies panel into the form on
 * THIS site (never through chat) — sidesteps needing to reverse-engineer
 * whatever exchange step turns an idmc login into an mc.shop.kaspi.kz
 * session. Same storage as the phone+SMS path.
 */
export async function saveManualSession(cookiePairs: string, merchantUid: string): Promise<void> {
  await initSchema();
  const db = getPool();
  await db.query(
    `INSERT INTO kaspi_session (id, cookie, merchant_uid, updated_at) VALUES (1, $1, $2, NOW())
     ON CONFLICT (id) DO UPDATE SET cookie = EXCLUDED.cookie, merchant_uid = EXCLUDED.merchant_uid, updated_at = NOW()`,
    [cookiePairs.trim(), merchantUid]
  );
}

export async function isConnected(): Promise<boolean> {
  await initSchema();
  const db = getPool();
  const { rows } = await db.query(`SELECT 1 FROM kaspi_session WHERE id = 1`);
  return rows.length > 0;
}

async function getSession(): Promise<{ cookie: string; merchantUid: string }> {
  await initSchema();
  const db = getPool();
  const { rows } = await db.query<{ cookie: string; merchant_uid: string }>(
    `SELECT cookie, merchant_uid FROM kaspi_session WHERE id = 1`
  );
  if (rows.length === 0) {
    throw new Error('Kaspi cabinet is not connected yet — go to /connect-kaspi first.');
  }
  return { cookie: rows[0].cookie, merchantUid: rows[0].merchant_uid };
}

/**
 * Pulls every product from the cabinet's "Управление товарами" list,
 * paginated. Field shape below is a first cut from one real (but
 * truncated) response captured 2026-08-24 — offerId/fileId/merchantUid
 * confirmed present; price/stock/name field names are NOT yet verified.
 * fetchRawProductList() exists specifically so the first live sync can
 * log one full raw record and we can nail down the exact fields from
 * Render's logs instead of guessing.
 */
export async function fetchRawProductList(): Promise<unknown[]> {
  const { cookie, merchantUid } = await getSession();
  const pageSize = 100;
  let page = 0;
  const all: unknown[] = [];

  for (;;) {
    const url = `${CABINET_BASE}/bff/offer-view/list?m=${merchantUid}&p=${page}&l=${pageSize}&a=false`;
    const res = await fetch(url, {
      headers: { cookie, 'x-auth-version': '3', ...BROWSER_HEADERS },
    });
    if (!res.ok) {
      throw new Error(`Product list fetch failed: ${res.status} ${await res.text()}`);
    }
    const json = (await res.json()) as { data: unknown[]; total: number };
    all.push(...json.data);
    if (all.length >= json.total || json.data.length === 0) break;
    page += 1;
  }

  return all;
}
