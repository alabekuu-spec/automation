// Shares POST_URL into every Facebook group listed in "Suhbaatar group.xlsx"
// for every account defined in .env (FB_EMAIL_N / FB_PASSWORD_N).
//
// Approach: navigate to each /groups/<id>/, open the group's "Write something…"
// composer, paste the post URL, wait for Facebook to attach the link preview,
// and click Post. This is more reliable than driving the post's share-dialog
// menu, because the group composer + URL preview is a long-standing FB flow.
//
// Sessions are reused from ../profiles/account-N via launchPersistentContext,
// so accounts that already logged in via join-groups.js / login-all.js skip
// the login step.
//
// Usage (from project root):
//   node share-to-groups/share-to-groups.js          # all accounts
//   node share-to-groups/share-to-groups.js 1 3 5    # only accounts 1, 3, 5
//   GROUPS_FILE=other.xlsx node share-to-groups/share-to-groups.js

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

const POST_BUTTON_PATTERNS = [
  /^post$/i,
  /^posting$/i,
  /^нийтлэх$/i,
  /^илгээх$/i,
  /^kirim$/i,
  /^bagikan$/i,
];

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

async function ensureLoggedIn(page, acc) {
  await page.goto('https://www.facebook.com/', { waitUntil: 'domcontentloaded' });
  await delay(2_000);
  if (await isLoggedIn(page)) {
    console.log(`✅ Account ${acc.index} — session already valid, skipping login`);
    return;
  }
  console.log(`🔐 Account ${acc.index} — session expired or first run, logging in…`);
  await performFacebookLogin(page, {
    email: acc.email,
    password: acc.password,
    totpSecret: acc.totpSecret,
    index: acc.index,
  });
}

async function pageShowsRateLimit(page) {
  const patterns = [
    /you'?re temporarily blocked/i,
    /try again later/i,
    /we limit how often/i,
    /this feature is temporarily unavailable/i,
    /you can'?t use this feature/i,
    /we suspect automated behavior/i,
    /suspicious activity/i,
    /түр зуур.*хориглосон/i,
    /дараа дахин оролдо/i,
    /автоматжуулсан үйлдэл/i,
  ];
  for (const p of patterns) {
    try {
      const loc = page.getByText(p).first();
      if ((await loc.count()) > 0 && (await loc.isVisible().catch(() => false))) return true;
    } catch { /* next */ }
  }
  return false;
}

async function dismissCookieBanner(page) {
  for (const pattern of [/allow all cookies/i, /accept all/i, /зөвшөөрөх/i, /izinkan semua/i]) {
    try {
      const btn = page.getByRole('button', { name: pattern }).first();
      if ((await btn.count()) > 0 && (await btn.isVisible().catch(() => false))) {
        await btn.click();
        await delay(500);
        return;
      }
    } catch { /* next */ }
  }
}

async function findComposerTrigger(page) {
  // Pattern A: textbox-ish role with the prompt text
  for (const pattern of COMPOSER_TRIGGER_PATTERNS) {
    for (const role of ['button', 'textbox', 'link']) {
      try {
        const el = page.getByRole(role, { name: pattern }).first();
        if ((await el.count()) > 0 && (await el.isVisible().catch(() => false))) return el;
      } catch { /* next */ }
    }
  }
  // Pattern B: plain visible text (FB sometimes renders a non-semantic div)
  for (const pattern of COMPOSER_TRIGGER_PATTERNS) {
    try {
      const el = page.getByText(pattern).first();
      if ((await el.count()) > 0 && (await el.isVisible().catch(() => false))) return el;
    } catch { /* next */ }
  }
  return null;
}

