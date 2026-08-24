/**
 * Single shared password for the whole site — this is a one-person tool,
 * not a multi-user product, so a full account system would be pure
 * overhead. Set SITE_PASSWORD in your environment (Render -> Environment)
 * to turn this on; if it's unset, the site stays open (so an existing
 * deployment doesn't suddenly lock you out before you've set it).
 *
 * /price-list.csv is deliberately EXEMPT — Kaspi's own servers fetch that
 * URL automatically on a schedule, with no way for them to log in first.
 */
import crypto from 'node:crypto';

const COOKIE_NAME = 'kr_session';
const SESSION_MAX_AGE_SECONDS = 60 * 60 * 24 * 30; // 30 days

function sitePassword(): string | null {
  const pw = process.env.SITE_PASSWORD;
  return pw && pw.length > 0 ? pw : null;
}

/** Deterministic token derived from the password — never the password itself in the cookie. */
function expectedToken(password: string): string {
  return crypto.createHmac('sha256', password).update(COOKIE_NAME).digest('hex');
}

export function authEnabled(): boolean {
  return sitePassword() !== null;
}

function parseCookies(header: string | undefined): Record<string, string> {
  const out: Record<string, string> = {};
  if (!header) return out;
  for (const part of header.split(';')) {
    const idx = part.indexOf('=');
    if (idx === -1) continue;
    const key = part.slice(0, idx).trim();
    const value = part.slice(idx + 1).trim();
    if (key) out[key] = decodeURIComponent(value);
  }
  return out;
}

export function hasValidSession(cookieHeader: string | undefined): boolean {
  const password = sitePassword();
  if (!password) return true; // auth not configured — stay open
  const cookies = parseCookies(cookieHeader);
  const token = cookies[COOKIE_NAME];
  if (!token) return false;
  const expected = expectedToken(password);
  // Constant-time compare to avoid timing side-channels.
  const a = Buffer.from(token);
  const b = Buffer.from(expected);
  return a.length === b.length && crypto.timingSafeEqual(a, b);
}

export function checkPassword(candidate: string): boolean {
  const password = sitePassword();
  if (!password) return true;
  const a = Buffer.from(candidate);
  const b = Buffer.from(password);
  return a.length === b.length && crypto.timingSafeEqual(a, b);
}

export function sessionCookieHeader(password: string): string {
  const token = expectedToken(password);
  return `${COOKIE_NAME}=${encodeURIComponent(token)}; HttpOnly; Path=/; Max-Age=${SESSION_MAX_AGE_SECONDS}; SameSite=Lax`;
}

export function clearCookieHeader(): string {
  return `${COOKIE_NAME}=; HttpOnly; Path=/; Max-Age=0; SameSite=Lax`;
}

export function renderLoginPage(error?: string): string {
  return `<!doctype html>
<html lang="ru">
<head>
<meta charset="utf-8">
<title>Kaspi — вход</title>
<style>
  body { font-family: -apple-system, "Segoe UI", Arial, sans-serif; background: #faf7f3; color: #201c1a;
         display: flex; align-items: center; justify-content: center; min-height: 100vh; margin: 0; }
  .card { background: #fff; border: 1px solid #e4dad0; border-radius: 12px; padding: 32px; width: 320px; }
  h1 { font-size: 18px; margin: 0 0 20px; }
  input[type="password"] { width: 100%; padding: 10px 12px; box-sizing: border-box; font-size: 14px; margin-bottom: 12px; }
  button { width: 100%; background: #8c2a32; color: #fff; border: none; padding: 10px; border-radius: 8px; font-size: 14px; cursor: pointer; }
  .err { color: #8c2a32; font-size: 13px; margin: -6px 0 12px; }
</style>
</head>
<body>
  <form class="card" method="POST" action="/login">
    <h1>Вход</h1>
    ${error ? `<p class="err">${error}</p>` : ''}
    <input type="password" name="password" placeholder="Пароль" autofocus required>
    <button type="submit">Войти</button>
  </form>
</body>
</html>`;
}
