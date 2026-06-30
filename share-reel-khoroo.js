// Post a reel/link URL to every group in a khoroo range using one account.
//
// Usage:
//   node share-reel-khoroo.js
//
// Config at the top of this file: REEL_URL, ACCOUNT_INDEX, KHOROO_MIN, KHOROO_MAX
import 'dotenv/config';
import path from 'node:path';
import fs from 'node:fs';
import { chromium } from 'playwright';
import { getAccounts } from './accounts.mjs';
import { performFacebookLogin, delay, randomDelay } from './lib/facebook-login.mjs';

const REEL_URL      = 'https://www.facebook.com/share/r/1E2EbHPmG6/';
const ACCOUNT_INDEX = 4;
const KHOROO_MIN    = null; // null = all groups
const KHOROO_MAX    = null;

// Only post to these specific group IDs (resume from where acc3 stopped)
const RESUME_IDS = ['suhbaatar1horoo', 'suhbaatarduureg', '460282835315281'];

const UA = 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/124.0.0.0 Safari/537.36';
const PROFILES_DIR   = path.resolve('./profiles');
const KHOROO_MAP     = JSON.parse(fs.readFileSync('./khoroo-map.json', 'utf8'));

// Filter groups — RESUME_IDS takes priority, then khoroo range, then all
const TARGET_GROUPS = typeof RESUME_IDS !== 'undefined' && RESUME_IDS.length > 0
  ? KHOROO_MAP.filter((g) => RESUME_IDS.includes(g.id))
  : KHOROO_MIN === null
    ? KHOROO_MAP
    : KHOROO_MAP.filter((g) => g.khoroo !== null && g.khoroo >= KHOROO_MIN && g.khoroo <= KHOROO_MAX);

const COMPOSER_TRIGGER_PATTERNS = [
  /write something/i,
  /create (a )?public post/i,
  /create post/i,
  /what'?s on your mind/i,
  /юу бодож байна/i,
  /пост бичих/i,
  /шинэ пост/i,
];

const POST_BUTTON_PATTERNS = [
  /^post$/i,
  /^posting$/i,
  /^нийтлэх$/i,
  /^илгээх$/i,
];

