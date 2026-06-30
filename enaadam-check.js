// Verifies that every saved enaadam.mn account profile is still logged in.
// Opens each profiles/enaadam-account-N HEADLESSLY in parallel, loads the
// ticket page, and reports whether the saved session is still valid.
// Nothing is clicked or purchased — this is a read-only health check.
//
// Usage (from project root):
//   node enaadam-check.js            # check every saved account
//   node enaadam-check.js 1 2 3      # check only these indices
import 'dotenv/config';
import path from 'node:path';
import fs from 'node:fs';
import { chromium } from 'playwright';
import { getEnaadamAccounts } from './enaadam-accounts.mjs';
import { isLoggedIn, TICKET_URL, delay } from './lib/enaadam-login.mjs';

const UA =
  'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/124.0.0.0 Safari/537.36';
const PROFILES_DIR = path.resolve('./profiles');

async function checkAccount(acc) {
  const userDataDir = path.join(PROFILES_DIR, `enaadam-account-${acc.index}`);
  if (!fs.existsSync(userDataDir)) return { acc, ok: false, status: 'no_profile' };

  let context;
  try {
    context = await chromium.launchPersistentContext(userDataDir, {
      headless: true, viewport: { width: 1280, height: 800 }, userAgent: UA,
    });
    const page = context.pages()[0] || (await context.newPage());
    page.setDefaultNavigationTimeout(60_000);
    await page.goto(TICKET_URL, { waitUntil: 'domcontentloaded' });
    await delay(2_500);
    const ok = await isLoggedIn(page);
    return { acc, ok, status: ok ? 'logged_in' : 'session_expired' };
  } catch (e) {
    return { acc, ok: false, status: `error:${(e?.message || e).toString().slice(0, 60)}` };
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

  console.log(`🔍 Checking ${accounts.length} account(s) headlessly, in parallel…\n`);
  const results = await Promise.all(accounts.map((acc) => checkAccount(acc)));
  results.sort((a, b) => a.acc.index - b.acc.index);

  for (const r of results) {
    console.log(`  ${r.ok ? '✅' : '❌'} acc${r.acc.index} (${r.acc.mobile}): ${r.status}`);
  }

  const passed = results.filter((r) => r.ok);
  const failed = results.filter((r) => !r.ok);
  console.log(`\n──── Health check ────`);
  console.log(`✅ Working: ${passed.length}/${results.length}`);
  if (failed.length > 0) {
    console.log(`❌ Need attention: ${failed.map((r) => r.acc.index).join(', ')}`);
    console.log(`   Re-login with: node enaadam-login.js ${failed.map((r) => r.acc.index).join(' ')}`);
  } else {
    console.log('🎉 All accounts are logged in and ready.');
  }
}

main().catch((e) => { console.error(e); process.exit(1); });
