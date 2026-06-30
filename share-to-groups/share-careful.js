// Careful single-account group sharer. Same composer flow as share-to-groups.js,
// but with patient success detection tuned for groups that require admin
// approval (where Post → "Posting" → pending takes longer than 4s) and it
// NEVER discards on timeout — so a slow-submitting post is not cancelled.
//
// Success = composer closes  OR  a "pending approval / your post" indicator
// appears  OR  the Post button text turns to "Posting".
//
// Usage (from project root):
//   POST_URL=<url> GROUPS_FILE=<file> node share-to-groups/share-careful.js <accountIndex>
//   POST_URL=https://www.facebook.com/share/v/1EuwZ1QxSE/ GROUPS_FILE=groups-19.txt node share-to-groups/share-careful.js 2

import 'dotenv/config';
import path from 'node:path';
import fs from 'node:fs';
import { chromium } from 'playwright';
import { getAccounts } from '../accounts.mjs';
import { performFacebookLogin, delay, randomDelay } from '../lib/facebook-login.mjs';
import { loadGroups } from '../groups.mjs';

const UA =
  'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/124.0.0.0 Safari/537.36';
const GROUPS_FILE = process.env.GROUPS_FILE || 'workinggroups.txt';
const PROFILES_DIR = path.resolve('./profiles');
const POST_URL = process.env.POST_URL;
const ACCOUNT_INDEX = Number(process.argv[2]) || 2;

const COMPOSER_TRIGGER_PATTERNS = [
  /write something/i, /create (a )?public post/i, /create post/i,
  /what'?s on your mind/i, /юу бодож байна/i, /пост бичих/i, /шинэ пост/i,
];
const POST_BUTTON_PATTERNS = [/^post$/i, /^нийтлэх$/i, /^илгээх$/i];
const POSTING_PATTERNS = [/^posting$/i, /^нийтэлж байна$/i, /^нийтэлж/i];
const PENDING_PATTERNS = [
  /pending approval/i, /will be visible/i, /once.*approved/i, /your post is pending/i,
  /review is still pending/i, /зөвшөөр/i, /хүлээгдэж буй/i, /хянаж байна/i,
];

async function isLoggedIn(page) {
  for (const sel of [
    '[role="navigation"][aria-label="Facebook"]', '[aria-label="Your profile"]',
    '[aria-label="Account"]', 'a[href="/me/"]',
  ]) {
    if ((await page.locator(sel).count().catch(() => 0)) > 0) return true;
  }
  return false;
}

async function findComposerTrigger(page) {
  for (const pattern of COMPOSER_TRIGGER_PATTERNS) {
    for (const role of ['button', 'textbox', 'link']) {
      try {
        const el = page.getByRole(role, { name: pattern }).first();
        if ((await el.count()) > 0 && (await el.isVisible().catch(() => false))) return el;
      } catch { /* next */ }
    }
  }
  for (const pattern of COMPOSER_TRIGGER_PATTERNS) {
    try {
      const el = page.getByText(pattern).first();
      if ((await el.count()) > 0 && (await el.isVisible().catch(() => false))) return el;
    } catch { /* next */ }
  }
  return null;
}

async function findComposerDialog(page) {
  const all = await page.locator('[role="dialog"]').all();
  for (const d of all) {
    if (!(await d.isVisible().catch(() => false))) continue;
    const hasEditor = await d.locator('[contenteditable="true"], [role="textbox"]').count().catch(() => 0);
    if (hasEditor > 0) return d;
  }
  let best = null, bestH = 0;
  for (const d of all) {
    if (!(await d.isVisible().catch(() => false))) continue;
    const box = await d.boundingBox().catch(() => null);
    if (!box || box.height < 200) continue;
    if (box.height > bestH) { best = d; bestH = box.height; }
  }
  return best;
}

async function findEditable(scope) {
  for (const sel of [
    'div[contenteditable="true"][role="textbox"]', 'div[role="textbox"][contenteditable="true"]',
    'div[contenteditable="true"]', '[contenteditable="true"]',
  ]) {
    try {
      const all = await scope.locator(sel).all();
      if (all.length > 0) return all[0];
    } catch { /* next */ }
  }
  return null;
}

async function activateEditor(dialog, page) {
  let editable = await findEditable(dialog);
  if (editable) {
    try { await editable.click({ force: true, timeout: 3_000 }); } catch { /* ignore */ }
    await delay(500);
    return editable;
  }
  const PATTERNS = [
    'create a public post', 'create post', 'write something',
    "what's on your mind", 'пост бичих', 'юу бодож',
  ];
  await dialog.evaluate((root, patterns) => {
    for (const el of root.querySelectorAll('*')) {
      const txt = (el.textContent || '').trim().toLowerCase();
      if (!txt || txt.length > 80) continue;
      if (!patterns.some((p) => txt === p || txt.startsWith(p))) continue;
      let target = el;
      for (let i = 0; i < 5 && target; i++) { try { target.click(); } catch {} target = target.parentElement; }
      return true;
    }
    return false;
  }, PATTERNS);
  for (let i = 0; i < 15; i++) {
    await delay(300);
    editable = await findEditable(dialog);
    if (editable) {
      try { await editable.click({ force: true, timeout: 3_000 }); } catch { /* ignore */ }
      await delay(300);
      return editable;
    }
  }
  return null;
}

