// Opens an enaadam.mn account's persistent profile in a visible browser.
// If the session was saved by enaadam-login.js, it opens already logged in.
// The browser stays open until you close the window (or Ctrl+C here).
//
// Usage (from project root):
//   node enaadam-open.js 1          # open account 1 (default)
//   node enaadam-open.js 3          # open account 3
import 'dotenv/config';
import path from 'node:path';
import fs from 'node:fs';
import { chromium } from 'playwright';
import { getEnaadamAccounts } from './enaadam-accounts.mjs';
import { isLoggedIn, TICKET_URL, delay } from './lib/enaadam-login.mjs';

const UA =
  'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/124.0.0.0 Safari/537.36';
const PROFILES_DIR = path.resolve('./profiles');

async function main() {
  const index = Number(process.argv[2]) || 1;
  const acc = getEnaadamAccounts().find((a) => a.index === index);
  if (!acc) {
    console.error(`❌ No ENAADAM_MOBILE_${index} in .env`);
    process.exit(1);
  }

  const userDataDir = path.join(PROFILES_DIR, `enaadam-account-${index}`);
  if (!fs.existsSync(userDataDir)) {
    console.error(`❌ No saved profile for account ${index}. Run "node enaadam-login.js ${index}" first.`);
    process.exit(1);
  }

  console.log(`▶ Opening profiles/enaadam-account-${index} (${acc.mobile})…`);
  const context = await chromium.launchPersistentContext(userDataDir, {
    headless: false,
    slowMo: 40,
    viewport: { width: 1280, height: 800 },
    userAgent: UA,
  });
  const page = context.pages()[0] || (await context.newPage());
  page.setDefaultNavigationTimeout(60_000);

  await page.goto(TICKET_URL, { waitUntil: 'domcontentloaded' });
  await delay(2_500);

  if (await isLoggedIn(page)) {
    console.log(`✅ Already logged in — opened ${TICKET_URL}`);
  } else {
    console.log('⚠️  Not logged in (session expired or never saved). Run "node enaadam-login.js ' + index + '" to refresh.');
  }

  console.log('🪟 Browser is open. Close the window to exit.');
  // Keep the process alive until the browser/context is closed by the user.
  await new Promise((resolve) => context.on('close', resolve));
}

main().catch((e) => {
  console.error(e);
  process.exit(1);
});