async function findComposerDialog(page) {
  // FB opens TWO role="dialog" elements: a small header strip (500x60,
  // aria="Create post") and the real composer body (~500x500) with the
  // editor. We must pick the body, not the header. Strategy: prefer any
  // visible dialog that contains a contenteditable / role=textbox child.
  // Fall back to the tallest visible composer-ish dialog.
  const all = await page.locator('[role="dialog"]').all();
  for (const d of all) {
    if (!(await d.isVisible().catch(() => false))) continue;
    const hasEditor = await d.locator('[contenteditable="true"], [role="textbox"]').count().catch(() => 0);
    if (hasEditor > 0) return d;
  }
  let best = null;
  let bestHeight = 0;
  for (const d of all) {
    if (!(await d.isVisible().catch(() => false))) continue;
    const box = await d.boundingBox().catch(() => null);
    if (!box || box.height < 200) continue;
    const txt = ((await d.textContent().catch(() => '')) || '').toLowerCase();
    if (!/create post|write something|what'?s on your mind|new post|пост|tulis|buat postingan/.test(txt)) continue;
    if (box.height > bestHeight) { best = d; bestHeight = box.height; }
  }
  return best;
}

// Returns any contenteditable inside the dialog. We deliberately do NOT
// require isVisible() — FB sometimes mounts the editor as a 0-height div
// before first focus.
async function findEditableInComposer(scope) {
  for (const sel of [
    'div[contenteditable="true"][role="textbox"]',
    'div[role="textbox"][contenteditable="true"]',
    'div[contenteditable="true"][aria-label*="create" i]',
    'div[contenteditable="true"][aria-label*="post" i]',
    'div[contenteditable="true"][aria-label*="бичих" i]',
    'div[contenteditable="true"][aria-placeholder]',
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

// FB renders a clickable placeholder ("Create a public post…" / "Write
// something…") inside the dialog; the real contenteditable doesn't mount
// (or doesn't grow past 0px) until the placeholder is clicked. We walk the
// DOM to find any element whose text matches a known placeholder, then
// click it AND a few ancestors to make sure the click handler fires.
async function activateEditor(dialog, page) {
  // 1) Maybe the editor is already there (even if 0-height).
  let editable = await findEditableInComposer(dialog);
  if (editable) {
    try { await editable.click({ force: true, timeout: 3_000 }); } catch { /* ignore */ }
    await delay(500);
    return editable;
  }

  // 2) DOM walk: find any short text node matching a placeholder, then
  //    .click() on it and its first 4 ancestors. FB attaches the handler
  //    on a wrapper div, not on the text span itself.
  const PATTERNS = [
    'create a public post',
    'create post',
    'write something',
    "what's on your mind",
    'say something about this',
    'пост бичих',
    'юу бодож',
    'tulis sesuatu',
    'buat postingan',
  ];
  const clicked = await dialog.evaluate((root, patterns) => {
    const all = root.querySelectorAll('*');
    for (const el of all) {
      const txt = (el.textContent || '').trim().toLowerCase();
      if (!txt || txt.length > 80) continue;
      const hit = patterns.some((p) => txt === p || txt.startsWith(p));
      if (!hit) continue;
      let target = el;
      for (let i = 0; i < 5; i++) {
        if (!target) break;
        try { target.click(); } catch { /* next */ }
        target = target.parentElement;
      }
      return true;
    }
    return false;
  }, PATTERNS);

  if (clicked) {
    for (let i = 0; i < 15; i++) {
      await delay(300);
      editable = await findEditableInComposer(dialog);
      if (editable) {
        try { await editable.click({ force: true, timeout: 3_000 }); } catch { /* ignore */ }
        await delay(300);
        return editable;
      }
    }
  }

  // 3) Last resort: physical mouse click in the upper-middle of the dialog
  //    (where the editor area lives — between header and "Add to your post").
  try {
    const box = await dialog.boundingBox();
    if (box) {
      await page.mouse.click(box.x + box.width / 2, box.y + box.height * 0.4);
      await delay(800);
      editable = await findEditableInComposer(dialog);
      if (editable) return editable;
    }
  } catch { /* ignore */ }

  // Diagnostic: dump every dialog on the page AND any page-wide editables.
  try {
    const diag = await page.evaluate(() => {
      const summarize = (el) => ({
        tag: el.tagName,
        role: el.getAttribute('role'),
        aria: el.getAttribute('aria-label'),
        placeholder: el.getAttribute('aria-placeholder') || el.getAttribute('placeholder'),
        text: (el.textContent || '').trim().replace(/\s+/g, ' ').slice(0, 80),
        ce: el.getAttribute('contenteditable'),
        rect: (() => { const r = el.getBoundingClientRect(); return { w: Math.round(r.width), h: Math.round(r.height) }; })(),
      });
      const dialogs = Array.from(document.querySelectorAll('[role="dialog"]')).map((d, idx) => {
        const editables = d.querySelectorAll('[contenteditable="true"]');
        const textboxes = d.querySelectorAll('[role="textbox"]');
        const buttons = d.querySelectorAll('[role="button"], button');
        const r = d.getBoundingClientRect();
        return {
          idx,
          aria: d.getAttribute('aria-label'),
          rect: { w: Math.round(r.width), h: Math.round(r.height) },
          editables: editables.length,
          textboxes: textboxes.length,
          buttons: buttons.length,
          text: (d.textContent || '').trim().replace(/\s+/g, ' ').slice(0, 120),
        };
      });
      const pageEditables = Array.from(document.querySelectorAll('[contenteditable="true"]')).map(summarize);
      const pageTextboxes = Array.from(document.querySelectorAll('[role="textbox"]')).map(summarize);
      return { dialogs, pageEditables, pageTextboxes };
    });
    console.log(`  🔬 PAGE diag: dialogs=${diag.dialogs.length} editables=${diag.pageEditables.length} textboxes=${diag.pageTextboxes.length}`);
    diag.dialogs.forEach((d) => console.log(`     dlg[${d.idx}] ${d.rect.w}x${d.rect.h} aria=${JSON.stringify(d.aria)} editables=${d.editables} textboxes=${d.textboxes} buttons=${d.buttons} text=${JSON.stringify(d.text)}`));
    if (diag.pageEditables.length) console.log(`     pageEditables: ${JSON.stringify(diag.pageEditables)}`);
    if (diag.pageTextboxes.length) console.log(`     pageTextboxes: ${JSON.stringify(diag.pageTextboxes)}`);
  } catch (e) {
    console.log(`  🔬 diag failed: ${e?.message || e}`);
  }

  return null;
}

async function clickPostButton(scope, page) {
  // Try inside dialog first, then page-wide
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
    // Aria-label fallback
    for (const sel of [
      '[aria-label="Post"]',
      '[aria-label="Posting"]',
      '[aria-label="Нийтлэх"]',
      '[aria-label*="Post to" i]',
      '[aria-label*="Bagikan sekarang" i]',
    ]) {
      try {
        const btn = root.locator(sel).first();
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

async function isMemberOfGroup(page) {
  // If a composer trigger is visible on the group's main page, we're a member
  // (or the group allows posting by non-members — rare). Either way, we can post.
  return (await findComposerTrigger(page)) !== null;
}

async function shareToGroup(page, group, acc) {
  console.log(`  ▶ [acc${acc.index}] ${group.id} — ${group.label}`);
  try {
    await page.goto(group.url, { waitUntil: 'domcontentloaded', timeout: 45_000 });
  } catch (e) {
    console.log(`  ⚠ [acc${acc.index}] nav failed: ${e.message?.slice(0, 120)}`);
    return 'nav_failed';
  }
  try { await page.waitForLoadState('networkidle', { timeout: 15_000 }); } catch { /* flaky */ }
  await delay(2_500);

  if (await pageShowsRateLimit(page)) {
    const shot = `debug-ratelimit-acc${acc.index}-${group.id}.png`;
    await page.screenshot({ path: shot, fullPage: false }).catch(() => {});
    console.log(`  🚫 [acc${acc.index}] rate-limit page (saved ${shot})`);
    return 'rate_limited';
  }

  await dismissCookieBanner(page);

  if (!(await isMemberOfGroup(page))) {
    const shot = `debug-notmember-acc${acc.index}-${group.id}.png`;
    await page.screenshot({ path: shot, fullPage: false }).catch(() => {});
    console.log(`  ⏭  [acc${acc.index}] composer not visible — not a member or private (saved ${shot})`);
    return 'not_member';
  }

  // Open composer
  const trigger = await findComposerTrigger(page);
  if (!trigger) return 'no_composer';
  try {
    await trigger.click({ timeout: 5_000 });
  } catch (e) {
    console.log(`  ⚠ [acc${acc.index}] composer click failed: ${e.message?.slice(0, 120)}`);
    return 'composer_click_failed';
  }
  await delay(1_500);

  const dialog = await findComposerDialog(page);
  if (!dialog) {
    const shot = `debug-nodialog-acc${acc.index}-${group.id}.png`;
    await page.screenshot({ path: shot, fullPage: false }).catch(() => {});
    console.log(`  ⚠ [acc${acc.index}] composer dialog did not open (saved ${shot})`);
    return 'no_dialog';
  }

  const editable = await activateEditor(dialog, page);
  if (!editable) {
    const shot = `debug-noeditable-acc${acc.index}-${group.id}.png`;
    await page.screenshot({ path: shot, fullPage: false }).catch(() => {});
    console.log(`  ⚠ [acc${acc.index}] could not activate editor (saved ${shot})`);
    return 'no_editable';
  }

  try {
    await editable.click({ timeout: 5_000 });
    await delay(400);
    await page.keyboard.type(POST_URL, { delay: 25 });
  } catch (e) {
    console.log(`  ⚠ [acc${acc.index}] could not type URL: ${e.message?.slice(0, 120)}`);
    return 'type_failed';
  }

  // Wait for FB to fetch and attach the link preview. The Post button stays
  // disabled until the URL is recognized; ~6s is typically enough.
  await delay(6_000);

  const posted = await clickPostButton(dialog, page);
  if (!posted) {
    // Some flows need a second attempt after the preview finishes loading
    await delay(3_000);
    const retry = await clickPostButton(dialog, page);
    if (!retry) {
      const shot = `debug-nopost-acc${acc.index}-${group.id}.png`;
      await page.screenshot({ path: shot, fullPage: true }).catch(() => {});
      console.log(`  ⚠ [acc${acc.index}] Post button not clickable (saved ${shot})`);
      return 'post_click_failed';
    }
  }

  // Wait for the composer to close as success signal
  await delay(4_000);
  const stillOpen = await findComposerDialog(page);
  if (stillOpen) {
    // Check if FB is showing its post-rate-limit warning inside the composer.
    // The warning reads "We limit how often you can post, comment or do other
    // things… You can try again later." When it appears, this account is done
    // for this session — close and move on.
    if (await detectPostLimitInComposer(stillOpen)) {
      const shot = `debug-postlimit-acc${acc.index}-${group.id}.png`;
      await page.screenshot({ path: shot, fullPage: false }).catch(() => {});
      console.log(`  🚫 [acc${acc.index}] FB post-limit reached — closing composer and moving to next account (saved ${shot})`);
      await closeComposerWithDiscard(page);
      return 'rate_limited';
    }

    const shot = `debug-stillopen-acc${acc.index}-${group.id}.png`;
    await page.screenshot({ path: shot, fullPage: false }).catch(() => {});
    console.log(`  ⚠ [acc${acc.index}] composer still open after Post click — likely failed (saved ${shot})`);
    await closeComposerWithDiscard(page);
    return 'unclear';
  }

  console.log(`  ✅ [acc${acc.index}] shared to ${group.label}`);
  return 'shared';
}

async function detectPostLimitInComposer(dialog) {
  const patterns = [
    /we limit how often/i,
    /limit how often you can post/i,
    /you can try again later/i,
    /try again later/i,
    /community standards/i,
    /хязгаар.*пост|хязгаарл/i,
    /дараа дахин оролд/i,
  ];
  for (const pattern of patterns) {
    try {
      const el = dialog.getByText(pattern).first();
      if ((await el.count()) > 0 && (await el.isVisible().catch(() => false))) return true;
    } catch { /* next */ }
  }
  return false;
}

async function closeComposerWithDiscard(page) {
  try { await page.keyboard.press('Escape'); } catch { /* ignore */ }
  await delay(500);
  // FB may show a "Discard post?" confirmation
  for (const pattern of [/^discard$/i, /^discard post$/i, /^устгах$/i, /^buang$/i]) {
    try {
      const btn = page.getByRole('button', { name: pattern }).first();
      if ((await btn.count()) > 0 && (await btn.isVisible().catch(() => false))) {
        await btn.click({ timeout: 3_000 });
        await delay(400);
        break;
      }
    } catch { /* next */ }
  }
}

async function runAccount(acc, groups) {
  const userDataDir = path.join(PROFILES_DIR, `account-${acc.index}`);
  fs.mkdirSync(userDataDir, { recursive: true });

  console.log(`\n▶ Starting account ${acc.index}: ${acc.email}`);
  const context = await chromium.launchPersistentContext(userDataDir, {
    headless: false,
    slowMo: 40,
    viewport: { width: 1280, height: 800 },
    userAgent: UA,
  });
  const page = context.pages()[0] || (await context.newPage());
  page.setDefaultNavigationTimeout(60_000);

  const summary = {
    shared: 0, not_member: 0, no_composer: 0, composer_click_failed: 0,
    no_dialog: 0, no_editable: 0, type_failed: 0, post_click_failed: 0,
    unclear: 0, nav_failed: 0, rate_limited: 0,
  };
  let fatal = null;
  context.on('close', () => { fatal = fatal || 'context_closed'; });

  try {
    try {
      await ensureLoggedIn(page, acc);
    } catch (err) {
      console.error(`❌ Account ${acc.index} login failed:`, err?.message || err);
      await page.screenshot({ path: `screenshot-login-account${acc.index}.png`, fullPage: true }).catch(() => {});
      return { acc, summary, fatal: 'login_failed' };
    }

    let consecutiveNavFail = 0;
    for (const group of groups) {
      if (fatal) {
        console.log(`✋ Account ${acc.index} aborting remaining groups — ${fatal}`);
        break;
      }
      const result = await shareToGroup(page, group, acc);
      summary[result] = (summary[result] || 0) + 1;

      if (result === 'rate_limited') {
        fatal = 'rate_limited';
        console.log(`✋ Account ${acc.index} — rate-limit, switching to next account`);
        break;
      }
      if (result === 'nav_failed') {
        consecutiveNavFail += 1;
        if (consecutiveNavFail >= 2) {
          fatal = 'context_closed';
          console.log(`✋ Account ${acc.index} — 2 consecutive nav failures; stopping`);
          break;
        }
      } else {
        consecutiveNavFail = 0;
      }

      // Human-paced delay between group shares to dodge anti-spam
      await randomDelay(15_000, 30_000);
    }

    console.log(
      `✔ Account ${acc.index} done — shared:${summary.shared} not-member:${summary.not_member} ` +
      `unclear:${summary.unclear} rate-limited:${summary.rate_limited} ` +
      `no-composer:${summary.no_composer} no-dialog:${summary.no_dialog} ` +
      `no-editable:${summary.no_editable} post-fail:${summary.post_click_failed} ` +
      `nav-fail:${summary.nav_failed}` +
      (fatal ? `  [stopped early: ${fatal}]` : ''),
    );
    return { acc, summary, fatal };
  } finally {
    try { await context.close(); } catch { /* already closed */ }
  }
}

function validate() {
  const errors = [];
  if (!POST_URL || POST_URL.startsWith('your_') || POST_URL.includes('XXXXX')) {
    errors.push('POST_URL is missing or still a placeholder in .env');
  }
  if (!fs.existsSync(GROUPS_FILE)) {
    errors.push(`GROUPS_FILE not found: ${GROUPS_FILE} (cwd=${process.cwd()})`);
  }
  if (errors.length) {
    errors.forEach((e) => console.error(`❌ ${e}`));
    process.exit(1);
  }
}

async function main() {
  validate();
  const allAccounts = getAccounts();
  if (allAccounts.length === 0) {
    console.error('❌ No accounts in .env (FB_EMAIL_N + FB_PASSWORD_N).');
    process.exit(1);
  }

  const requested = process.argv.slice(2).map(Number).filter(Boolean);
  const accounts = requested.length > 0
    ? allAccounts.filter((a) => requested.includes(a.index))
    : allAccounts;
  if (accounts.length === 0) {
    console.error('❌ No matching accounts for the given indices.');
    process.exit(1);
  }

  const groups = loadGroups(GROUPS_FILE);
  if (groups.length === 0) {
    console.error(`❌ No groups found in ${GROUPS_FILE}`);
    process.exit(1);
  }

  console.log(`📋 Loaded ${groups.length} group(s) from ${GROUPS_FILE}`);
  console.log(`🔗 Post: ${POST_URL}`);
  console.log(`👥 Running ${accounts.length} account(s) sequentially — one browser at a time`);
  console.log(`💾 Sessions persist in ${PROFILES_DIR}/account-N — re-runs skip login when cookies are valid\n`);

  const results = [];
  for (const acc of accounts) {
    const r = await runAccount(acc, groups);
    results.push(r);
    await delay(2_000);
  }

  console.log('\n──── Final summary ────');
  for (const r of results) {
    const s = r.summary;
    console.log(
      `  acc${r.acc.index} (${r.acc.email}): ` +
      `shared=${s.shared} not-member=${s.not_member} unclear=${s.unclear} ` +
      `rate-limited=${s.rate_limited} no-composer=${s.no_composer} ` +
      `no-dialog=${s.no_dialog} no-editable=${s.no_editable} ` +
      `post-fail=${s.post_click_failed} nav-fail=${s.nav_failed}` +
      (r.fatal ? `  [fatal: ${r.fatal}]` : ''),
    );
  }
  console.log('\nAll accounts processed. Exiting.');
}

main().catch((e) => {
  console.error(e);
  process.exit(1);
});
