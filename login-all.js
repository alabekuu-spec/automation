// Logs each account into its persistent Chromium profile (profiles/account-N)
// so subsequent runs of join-groups.js / share-to-groups.js / check-membership.js
// can reuse the session and skip login.
//
// Sequential by default: opens one browser at a time. After performFacebookLogin
// returns (login completed, captcha/OTP solved), the browser is closed and the
// next account starts. Solve captchas manually in the visible browser.
//
// Usage (from project root):
//   node login-all.js              # all filled-in accounts
//   node login-all.js 2 3 4        # only those indices
import 'dotenv/config';
import path from 'node:path';
import fs from 'node:fs';
import { chromium } from 'playwright';
import { getAccounts } from './accounts.mjs';
import { performFacebookLogin, delay } from './lib/facebook-login.mjs';

const UA =
  'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/124.0.0.0 Safari/537.36';
const PROFILES_DIR = path.resolve('./profiles');

async function isLoggedIn(page) {
  for (const sel of [
    '[role="navigation"][aria-label="Facebook"]',
    '[aria-label="Your profile"]',
    '[aria-label="Account"]',
    'a[href="/me/"]',
    'a[href*="facebook.com/me"]',
  ]) {
    if ((await page.locator(sel).count().catch(() => 0)) > 0) return true;
  }
  return false;
}

async function loginAccount(acc) {
  const userDataDir = path.join(PROFILES_DIR, `account-${acc.index}`);
  fs.mkdirSync(userDataDir, { recursive: true });

  console.log(`\n▶ acc${acc.index} (${acc.email}) — opening persistent profile…`);
  const context = await chromium.launchPersistentContext(userDataDir, {
    headless: false,
    slowMo: 40,
    viewport: { width: 1280, height: 800 },
    userAgent: UA,
  });
  const page = context.pages()[0] || (await context.newPage());
  page.setDefaultNavigationTimeout(60_000);

  try {
    await page.goto('https://www.facebook.com/', { waitUntil: 'domcontentloaded' });
    await delay(2_000);
    if (await isLoggedIn(page)) {
      console.log(`✅ acc${acc.index} — already logged in, cookies are valid`);
      return 'already_logged_in';
    }
    console.log(`🔐 acc${acc.index} — logging in (solve any captcha / OTP in the visible browser)…`);
    await performFacebookLogin(page, {
      email: acc.email,
      password: acc.password,
      totpSecret: acc.totpSecret,
      index: acc.index,
    });
    console.log(`✅ acc${acc.index} — login complete, cookies saved to profiles/account-${acc.index}`);
    return 'logged_in';
  } catch (err) {
    console.error(`❌ acc${acc.index}: ${err?.message || err}`);
    try {
      const p = `screenshot-login-account${acc.index}.png`;
      await page.screenshot({ path: p, fullPage: true });
      console.error(`📸 ${p}`);
    } catch { /* ignore */ }
    return 'failed';
  } finally {
    try { await context.close(); } catch { /* already closed */ }
  }
}

async function main() {
  const all = getAccounts();
  if (all.length === 0) {
    console.error('❌ No accounts in .env (FB_EMAIL_N + FB_PASSWORD_N).');
    process.exit(1);
  }
  const requested = process.argv.slice(2).map(Number).filter(Boolean);
  const accounts = requested.length > 0
    ? all.filter((a) => requested.includes(a.index))
    : all;
  if (accounts.length === 0) {
    console.error('❌ No matching accounts.');
    process.exit(1);
  }

  console.log(`🔐 Logging in ${accounts.length} account(s) sequentially. Solve any captcha / OTP in the visible browser; the script waits for you.`);

  const results = [];
  for (const acc of accounts) {
    const status = await loginAccount(acc);
    results.push({ acc, status });
  }

  console.log('\n──── Final summary ────');
  for (const r of results) {
    console.log(`  acc${r.acc.index} (${r.acc.email}): ${r.status}`);
  }
}

main().catch((e) => {
  console.error(e);
  process.exit(1);
});
