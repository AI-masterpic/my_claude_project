/**
 * SKELETON for logging into idmc.shop.kaspi.kz and driving the seller
 * cabinet directly (pre-order confirmation, order status checks — the
 * things the documented price-list mechanism can't do).
 *
 * READ THIS BEFORE RUNNING ANYTHING:
 *
 * - This talks to a PRIVATE, undocumented Kaspi endpoint, not the official
 *   Partner API. It can break without notice on any Kaspi frontend update,
 *   and automating this surface sits in a ToS grey zone — that risk is
 *   yours to accept for your own account, not something to run casually.
 * - Credentials NEVER go in this file or in source control. They are read
 *   from environment variables at runtime, on whatever machine YOU deploy
 *   this to. Nobody else — including whoever wrote this file — ever sees
 *   them.
 * - Step 1 (submit phone, Kaspi sends an SMS) is confirmed working:
 *     POST https://idmc.shop.kaspi.kz/api/p/login
 *     body: {"_ph": "+7 (700) 000-00-00"}
 *   Step 2 (submit the SMS code) is NOT YET WIRED UP — it needs the real
 *   request shape, which only shows up when a real code is submitted.
 *   Capture it yourself (DevTools -> Network, log in normally, find the
 *   request right after you type the code) and fill in `confirmLoginCode`
 *   below. Until then this script stops after requesting the code.
 */

const KASPI_LOGIN_BASE = 'https://idmc.shop.kaspi.kz';

interface Session {
  cookies: string; // raw Cookie header value captured after a successful login
}

function requirePhoneFromEnv(): string {
  const phone = process.env.KASPI_PHONE;
  if (!phone) {
    throw new Error(
      'Set KASPI_PHONE in your own environment (e.g. `export KASPI_PHONE="+7 (7XX) XXX-XX-XX"`) — never hardcode it here.'
    );
  }
  return phone;
}

/** Step 1: request an SMS code for the given phone. Confirmed working shape. */
async function requestLoginCode(phone: string): Promise<void> {
  const res = await fetch(`${KASPI_LOGIN_BASE}/api/p/login`, {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ _ph: phone }),
  });
  if (!res.ok) {
    throw new Error(`Login step 1 failed: ${res.status} ${await res.text()}`);
  }
  console.log('SMS code requested. Check your phone.');
}

/**
 * Step 2: TODO — submit the SMS code and capture the resulting session.
 * Fill in the real endpoint + body shape once you've captured it from
 * DevTools. This placeholder intentionally throws so nobody mistakes it
 * for working code.
 */
async function confirmLoginCode(_phone: string, _code: string): Promise<Session> {
  throw new Error(
    'confirmLoginCode is not implemented yet — need the real step-2 request shape from a real login (see file header).'
  );
}

/** Example of what comes AFTER a session exists — not runnable yet. */
async function updatePriceInCabinet(_session: Session, _kaspiProductCode: string, _newPrice: number): Promise<void> {
  throw new Error('Not implemented — depends on confirmLoginCode working first, and on capturing the price-update request shape too.');
}

async function main() {
  const phone = requirePhoneFromEnv();
  await requestLoginCode(phone);

  const code = process.env.KASPI_SMS_CODE;
  if (!code) {
    console.log('Set KASPI_SMS_CODE (the code you just received) and re-run to continue past step 1.');
    return;
  }

  const session = await confirmLoginCode(phone, code);
  console.log('Logged in, session captured (not persisted anywhere by this script — that\'s your call).');
  void session;
}

if (import.meta.url === `file://${process.argv[1]}`) {
  main().catch((err) => {
    console.error(err.message);
    process.exit(1);
  });
}
