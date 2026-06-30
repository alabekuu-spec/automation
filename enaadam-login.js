// Logs each enaadam.mn account into its own persistent Chromium profile
// (profiles/enaadam-account-N) so the session is saved and reused later.
//
// Login is phone + SMS-OTP: the script pre-fills the phone number and triggers
// the SMS, then waits for you to type the code in the visible browser. Once a
// profile is logged in, re-running this skips it (session still valid).
//
// Usage (from project root):
//   node enaadam-login.js            # all filled-in ENAADAM_MOBILE_N accounts
//   node enaadam-login.js 1 3        # only those indices
import 'dotenv/config';
import path from 'node:path';
import fs from 'node:fs';
import { chromium } from 'playwright';
import { getEnaadamAccounts } from './enaadam-accounts.mjs';
import { performEnaadamLogin, checkSession, delay } from './lib/enaadam-login.mjs';

const UA =
  'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/124.0.0.0 Safari/537.36';
const PROFILES_DIR = path.resolve('./profiles');

async function loginAccount(acc) {
  const userDataDir = path.join(PROFILES_DIR, `enaadam-account-${acc.index}`);
  fs.mkdirSync(userDataDir, { recursive: true });

  console.log(`\n▶ acc${acc.index} (${acc.mobile}) — opening persistent profile…`);
  const context = await chromium.launchPersistentContext(userDataDir, {
    headless: false,
    slowMo: 40,
    viewport: { width: 1280, height: 800 },
    userAgent: UA,
  });
  const page = context.pages()[0] || (await context.newPage());
  page.setDefaultNavigationTimeout(60_000);

  try {
    if (await checkSession(page)) {
      console.log(`✅ acc${acc.index} — already logged in, session is valid`);
      return 'already_logged_in';
    }
    await performEnaadamLogin(page, { mobile: acc.mobile, index: acc.index });
    console.log(`✅ acc${acc.index} — login complete, session saved to profiles/enaadam-account-${acc.index}`);
    return 'logged_in';
  } catch (err) {
    console.error(`❌ acc${acc.index}: ${err?.message || err}`);
    try {
      const p = `screenshot-enaadam-login-account${acc.index}.png`;
      await page.screenshot({ path: p, fullPage: true });
      console.error(`📸 ${p}`);
    } catch { /* ignore */ }
    return 'failed';
  } finally {
    try { await context.close(); } catch { /* already closed */ }
  }
}

async function main() {
  const all = getEnaadamAccounts();
  if (all.length === 0) {
    console.error('❌ No accounts in .env (ENAADAM_MOBILE_N). Add at least ENAADAM_MOBILE_1.');
    process.exit(1);
  }
  const requested = process.argv.slice(2).map(Number).filter(Boolean);
  const accounts = requested.length > 0 ? all.filter((a) => requested.includes(a.index)) : all;
  if (accounts.length === 0) {
    console.error('❌ No matching accounts for the given indices.');
    process.exit(1);
  }

  console.log(`🔐 Logging in ${accounts.length} enaadam.mn account(s) sequentially.`);
  console.log('   Each opens a visible browser — type the SMS code there when prompted.');

  const results = [];
  for (const acc of accounts) {
    const status = await loginAccount(acc);
    results.push({ acc, status });
    await delay(1_500);
  }

  console.log('\n──── Final summary ────');
  for (const r of results) {
    console.log(`  acc${r.acc.index} (${r.acc.mobile}): ${r.status}`);
  }
}

main().catch((e) => {
  console.error(e);
  process.exit(1);
});