async function clickPostButton(scope, page) {
  const scopes = scope ? [scope, page] : [page];
  for (const root of scopes) {
    for (const pattern of POST_BUTTON_PATTERNS) {
      try {
        const btn = root.getByRole('button', { name: pattern }).first();
        if ((await btn.count()) > 0 && (await btn.isVisible().catch(() => false))) {
          if ((await btn.getAttribute('aria-disabled').catch(() => null)) === 'true') continue;
          await btn.click({ timeout: 5_000 });
          return true;
        }
      } catch { /* next */ }
    }
  }
  return false;
}

async function anyTextVisible(page, patterns) {
  for (const p of patterns) {
    try {
      const el = page.getByText(p).first();
      if ((await el.count()) > 0 && (await el.isVisible().catch(() => false))) return true;
    } catch { /* next */ }
  }
  return false;
}

// Poll up to ~30s for a clear success signal. Never discards.
async function confirmPosted(page) {
  for (let i = 0; i < 15; i++) {
    await delay(2_000);
    const dialog = await findComposerDialog(page);
    if (!dialog) return 'closed';                       // composer gone = posted
    if (await anyTextVisible(dialog, PENDING_PATTERNS)) return 'pending';
    if (await anyTextVisible(page, PENDING_PATTERNS)) return 'pending';
    if (await anyTextVisible(dialog, POSTING_PATTERNS)) continue; // still submitting
  }
  return 'timeout';
}

async function shareToGroup(page, group) {
  console.log(`  ▶ ${group.id}`);
  await page.goto(group.url, { waitUntil: 'domcontentloaded', timeout: 45_000 });
  try { await page.waitForLoadState('networkidle', { timeout: 15_000 }); } catch {}
  await delay(2_500);

  const trigger = await findComposerTrigger(page);
  if (!trigger) {
    await page.screenshot({ path: `debug-nocomposer-acc${ACCOUNT_INDEX}-${group.id}.png` }).catch(() => {});
    return 'no_composer (not a member / private)';
  }
  await trigger.click({ timeout: 5_000 });
  await delay(1_500);

  const dialog = await findComposerDialog(page);
  if (!dialog) return 'no_dialog';

  const editable = await activateEditor(dialog, page);
  if (!editable) {
    await page.screenshot({ path: `debug-noeditable-acc${ACCOUNT_INDEX}-${group.id}.png` }).catch(() => {});
    return 'no_editable';
  }

  await editable.click({ timeout: 5_000 });
  await delay(400);
  await page.keyboard.type(POST_URL, { delay: 25 });
  console.log('    ⏳ waiting 7s for link preview…');
  await delay(7_000);

  let clicked = await clickPostButton(dialog, page);
  if (!clicked) { await delay(3_000); clicked = await clickPostButton(dialog, page); }
  if (!clicked) {
    await page.screenshot({ path: `debug-nopost-acc${ACCOUNT_INDEX}-${group.id}.png`, fullPage: true }).catch(() => {});
    return 'post_button_not_clickable';
  }

  const outcome = await confirmPosted(page);
  if (outcome === 'closed') return 'shared (composer closed)';
  if (outcome === 'pending') return 'shared (pending admin approval)';
  await page.screenshot({ path: `debug-timeout-acc${ACCOUNT_INDEX}-${group.id}.png`, fullPage: true }).catch(() => {});
  return 'submitted-but-unconfirmed (left composer open, NOT discarded — check screenshot)';
}

async function main() {
  if (!POST_URL) { console.error('❌ POST_URL env var required'); process.exit(1); }
  if (!fs.existsSync(GROUPS_FILE)) { console.error(`❌ GROUPS_FILE not found: ${GROUPS_FILE}`); process.exit(1); }
  const acc = getAccounts().find((a) => a.index === ACCOUNT_INDEX);
  if (!acc) { console.error(`❌ No account ${ACCOUNT_INDEX}`); process.exit(1); }
  const groups = loadGroups(GROUPS_FILE);
  if (!groups.length) { console.error(`❌ No groups in ${GROUPS_FILE}`); process.exit(1); }

  console.log(`🔗 Post: ${POST_URL}`);
  console.log(`📋 ${groups.length} group(s) from ${GROUPS_FILE}, account ${acc.index} (${acc.email})\n`);

  const userDataDir = path.join(PROFILES_DIR, `account-${acc.index}`);
  const context = await chromium.launchPersistentContext(userDataDir, {
    headless: false, slowMo: 40, viewport: { width: 1280, height: 800 }, userAgent: UA,
  });
  const page = context.pages()[0] || (await context.newPage());
  page.setDefaultNavigationTimeout(60_000);

  try {
    await page.goto('https://www.facebook.com/', { waitUntil: 'domcontentloaded' });
    await delay(2_000);
    if (!(await isLoggedIn(page))) {
      console.log('🔐 logging in…');
      await performFacebookLogin(page, { email: acc.email, password: acc.password, totpSecret: acc.totpSecret, index: acc.index });
    } else {
      console.log('✅ session valid');
    }

    for (let i = 0; i < groups.length; i++) {
      const result = await shareToGroup(page, groups[i]);
      console.log(`  → ${result}\n`);
      if (i < groups.length - 1) await randomDelay(15_000, 30_000);
    }
  } finally {
    await delay(3_000);
    try { await context.close(); } catch {}
  }
}

main().catch((e) => { console.error(e); process.exit(1); });
