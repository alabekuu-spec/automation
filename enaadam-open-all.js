// Opens ALL logged-in enaadam.mn accounts at once, each in its own visible
// browser (its own persistent profile), landing on the ticket page. An account
// counts as "logged in" if its profiles/enaadam-account-N folder exists.
//
// Usage (from project root):
//   node enaadam-open-all.js            # open every saved account
//   node enaadam-open-all.js 1 2 8      # open only these indices (if saved)
import 'dotenv/config';
import path from 'node:path';
import fs from 'node:fs';
import { chromium } from 'playwright';
import { getEnaadamAccounts } from './enaadam-accounts.mjs';
import { isLoggedIn, TICKET_URL, delay } from './lib/enaadam-login.mjs';

const UA =
  'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/124.0.0.0 Safari/537.36';
const PROFILES_DIR = path.resolve('./profiles');

async function openAccount(acc) {
  const userDataDir = path.join(PROFILES_DIR, `enaadam-account-${acc.index}`);
  const context = await chromium.launchPersistentContext(userDataDir, {
    headless: false,
    slowMo: 20,
    viewport: { width: 1280, height: 800 },
    userAgent: UA,
  });
  const page = context.pages()[0] || (await context.newPage());
  page.setDefaultNavigationTimeout(60_000);
  try {
    await page.goto(TICKET_URL, { waitUntil: 'domcontentloaded' });
    await delay(2_500);
    const ok = await isLoggedIn(page);
    console.log(`  ${ok ? '✅' : '⚠️ '} acc${acc.index} (${acc.mobile}) — ${ok ? 'logged in' : 'NOT logged in (session expired?)'}`);
  } catch (e) {
    console.log(`  ❌ acc${acc.index} (${acc.mobile}) — ${e?.message || e}`);
  }
  // keep open until the user closes this window
  return new Promise((resolve) => context.on('close', resolve));
}

async function main() {
  const all = getEnaadamAccounts();
  const requested = process.argv.slice(2).map(Number).filter(Boolean);

  const candidates = (requested.length > 0 ? all.filter((a) => requested.includes(a.index)) : all)
    .filter((a) => fs.existsSync(path.join(PROFILES_DIR, `enaadam-account-${a.index}`)));

  if (candidates.length === 0) {
    console.error('❌ No saved accounts to open. Run enaadam-login.js first.');
    process.exit(1);
  }

  console.log(`🪟 Opening ${candidates.length} logged-in account(s) in parallel: ${candidates.map((a) => a.index).join(', ')}`);
  console.log('   Close each window to exit; the process ends when all are closed.\n');

  await Promise.all(candidates.map((acc) => openAccount(acc)));
  console.log('\nAll windows closed. Exiting.');
}

main().catch((e) => {
  console.error(e);
  process.exit(1);
});
