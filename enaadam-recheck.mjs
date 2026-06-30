// Stricter login health check for every saved enaadam.mn profile.
//
// The earlier check (enaadam-check.js) loaded the PUBLIC /ticket page, where a
// logged-OUT user sees no login form — so it false-positived as "logged in".
// This version decides login from the LOGIN PAGE, which is unambiguous:
//   - logged OUT  → navigating to /auth/login STAYS on /auth and shows #mobile
//   - logged IN   → the SPA bounces away from /auth/login
// It also checks the home header for a "Нэвтрэх" (login) button as corroboration.
// Read-only: nothing is clicked or purchased. Prints the evidence per account.
//
// Usage:  node enaadam-recheck.mjs           (all saved accounts)
//         node enaadam-recheck.mjs 1 2 3      (only these)
import 'dotenv/config';
import path from 'node:path';
import fs from 'node:fs';
import { chromium } from 'playwright';
import { getEnaadamAccounts } from './enaadam-accounts.mjs';
import { LOGIN_URL, HOME_URL, delay } from './lib/enaadam-login.mjs';

const UA =
  'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/124.0.0.0 Safari/537.36';
const PROFILES_DIR = path.resolve('./profiles');

async function checkAccount(acc) {
  const userDataDir = path.join(PROFILES_DIR, `enaadam-account-${acc.index}`);
  if (!fs.existsSync(userDataDir)) return { acc, loggedIn: false, status: 'no_profile', ev: {} };

  let context;
  try {
    context = await chromium.launchPersistentContext(userDataDir, {
      headless: true, viewport: { width: 1280, height: 800 }, userAgent: UA,
    });
    const page = context.pages()[0] || (await context.newPage());
    page.setDefaultNavigationTimeout(60_000);

    // ── primary signal: the login page ──────────────────────────────
    await page.goto(LOGIN_URL, { waitUntil: 'domcontentloaded' }).catch(() => {});
    await delay(3_500); // give the SPA time to bounce if authenticated
    const loginUrl = page.url();
    const onAuth = /\/auth(\/|$)/.test(loginUrl);
    const mobileVisible = await page.locator('#mobile').first().isVisible().catch(() => false);

    // ── corroboration: a "Нэвтрэх" login control on the home header ──
    await page.goto(HOME_URL, { waitUntil: 'domcontentloaded' }).catch(() => {});
    await delay(2_000);
    const loginBtn =
      (await page.getByRole('button', { name: /^нэвтрэх$/i }).count().catch(() => 0)) +
      (await page.getByRole('link', { name: /^нэвтрэх$/i }).count().catch(() => 0));

    // logged in only if the login page bounced AND no #mobile AND no login button
    const loggedIn = !onAuth && !mobileVisible && loginBtn === 0;
    return {
      acc, loggedIn,
      status: loggedIn ? 'logged_in' : 'NOT_logged_in',
      ev: { loginUrl, onAuth, mobileVisible, loginBtn },
    };
  } catch (e) {
    return { acc, loggedIn: false, status: `error:${(e?.message || e).toString().slice(0, 60)}`, ev: {} };
  } finally {
    try { await context?.close(); } catch { /* */ }
  }
}

async function main() {
  const all = getEnaadamAccounts();
  const requested = process.argv.slice(2).map(Number).filter(Boolean);
  const accounts = (requested.length > 0 ? all.filter((a) => requested.includes(a.index)) : all)
    .filter((a) => fs.existsSync(path.join(PROFILES_DIR, `enaadam-account-${a.index}`)));

  if (accounts.length === 0) {
    console.error('❌ No saved accounts to check. Run enaadam-login.js first.');
    process.exit(1);
  }

  console.log(`🔍 Strict re-check of ${accounts.length} account(s) (login-page probe), headless…\n`);
  const results = await Promise.all(accounts.map((acc) => checkAccount(acc)));
  results.sort((a, b) => a.acc.index - b.acc.index);

  for (const r of results) {
    const ev = r.ev || {};
    const detail = r.status.startsWith('error') || r.status === 'no_profile'
      ? r.status
      : `${r.status}  [onAuth=${ev.onAuth} #mobile=${ev.mobileVisible} loginBtn=${ev.loginBtn} url=${(ev.loginUrl || '').replace('https://www.enaadam.mn', '')}]`;
    console.log(`  ${r.loggedIn ? '✅' : '❌'} acc${r.acc.index} (${r.acc.mobile}): ${detail}`);
  }

  const ok = results.filter((r) => r.loggedIn);
  const bad = results.filter((r) => !r.loggedIn);
  console.log(`\n──── Strict health check ────`);
  console.log(`✅ Logged in: ${ok.length}/${results.length}`);
  if (bad.length > 0) {
    console.log(`❌ NOT logged in: ${bad.map((r) => r.acc.index).join(', ')}`);
    console.log(`   Re-login with:  node enaadam-login.js ${bad.map((r) => r.acc.index).join(' ')}`);
  } else {
    console.log('🎉 All accounts genuinely logged in.');
  }
}

main().catch((e) => { console.error(e); process.exit(1); });
