// One-off: share a single reel into a single group on account 1.
// Reuses profiles/account-1 (no login required if cookies are still valid).
//
// Run from project root:
//   node share-reel-once.js
import 'dotenv/config';
import path from 'node:path';
import { chromium } from 'playwright';
import { getAccounts } from './accounts.mjs';
import { performFacebookLogin, delay } from './lib/facebook-login.mjs';

const GROUP_URL = 'https://www.facebook.com/share/g/1CxQA61VpC/';
const REEL_URL  = 'https://www.facebook.com/share/v/18w6fmxaYd/';
const ACCOUNT_INDEX = 2;

const UA =
  'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/124.0.0.0 Safari/537.36';
const PROFILES_DIR = path.resolve('./profiles');

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
  let best = null;
  let bestH = 0;
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
  const PATTERNS = [
    'create a public post', 'create post', 'write something',
    "what's on your mind", 'пост бичих', 'юу бодож',
  ];
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

async function main() {
  const acc = getAccounts().find((a) => a.index === ACCOUNT_INDEX);
  if (!acc) {
    console.error(`No account ${ACCOUNT_INDEX} in .env`);
    process.exit(1);
  }
  const userDataDir = path.join(PROFILES_DIR, `account-${acc.index}`);
  console.log(`Opening profiles/account-${acc.index} (${acc.email})…`);

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
      await performFacebookLogin(page, {
        email: acc.email,
        password: acc.password,
        totpSecret: acc.totpSecret,
        index: acc.index,
      });
    } else {
      console.log('Session valid');
    }

    console.log(`Navigating to ${GROUP_URL}`);
    await page.goto(GROUP_URL, { waitUntil: 'domcontentloaded', timeout: 45_000 });
    try { await page.waitForLoadState('networkidle', { timeout: 15_000 }); } catch { /* flaky */ }
    await delay(3_000);
    console.log(`Landed on: ${page.url()}`);

    const trigger = await findComposerTrigger(page);
    if (!trigger) {
      await page.screenshot({ path: 'debug-reel-no-composer.png', fullPage: true }).catch(() => {});
      throw new Error('No composer on group page — not a member, or private (saved debug-reel-no-composer.png)');
    }
    await trigger.click({ timeout: 5_000 });
    await delay(1_500);

    const dialog = await findComposerDialog(page);
    if (!dialog) throw new Error('Composer dialog did not open');

    const editable = await activateEditor(dialog, page);
    if (!editable) {
      await page.screenshot({ path: 'debug-reel-no-editable.png', fullPage: true }).catch(() => {});
      throw new Error('Could not activate editor (saved debug-reel-no-editable.png)');
    }

    await editable.click({ timeout: 5_000 });
    await delay(400);
    await page.keyboard.type(REEL_URL, { delay: 25 });
    console.log('Waiting 6s for FB to fetch reel preview…');
    await delay(6_000);

    let posted = await clickPostButton(dialog, page);
    if (!posted) {
      await delay(3_000);
      posted = await clickPostButton(dialog, page);
    }
    if (!posted) {
      await page.screenshot({ path: 'debug-reel-no-post-btn.png', fullPage: true }).catch(() => {});
      throw new Error('Post button not clickable (saved debug-reel-no-post-btn.png)');
    }

    await delay(5_000);
    const stillOpen = await findComposerDialog(page);
    if (stillOpen) {
      await page.screenshot({ path: 'debug-reel-stillopen.png', fullPage: true }).catch(() => {});
      console.log('Composer still open — post may have failed (saved debug-reel-stillopen.png)');
    } else {
      console.log('Reel shared to the group');
    }
  } finally {
    await delay(3_000);
    try { await context.close(); } catch { /* already closed */ }
  }
}

main().catch((e) => { console.error(e); process.exit(1); });
