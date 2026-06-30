// Read-only check: for each account, navigate to every group in
// workinggroups.txt and decide if the account is a member by looking for
// the "Write something…" composer trigger on the group page (visible only
// to members). No posting, no joining.
//
// Usage (from project root):
//   node share-to-groups/check-membership.js          # all accounts
//   node share-to-groups/check-membership.js 2 3 4    # only those accounts

import 'dotenv/config';
import path from 'node:path';
import fs from 'node:fs';
import { chromium } from 'playwright';
import { getAccounts } from '../accounts.mjs';
import { delay } from '../lib/facebook-login.mjs';
import { loadGroups } from '../groups.mjs';

const UA =
  'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/124.0.0.0 Safari/537.36';

const GROUPS_FILE = process.env.GROUPS_FILE || 'workinggroups.txt';
const PROFILES_DIR = path.resolve('./profiles');

const COMPOSER_TRIGGER_PATTERNS = [
  /write something/i,
  /create (a )?public post/i,
  /create post/i,
  /what'?s on your mind/i,
  /юу бодож байна/i,
  /пост бичих/i,
  /шинэ пост/i,
  /tulis sesuatu/i,
  /buat postingan/i,
  /apa yang anda pikirkan/i,
];

const JOIN_BUTTON_PATTERNS = [
  /^\s*join group\s*$/i,
  /^\s*\+?\s*join\s*$/i,
  /группэд\s+нэгдэх/i,
  /^\s*нэгдэх\s*$/i,
  /^\s*gabung(?:\s+ke\s+grup)?\s*$/i,
  /\bjoin\s+group\b/i,
];

const PENDING_BUTTON_PATTERNS = [
  /^cancel request$/i,
  /^хүсэлт цуцлах$/i,
  /^request sent$/i,
  /^хүсэлт илгээсэн$/i,
];

async function findText(page, patterns) {
  for (const pattern of patterns) {
    try {
      const el = page.getByText(pattern).first();
      if ((await el.count()) > 0 && (await el.isVisible().catch(() => false))) return true;
    } catch { /* next */ }
    try {
      const el = page.getByRole('button', { name: pattern }).first();
      if ((await el.count()) > 0 && (await el.isVisible().catch(() => false))) return true;
    } catch { /* next */ }
  }
  return false;
}

async function classifyGroup(page, group) {
  try {
    await page.goto(group.url, { waitUntil: 'domcontentloaded', timeout: 30_000 });
  } catch (e) {
    return { status: 'nav_failed', detail: (e.message || '').slice(0, 80) };
  }
  await delay(2_500);

  // Composer trigger visible = we're a member and can post
  if (await findText(page, COMPOSER_TRIGGER_PATTERNS)) return { status: 'member' };

  // "Cancel request" / "Request sent" = pending admin approval
  if (await findText(page, PENDING_BUTTON_PATTERNS)) return { status: 'pending' };

  // "Join group" button visible = NOT a member
  if (await findText(page, JOIN_BUTTON_PATTERNS)) return { status: 'not_member' };

  // No clear signal — could be banned, hidden, removed, etc.
  return { status: 'unclear' };
}

async function checkAccount(acc, groups) {
  const userDataDir = path.join(PROFILES_DIR, `account-${acc.index}`);
  if (!fs.existsSync(userDataDir)) {
    console.log(`\n▶ acc${acc.index} (${acc.email}) — no profile dir, SKIPPING (run login first)`);
    return { acc, perGroup: new Map(), skipped: true };
  }

  console.log(`\n▶ Checking acc${acc.index} (${acc.email}) against ${groups.length} group(s)…`);
  const context = await chromium.launchPersistentContext(userDataDir, {
    headless: false,
    slowMo: 20,
    viewport: { width: 1280, height: 800 },
    userAgent: UA,
  });
  const page = context.pages()[0] || (await context.newPage());
  page.setDefaultNavigationTimeout(45_000);

  const perGroup = new Map();
  try {
    for (const group of groups) {
      const r = await classifyGroup(page, group);
      perGroup.set(group.id, r);
      const icon = r.status === 'member' ? '✅'
        : r.status === 'pending' ? '⏳'
        : r.status === 'not_member' ? '❌'
        : r.status === 'nav_failed' ? '🚫'
        : '❓';
      console.log(`  ${icon} ${group.id.padEnd(28)} ${r.status}${r.detail ? '  ' + r.detail : ''}`);
      await delay(800 + Math.random() * 1200);
    }
  } finally {
    try { await context.close(); } catch { /* already closed */ }
  }
  return { acc, perGroup, skipped: false };
}

async function main() {
  if (!fs.existsSync(GROUPS_FILE)) {
    console.error(`❌ GROUPS_FILE not found: ${GROUPS_FILE} (cwd=${process.cwd()})`);
    process.exit(1);
  }
  const all = getAccounts();
  if (all.length === 0) {
    console.error('❌ No accounts in .env');
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
  const groups = loadGroups(GROUPS_FILE);
  if (groups.length === 0) {
    console.error('❌ No groups loaded');
    process.exit(1);
  }

  console.log(`📋 ${groups.length} groups, ${accounts.length} account(s) to check`);

  const results = [];
  for (const acc of accounts) {
    results.push(await checkAccount(acc, groups));
  }

  // Final summary table
  console.log('\n──── Final summary ────');
  for (const r of results) {
    if (r.skipped) {
      console.log(`  acc${r.acc.index}: SKIPPED (no profile dir)`);
      continue;
    }
    const counts = { member: 0, pending: 0, not_member: 0, unclear: 0, nav_failed: 0 };
    for (const v of r.perGroup.values()) counts[v.status] = (counts[v.status] || 0) + 1;
    console.log(
      `  acc${r.acc.index} (${r.acc.email}): member=${counts.member} pending=${counts.pending} ` +
      `not_member=${counts.not_member} unclear=${counts.unclear} nav_failed=${counts.nav_failed}`,
    );
    const missing = [...r.perGroup.entries()]
      .filter(([, v]) => v.status === 'not_member')
      .map(([id]) => id);
    if (missing.length) {
      console.log(`     missing (${missing.length}): ${missing.join(', ')}`);
    }
  }
}

main().catch((e) => {
  console.error(e);
  process.exit(1);
});
