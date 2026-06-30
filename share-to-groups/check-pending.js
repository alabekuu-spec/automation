// Read-only: open account 2 and list this account's pending posts in a group.
// Used to confirm whether a post landed in the admin-approval queue.
//
// Usage (from project root):
//   node share-to-groups/check-pending.js <groupId> [accountIndex]
//   node share-to-groups/check-pending.js 238190694446813 2

import 'dotenv/config';
import path from 'node:path';
import { chromium } from 'playwright';
import { getAccounts } from '../accounts.mjs';
import { delay } from '../lib/facebook-login.mjs';

const UA =
  'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/124.0.0.0 Safari/537.36';
const PROFILES_DIR = path.resolve('./profiles');

const GROUP_ID = process.argv[2];
const ACCOUNT_INDEX = Number(process.argv[3]) || 2;

if (!GROUP_ID) {
  console.error('Usage: node share-to-groups/check-pending.js <groupId> [accountIndex]');
  process.exit(1);
}

async function main() {
  const acc = getAccounts().find((a) => a.index === ACCOUNT_INDEX);
  if (!acc) { console.error(`No account ${ACCOUNT_INDEX}`); process.exit(1); }

  const userDataDir = path.join(PROFILES_DIR, `account-${acc.index}`);
  const context = await chromium.launchPersistentContext(userDataDir, {
    headless: false, slowMo: 20, viewport: { width: 1280, height: 800 }, userAgent: UA,
  });
  const page = context.pages()[0] || (await context.newPage());
  page.setDefaultNavigationTimeout(45_000);

  try {
    const url = `https://www.facebook.com/groups/${GROUP_ID}/my_pending_content`;
    console.log(`▶ acc${acc.index} → ${url}`);
    await page.goto(url, { waitUntil: 'domcontentloaded', timeout: 40_000 });
    await delay(4_000);
    const bodyText = (await page.evaluate(() => document.body.innerText).catch(() => '')) || '';
    const shot = `debug-pending-acc${acc.index}-${GROUP_ID}.png`;
    await page.screenshot({ path: shot, fullPage: true }).catch(() => {});

    const hasNone = /no pending|нийтлэх зүйл алга|хүлээгдэж буй.*алга|empty/i.test(bodyText);
    const mentionsReel = /share\/r\/14cPbAHuS7f|reel|рийл/i.test(bodyText);
    console.log(`\n📄 Pending-content page text (first 600 chars):\n${bodyText.replace(/\s+/g, ' ').slice(0, 600)}`);
    console.log(`\n— no-pending signal: ${hasNone ? 'YES (queue looks empty)' : 'no'}`);
    console.log(`— mentions our reel link/preview: ${mentionsReel ? 'YES' : 'no'}`);
    console.log(`💾 Screenshot: ${shot}`);
  } finally {
    await delay(2_000);
    try { await context.close(); } catch { /* ignore */ }
  }
}

main().catch((e) => { console.error(e); process.exit(1); });