async function isLoggedIn(page) {
  for (const sel of [
    '[role="navigation"][aria-label="Facebook"]',
    '[aria-label="Your profile"]',
    '[aria-label="Account"]',
    'a[href="/me/"]',
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
    'div[contenteditable="true"][role="textbox"]',
    'div[role="textbox"][contenteditable="true"]',
    'div[contenteditable="true"]',
    '[contenteditable="true"]',
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
  const PATTERNS = ['create a public post', 'create post', 'write something', "what's on your mind", 'пост бичих', 'юу бодож'];
  await dialog.evaluate((root, patterns) => {
    const all = root.querySelectorAll('*');
    for (const el of all) {
      const txt = (el.textContent || '').trim().toLowerCase();
      if (!txt || txt.length > 80) continue;
      if (!patterns.some((p) => txt === p || txt.startsWith(p))) continue;
      let target = el;
      for (let i = 0; i < 5 && target; i++) {
        try { target.click(); } catch { /* next */ }
        target = target.parentElement;
      }
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
          const disabled = (await btn.getAttribute('aria-disabled').catch(() => null)) === 'true';
          if (disabled) continue;
          await btn.click({ timeout: 5_000 });
          return true;
        }
      } catch { /* next */ }
    }
  }
  return false;
}

async function dismissPopups(page) {
  const dismissLabels = ['Not Now', 'Not now', 'Close', 'Хаах', 'Үгүй'];
  for (const label of dismissLabels) {
    try {
      const btn = page.getByRole('button', { name: label }).first();
      if ((await btn.count()) > 0 && (await btn.isVisible().catch(() => false))) {
        await btn.click();
        await delay(500);
      }
    } catch { /* ignore */ }
  }
  // Also dismiss any alertdialog (push notification requests etc.)
  try {
    const alert = page.locator('[role="alertdialog"]').first();
    if ((await alert.count()) > 0 && (await alert.isVisible().catch(() => false))) {
      for (const label of dismissLabels) {
        try {
          const btn = alert.getByRole('button', { name: label }).first();
          if ((await btn.count()) > 0) { await btn.click(); await delay(500); break; }
        } catch { /* next */ }
      }
    }
  } catch { /* ignore */ }
}

async function postToGroup(page, group) {
  console.log(`\n  ▶ [${group.khoroo}-р хороо] ${group.name}`);
  console.log(`    ${group.url}`);

  await page.goto(group.url, { waitUntil: 'domcontentloaded', timeout: 45_000 });
  try { await page.waitForLoadState('networkidle', { timeout: 15_000 }); } catch { /* flaky */ }
  await delay(3_000);

  await dismissPopups(page);
  await delay(500);

  const trigger = await findComposerTrigger(page);
  if (!trigger) {
    await page.screenshot({ path: `debug-nocomposer-${group.id}.png`, fullPage: true }).catch(() => {});
    console.log(`    ⚠️  No composer found — not a member or private group (screenshot saved)`);
    return 'no_composer';
  }

  await trigger.click({ timeout: 5_000 });
  await delay(1_500);

  const dialog = await findComposerDialog(page);
  if (!dialog) {
    console.log(`    ⚠️  Composer dialog did not open`);
    return 'no_dialog';
  }

  const editable = await activateEditor(dialog, page);
  if (!editable) {
    await page.screenshot({ path: `debug-noeditable-${group.id}.png`, fullPage: true }).catch(() => {});
    console.log(`    ⚠️  Could not activate editor (screenshot saved)`);
    return 'no_editor';
  }

  await editable.click({ timeout: 5_000 });
  await delay(400);
  await page.keyboard.type(REEL_URL, { delay: 25 });
  console.log(`    ⏳ Waiting for reel preview…`);
  await delay(6_000);

  let posted = await clickPostButton(dialog, page);
  if (!posted) {
    await delay(3_000);
    posted = await clickPostButton(dialog, page);
  }
  if (!posted) {
    await page.screenshot({ path: `debug-nopostbtn-${group.id}.png`, fullPage: true }).catch(() => {});
    console.log(`    ⚠️  Post button not found (screenshot saved)`);
    return 'no_post_btn';
  }

  await delay(5_000);
  const stillOpen = await findComposerDialog(page);
  if (stillOpen) {
    await page.screenshot({ path: `debug-stillopen-${group.id}.png`, fullPage: true }).catch(() => {});
    console.log(`    ⚠️  Composer still open — post may have failed (screenshot saved)`);
    return 'unclear';
  }

  console.log(`    ✅ Posted successfully`);
  return 'posted';
}

async function main() {
  const acc = getAccounts().find((a) => a.index === ACCOUNT_INDEX);
  if (!acc) { console.error(`No account ${ACCOUNT_INDEX} in .env`); process.exit(1); }

  console.log(`\n🗺️  Target: ${KHOROO_MIN === null ? 'all groups' : `кhoroo ${KHOROO_MIN}–${KHOROO_MAX}`}  (${TARGET_GROUPS.length} groups)`);
  TARGET_GROUPS.forEach((g) => console.log(`   ${g.khoroo}-р хороо: ${g.name}`));
  console.log(`\n👤 Account ${acc.index}: ${acc.email}`);
  console.log(`🔗 Reel: ${REEL_URL}\n`);

  const userDataDir = path.join(PROFILES_DIR, `account-${acc.index}`);
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
    if (!(await isLoggedIn(page))) {
      console.log('Session not valid — logging in…');
      await performFacebookLogin(page, { email: acc.email, password: acc.password, totpSecret: acc.totpSecret, index: acc.index });
    } else {
      console.log('✅ Session valid — skipping login');
    }

    const results = { posted: 0, no_composer: 0, no_dialog: 0, no_editor: 0, no_post_btn: 0, unclear: 0, error: 0 };

    for (let i = 0; i < TARGET_GROUPS.length; i++) {
      const group = TARGET_GROUPS[i];
      try {
        const r = await postToGroup(page, group);
        results[r] = (results[r] || 0) + 1;
      } catch (err) {
        console.error(`    ❌ Error: ${err?.message || err}`);
        results.error++;
      }
      if (i < TARGET_GROUPS.length - 1) {
        const wait = Math.floor(Math.random() * 10_000) + 10_000;
        console.log(`    ⏱  Waiting ${Math.round(wait / 1000)}s before next group…`);
        await delay(wait);
      }
    }

    console.log('\n──── Summary ────');
    console.log(`  ✅ Posted:      ${results.posted}`);
    console.log(`  ⚠️  No composer: ${results.no_composer}`);
    console.log(`  ⚠️  No dialog:   ${results.no_dialog}`);
    console.log(`  ⚠️  No editor:   ${results.no_editor}`);
    console.log(`  ⚠️  No post btn: ${results.no_post_btn}`);
    console.log(`  ❓ Unclear:     ${results.unclear}`);
    console.log(`  ❌ Error:       ${results.error}`);
    console.log('\n🎉 Done!');
  } finally {
    await delay(3_000);
    try { await context.close(); } catch { /* already closed */ }
  }
}

main().catch((e) => { console.error(e); process.exit(1); });
