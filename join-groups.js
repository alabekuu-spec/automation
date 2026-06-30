// Joins every Facebook group listed in "Suhbaatar group.xlsx" for every
// account defined in .env (FB_EMAIL_N / FB_PASSWORD_N / FB_TOTP_SECRET_N).
//
// Each group is opened by typing its name into Facebook's top search bar
// (more human-like than navigating directly to /groups/<id> URLs, which
// Facebook flags), picking the matching result, and clicking Join.
//
// Sessions are stored in ./profiles/account-N using launchPersistentContext,
// so the first run logs in and every subsequent run reuses the cookies.
// All accounts use captcha (no TOTP) — solve in the browser when prompted.
//
// Usage:
//   node join-groups.js                # all accounts
//   node join-groups.js 1 3 5          # only accounts 1, 3 and 5
//   GROUPS_FILE=other.xlsx node join-groups.js
import 'dotenv/config';
import path from 'node:path';
import fs from 'node:fs';
import { chromium } from 'playwright';
import { getAccounts } from './accounts.mjs';
import { performFacebookLogin, delay, randomDelay } from './lib/facebook-login.mjs';
import { loadGroups } from './groups.mjs';

const UA =
  'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/124.0.0.0 Safari/537.36';

const GROUPS_FILE = process.env.GROUPS_FILE || 'workinggroups.txt';
const PROFILES_DIR = path.resolve('./profiles');

const JOIN_BUTTON_PATTERNS = [
  /^\s*join group\s*$/i,
  /^\s*\+?\s*join\s*$/i,
  /группэд\s+нэгдэх/i,
  /^\s*нэгдэх\s*$/i,
  /^\s*gabung(?:\s+ke\s+grup)?\s*$/i,
  // Looser fallbacks — handle "+ Join group", "Join group ▼", etc.
  /\bjoin\s+group\b/i,
];

const ALREADY_JOINED_PATTERNS = [
  /^joined$/i,
  /^нэгдсэн$/i,
  /^member$/i,
  /^cancel request$/i,
  /^хүсэлт цуцлах$/i,
  /^request sent$/i,
  /^хүсэлт илгээсэн$/i,
];

async function findSearchInput(page) {
  for (const sel of [
    'input[aria-label="Search Facebook"]',
    'input[aria-label*="search facebook" i]',
    'input[aria-label*="хайх" i]',
    'input[placeholder*="search" i]',
    'input[type="search"]',
  ]) {
    try {
      const loc = page.locator(sel).first();
      if ((await loc.count()) > 0 && (await loc.isVisible().catch(() => false))) {
        return loc;
      }
    } catch { /* try next */ }
  }
  return null;
}

async function findGroupLink(page, group) {
  // Match any anchor whose href routes to /groups/<id>. Facebook appends
  // varying query strings (?ref=…) so we test a few patterns.
  for (const sel of [
    `a[href*="/groups/${group.id}/"]`,
    `a[href*="/groups/${group.id}?"]`,
    `a[href$="/groups/${group.id}"]`,
  ]) {
    try {
      const all = await page.locator(sel).all();
      for (const loc of all) {
        if (await loc.isVisible().catch(() => false)) return loc;
      }
    } catch { /* try next */ }
  }
  return null;
}

// Walks up from the group's anchor in the search results to find its row, then
// returns the action button (Join / Joined / Cancel request) within that row.
// Tags it with a unique data attribute we click via Playwright's locator.
//
// Key correctness rule: we expand the ancestor only while it contains ZERO
// other group anchors — the moment it would include another result row, we
// stop. That keeps us from accidentally grabbing a sibling row's Join button
// or a "Groups" navigation control in the top bar.
async function tagRowActionButton(page, group) {
  return await page.evaluate((groupId) => {
    const joinRegexes = [
      /^\s*join group\s*$/i,
      /^\s*\+?\s*join\s*$/i,
      /группэд\s+нэгдэх/i,
      /^\s*нэгдэх\s*$/i,
      /^\s*gabung(?:\s+ke\s+grup)?\s*$/i,
      /\bjoin\s+group\b/i,
    ];
    const memberRegexes = [
      /^joined$/i,
      /^нэгдсэн$/i,
      /^member$/i,
      /^cancel request$/i,
      /^хүсэлт цуцлах$/i,
      /^request sent$/i,
      /^хүсэлт илгээсэн$/i,
      /^visit group$/i,
      /^visit$/i,
      /^үзэх$/i,
    ];
    const targetSelectors = [
      `a[href*="/groups/${groupId}/"]`,
      `a[href*="/groups/${groupId}?"]`,
      `a[href$="/groups/${groupId}"]`,
    ];
    const allTargetAnchors = Array.from(document.querySelectorAll(targetSelectors.join(', ')));
    if (allTargetAnchors.length === 0) return null;

    function matchButtonsIn(scope) {
      // Buttons whose visible text or aria-label matches a join/member regex.
      const btns = Array.from(scope.querySelectorAll('div[role="button"], button, a[role="button"]'));
      for (const btn of btns) {
        const text = (btn.textContent || '').trim();
        const aria = btn.getAttribute('aria-label') || '';
        const combined = `${text} ${aria}`;
        if (joinRegexes.some((r) => r.test(combined))) return { btn, state: 'join', text };
        if (memberRegexes.some((r) => r.test(combined))) return { btn, state: 'member', text };
      }
      return null;
    }

    function isOurGroupAnchor(a) {
      const href = a.getAttribute('href') || '';
      return href.includes(`/groups/${groupId}/`)
        || href.includes(`/groups/${groupId}?`)
        || href.endsWith(`/groups/${groupId}`);
    }

    function containsForeignGroupAnchor(scope) {
      // True if `scope` contains any /groups/ anchor that does NOT point at our group.
      const others = Array.from(scope.querySelectorAll('a[href*="/groups/"]'));
      return others.some((a) => !isOurGroupAnchor(a));
    }

    for (const a of allTargetAnchors) {
      let cur = a;
      let lastSafe = a.parentElement || a;
      for (let depth = 0; depth < 10 && cur && cur !== document.body; depth++) {
        cur = cur.parentElement;
        if (!cur) break;
        if (containsForeignGroupAnchor(cur)) break;
        lastSafe = cur;
      }
      const hit = matchButtonsIn(lastSafe);
      if (hit) {
        const marker = `gj-${Date.now()}-${Math.random().toString(36).slice(2, 8)}`;
        hit.btn.setAttribute('data-gj-target', marker);
        return { state: hit.state, marker, text: hit.text.slice(0, 80) };
      }
    }
    return null;
  }, group.id);
}

async function clickGroupsFilter(page) {
  // IMPORTANT: target the search-filter link specifically (href contains
  // "/search/groups/"), NOT the global "Groups" nav button in the top bar
  // (which would navigate away to /groups/feed and lose our search context).
  for (const sel of [
    'a[href^="/search/groups/"]',
    'a[href*="/search/groups/?"]',
  ]) {
    try {
      const all = await page.locator(sel).all();
      for (const loc of all) {
        if (await loc.isVisible().catch(() => false)) {
          await loc.click();
          await delay(2_000);
          return true;
        }
      }
    } catch { /* try next */ }
  }
  return false;
}

async function ensureGroupsFilterByUrl(page, query) {
  // Fallback: if we couldn't click the filter (or it landed somewhere else),
  // navigate directly to the groups-scoped search results URL.
  if (/\/search\/groups\//.test(page.url())) return true;
  try {
    await page.goto(
      `https://www.facebook.com/search/groups/?q=${encodeURIComponent(query)}`,
      { waitUntil: 'domcontentloaded', timeout: 30_000 },
    );
    await delay(2_500);
    return /\/search\/groups\//.test(page.url());
  } catch {
    return false;
  }
}

async function goToGroupSearchResults(page, group, acc) {
  try {
    await page.goto('https://www.facebook.com/', { waitUntil: 'domcontentloaded', timeout: 45_000 });
  } catch (e) {
    console.log(`  ⚠ [acc${acc.index}] home navigation failed: ${e.message?.slice(0, 120)}`);
    return 'nav_failed';
  }
  await delay(1_500);

  let searchInput = await findSearchInput(page);
  if (!searchInput) {
    // Some layouts hide the input behind a magnifier icon — click to expand.
    try {
      const icon = page
        .locator('[aria-label="Search Facebook"], [aria-label="Search"], [aria-label*="хайх" i]')
        .first();
      if ((await icon.count()) > 0 && (await icon.isVisible().catch(() => false))) {
        await icon.click();
        await delay(800);
        searchInput = await findSearchInput(page);
      }
    } catch { /* fall through */ }
  }

  if (!searchInput) {
    const shot = `debug-no-search-acc${acc.index}.png`;
    await page.screenshot({ path: shot, fullPage: false }).catch(() => {});
    console.log(`  ⚠ [acc${acc.index}] search input not found — saved ${shot}`);
    return 'search_failed';
  }

  console.log(`  🔎 [acc${acc.index}] typing search: ${group.label}`);
  try {
    await searchInput.click();
    await searchInput.fill('');
    await searchInput.type(group.label, { delay: 60 });
  } catch (e) {
    console.log(`  ⚠ [acc${acc.index}] could not type search query: ${e.message?.slice(0, 120)}`);
    return 'search_failed';
  }
  // Let autocomplete render, then submit to land on the full results page.
  await delay(2_000);
  try {
    await searchInput.press('Enter');
  } catch { /* continue */ }
  await page.waitForLoadState('domcontentloaded', { timeout: 30_000 }).catch(() => {});
  await delay(2_500);

  // Switch to the Groups-scoped results. If clicking the filter link fails
  // (or it grabbed the wrong link, e.g. the top-bar nav), fall back to a
  // direct URL navigation.
  const clicked = await clickGroupsFilter(page);
  if (clicked) await delay(1_500);
  const onGroups = await ensureGroupsFilterByUrl(page, group.label);
  if (!onGroups) {
    console.log(`  ⚠ [acc${acc.index}] could not reach /search/groups/ results page`);
    return 'search_failed';
  }
  return 'ok';
}

async function isLoggedIn(page) {
  const sels = [
    '[role="navigation"][aria-label="Facebook"]',
    '[aria-label="Your profile"]',
    '[aria-label="Account"]',
    'a[href="/me/"]',
    'a[href*="facebook.com/me"]',
  ];
  for (const sel of sels) {
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

async function findButtonByText(page, patterns) {
  for (const pattern of patterns) {
    try {
      const btn = page.getByRole('button', { name: pattern }).first();
      if ((await btn.count()) > 0) {
        const visible = await btn.isVisible().catch(() => false);
        if (visible) return btn;
      }
    } catch { /* try next */ }
    try {
      const link = page.getByRole('link', { name: pattern }).first();
      if ((await link.count()) > 0) {
        const visible = await link.isVisible().catch(() => false);
        if (visible) return link;
      }
    } catch { /* try next */ }
  }
  return null;
}

async function findJoinButtonDeep(page) {
  // Fallback: walk every clickable element on the page and check its accessible
  // text. Catches edge cases where Facebook wraps the button label, prefixes a
  // "+" icon, or attaches a tooltip suffix.
  try {
    const handles = await page.locator('div[role="button"], a[role="button"], button').all();
    for (const h of handles) {
      const visible = await h.isVisible().catch(() => false);
      if (!visible) continue;
      const txt = ((await h.textContent().catch(() => '')) || '').trim();
      const aria = (await h.getAttribute('aria-label').catch(() => '')) || '';
      const combined = `${txt} ${aria}`;
      if (/\bjoin\s+group\b/i.test(combined) || /группэд\s+нэгдэх/i.test(combined) || /^нэгдэх$/i.test(txt.trim())) {
        return h;
      }
    }
  } catch { /* fall through */ }
  return null;
}

async function isAlreadyMember(page) {
  const btn = await findButtonByText(page, ALREADY_JOINED_PATTERNS);
  return btn !== null;
}

async function dismissAnyDialog(page) {
  // Only dismiss things that are clearly NOT the participant-questions / rules modal
  // (we want that one to stay open as proof of a successful join).
  for (const label of ['Close', 'Хаах', 'Not now', 'Тэгэхгүй']) {
    try {
      const btn = page.getByRole('button', { name: new RegExp(`^${label}$`, 'i') }).first();
      if ((await btn.count()) > 0 && (await btn.isVisible().catch(() => false))) {
        // Skip if a participant-question or rules dialog is on screen
        const onJoinDialog = await page
          .getByText(/participant questions|group rules from the admins|оролцогчийн асуулт|группын дүрэм/i)
          .first()
          .count()
          .catch(() => 0);
        if (onJoinDialog > 0) return;
        await btn.click();
        await delay(500);
      }
    } catch { /* ignore */ }
  }
}

async function pageIsAccountChooser(page) {
  // Facebook's "Continue / Use another profile / Create new account" identity
  // challenge — a SOFT challenge that recovers if we just click "Continue".
  try {
    const url = page.url();
    if (/\/checkpoint|\/login\/device-based|\/login\/identify/i.test(url)) {
      // High-signal URL hint.
    }
    // The combination of "Continue" + "Use another profile" is the unique
    // fingerprint of this page (vs. login wall or logged-out preview).
    const useAnother = page
      .getByText(/^use another profile$|өөр профайл ашигла/i)
      .first();
    if ((await useAnother.count()) > 0 && (await useAnother.isVisible().catch(() => false))) return true;
  } catch { /* fall through */ }
  return false;
}

async function clickContinueButton(page) {
  for (const pattern of [/^continue$/i, /^үргэлжлүүлэх$/i]) {
    try {
      const btn = page.getByRole('button', { name: pattern }).first();
      if ((await btn.count()) > 0 && (await btn.isVisible().catch(() => false))) {
        await btn.click();
        return true;
      }
    } catch { /* try next */ }
    try {
      const link = page.getByRole('link', { name: pattern }).first();
      if ((await link.count()) > 0 && (await link.isVisible().catch(() => false))) {
        await link.click();
        return true;
      }
    } catch { /* try next */ }
  }
  return false;
}

async function recoverFromAccountChooser(page, acc) {
  console.log(`  🛟 [acc${acc.index}] account-chooser detected — clicking Continue to recover…`);
  await page
    .screenshot({ path: `debug-chooser-acc${acc.index}-${Date.now()}.png`, fullPage: false })
    .catch(() => {});
  const clicked = await clickContinueButton(page);
  if (!clicked) {
    console.log(`  ⚠ [acc${acc.index}] could not find Continue button on account-chooser`);
    return false;
  }
  await page
    .waitForLoadState('domcontentloaded', { timeout: 20_000 })
    .catch(() => {});
  await delay(3_000);
  return true;
}

async function pageIsAnonymous(page) {
  // The truly-logged-out anonymous preview shows the "Log in or sign up"
  // banner at the bottom. Distinct from the recoverable account-chooser.
  try {
    const banners = [
      /log in or sign up for facebook/i,
      /create new account/i,
      /бүртгүүлэх/i,
    ];
    for (const p of banners) {
      const loc = page.getByText(p).first();
      if ((await loc.count()) > 0 && (await loc.isVisible().catch(() => false))) return true;
    }
  } catch { /* fall through */ }
  return false;
}

async function pageShowsRateLimit(page) {
  // Facebook block / rate-limit dialogs. Any of these means we should stop using
  // this account for now and move on to the next.
  const patterns = [
    /you'?re temporarily blocked/i,
    /try again later/i,
    /we limit how often/i,
    /this feature is temporarily unavailable/i,
    /you can'?t use this feature/i,
    /we suspect automated behavior/i,    // FB's anti-bot warning
    /suspicious activity/i,
    /түр зуур.*хориглосон/i,             // Mongolian "temporarily blocked"
    /дараа дахин оролдо/i,                // Mongolian "try again later"
    /автоматжуулсан үйлдэл/i,             // Mongolian "automated behavior"
  ];
  for (const p of patterns) {
    try {
      const loc = page.getByText(p).first();
      if ((await loc.count()) > 0 && (await loc.isVisible().catch(() => false))) return true;
    } catch { /* try next */ }
  }
  return false;
}

async function clickDismissOrClose(page) {
  for (const pattern of [/^dismiss$/i, /^үргэлжлүүлэх$/i, /^хаах$/i, /^close$/i, /^ok$/i]) {
    try {
      const btn = page.getByRole('button', { name: pattern }).first();
      if ((await btn.count()) > 0 && (await btn.isVisible().catch(() => false))) {
        await btn.click();
        return true;
      }
    } catch { /* try next */ }
  }
  return false;
}

async function joinSucceededIndicator(page) {
  // Any of these confirm the click actually joined the group.
  // 1) toast at bottom of viewport
  // 2) participant-questions / rules modal (admin-review groups)
  // 3) the action button now reads Joined / Нэгдсэн / request-sent equivalents
  try {
    const toast = page.getByText(/^you joined /i).first();
    if ((await toast.count()) > 0) return true;
  } catch { /* next */ }
  try {
    const toastMn = page.getByText(/танай.*нэгдсэн|та .* нэгдлээ/i).first();
    if ((await toastMn.count()) > 0) return true;
  } catch { /* next */ }
  try {
    const modal = page
      .getByText(/participant questions|get started by submitting a request|group rules from the admins|оролцогчийн асуулт|хүсэлт.*илгээ/i)
      .first();
    if ((await modal.count()) > 0) return true;
  } catch { /* next */ }
  return await isAlreadyMember(page);
}

async function joinGroup(page, group, acc) {
  console.log(`  ▶ [acc${acc.index}] ${group.id} — ${group.label}`);

  // Direct navigation to /groups/<id>/. Simpler and reliable when we already
  // have the group URL (current input format is a plain-text URL list).
  try {
    await page.goto(group.url, { waitUntil: 'domcontentloaded', timeout: 45_000 });
  } catch (e) {
    console.log(`  ⚠ [acc${acc.index}] nav failed: ${e.message?.slice(0, 120)}`);
    return 'nav_failed';
  }
  try { await page.waitForLoadState('networkidle', { timeout: 15_000 }); } catch { /* flaky */ }
  await delay(2_500);

  if (await pageShowsRateLimit(page)) {
    const shotPath = `debug-ratelimit-acc${acc.index}-${group.id}.png`;
    await page.screenshot({ path: shotPath, fullPage: false }).catch(() => {});
    console.log(`  🚫 [acc${acc.index}] Facebook anti-bot / rate-limit page (saved ${shotPath})`);
    await clickDismissOrClose(page).catch(() => {});
    return 'rate_limited';
  }

  if (await pageIsAccountChooser(page)) {
    const recovered = await recoverFromAccountChooser(page, acc);
    if (recovered) {
      try {
        await page.goto(group.url, { waitUntil: 'domcontentloaded', timeout: 45_000 });
        await delay(2_500);
      } catch { return 'nav_failed'; }
    } else {
      return 'logged_out';
    }
  }

  if (await pageIsAnonymous(page)) {
    const shotPath = `debug-loggedout-acc${acc.index}-${group.id}.png`;
    await page.screenshot({ path: shotPath, fullPage: false }).catch(() => {});
    console.log(`  🔒 [acc${acc.index}] page rendered logged-out — session lost (saved ${shotPath})`);
    return 'logged_out';
  }

  await dismissAnyDialog(page);
  await delay(800);

  // Member-state detection first: if already joined / request pending, skip.
  if (await isAlreadyMember(page)) {
    console.log(`  ⏭  [acc${acc.index}] already a member / request pending`);
    return 'already_member';
  }

  // Find the Join button on the group's landing page.
  let joinBtn = await findButtonByText(page, JOIN_BUTTON_PATTERNS);
  if (!joinBtn) {
    await delay(2_000);
    joinBtn = await findButtonByText(page, JOIN_BUTTON_PATTERNS);
  }
  if (!joinBtn) joinBtn = await findJoinButtonDeep(page);
  if (!joinBtn) {
    const shotPath = `debug-nojoin-acc${acc.index}-${group.id}.png`;
    await page.screenshot({ path: shotPath, fullPage: false }).catch(() => {});
    console.log(`  ❓ [acc${acc.index}] no Join button on group page — saved ${shotPath}`);
    return 'no_button';
  }

  try {
    await joinBtn.scrollIntoViewIfNeeded({ timeout: 3_000 }).catch(() => {});
    await joinBtn.click({ timeout: 5_000 });
  } catch (e) {
    console.log(`  ⚠ [acc${acc.index}] join click failed: ${e.message?.slice(0, 120)}`);
    return 'click_failed';
  }
  await delay(2_500);

  if (await pageShowsRateLimit(page)) {
    console.log(`  🚫 [acc${acc.index}] Facebook rate-limit triggered after click`);
    return 'rate_limited';
  }

  if (await joinSucceededIndicator(page)) {
    console.log(`  ✅ [acc${acc.index}] joined / request sent`);
    await dismissAnyDialog(page);
    return 'joined';
  }

  await delay(2_000);
  if (await joinSucceededIndicator(page)) {
    console.log(`  ✅ [acc${acc.index}] joined / request sent (delayed)`);
    await dismissAnyDialog(page);
    return 'joined';
  }

  const shotPath = `debug-join-acc${acc.index}-${group.id}-post.png`;
  await page.screenshot({ path: shotPath, fullPage: false }).catch(() => {});
  console.log(`  ⚠ [acc${acc.index}] click ok but state unclear — saved ${shotPath}`);
  return 'unclear';
}

async function runAccount(acc, groups) {
  const userDataDir = path.join(PROFILES_DIR, `account-${acc.index}`);
  fs.mkdirSync(userDataDir, { recursive: true });

  console.log(`▶ Starting account ${acc.index}: ${acc.email}`);
  const context = await chromium.launchPersistentContext(userDataDir, {
    headless: false,
    slowMo: 40,
    viewport: { width: 1280, height: 800 },
    userAgent: UA,
  });
  const page = context.pages()[0] || (await context.newPage());
  page.setDefaultNavigationTimeout(60_000);

  const summary = {
    joined: 0, already_member: 0, no_button: 0, click_failed: 0,
    unclear: 0, nav_failed: 0, logged_out: 0, rate_limited: 0,
    no_result: 0, search_failed: 0,
  };

  let fatal = null;
  context.on('close', () => { fatal = fatal || 'context_closed'; });

  try {
    try {
      await ensureLoggedIn(page, acc);
    } catch (err) {
      console.error(`❌ Account ${acc.index} login failed:`, err?.message || err);
      await page.screenshot({ path: `screenshot-login-account${acc.index}.png`, fullPage: true }).catch(() => {});
      fatal = 'login_failed';
      return { acc, summary, fatal };
    }

    let consecutiveNavFail = 0;
    let consecutiveLoggedOut = 0;
    for (const group of groups) {
      if (fatal) {
        console.log(`✋ Account ${acc.index} aborting remaining groups — ${fatal}`);
        break;
      }
      const result = await joinGroup(page, group, acc);
      summary[result] = (summary[result] || 0) + 1;

      if (result === 'rate_limited') {
        console.log(`✋ Account ${acc.index} — Facebook rate-limit, switching to next account`);
        fatal = 'rate_limited';
        break;
      }

      if (result === 'nav_failed') {
        consecutiveNavFail += 1;
        if (consecutiveNavFail >= 2) {
          console.log(`✋ Account ${acc.index} — 2 consecutive nav failures, browser likely closed; stopping this account`);
          fatal = 'context_closed';
          break;
        }
      } else {
        consecutiveNavFail = 0;
      }

      if (result === 'logged_out') {
        consecutiveLoggedOut += 1;
        if (consecutiveLoggedOut >= 3) {
          console.log(`✋ Account ${acc.index} — 3 consecutive logged-out pages, session lost; stopping this account`);
          fatal = 'session_lost';
          break;
        }
      } else {
        consecutiveLoggedOut = 0;
      }

      // Slow the cadence to reduce Facebook's anti-spam challenge after fresh
      // logins. ~10–20s between groups keeps it human-paced.
      await randomDelay(10_000, 20_000);
    }

    console.log(
      `✔ Account ${acc.index} done — joined:${summary.joined} already:${summary.already_member} ` +
      `no-btn:${summary.no_button} no-result:${summary.no_result} search-fail:${summary.search_failed} ` +
      `unclear:${summary.unclear} logged-out:${summary.logged_out} ` +
      `rate-limited:${summary.rate_limited} click-fail:${summary.click_failed} nav-fail:${summary.nav_failed}` +
      (fatal ? `  [stopped early: ${fatal}]` : ''),
    );
    return { acc, summary, fatal };
  } finally {
    // Close the browser at the end of this account so we don't pile up windows.
    try { await context.close(); } catch { /* already closed */ }
  }
}

async function main() {
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
  console.log(`👥 Running ${accounts.length} account(s) sequentially — one browser at a time`);
  console.log(`💾 Sessions persist in ${PROFILES_DIR}/account-N — re-runs skip login when cookies are valid\n`);

  const results = [];
  for (const acc of accounts) {
    const r = await runAccount(acc, groups);
    results.push(r);
    if (r.fatal === 'rate_limited') {
      console.log(`↪ Rate-limited on acc${acc.index}; moving on to the next account.\n`);
    }
    // small breather between accounts
    await delay(2_000);
  }

  console.log('\n──── Final summary ────');
  for (const r of results) {
    if (r.fatal) {
      console.log(`  acc${r.acc.index} (${r.acc.email}): FATAL ${r.fatal}`);
      continue;
    }
    const s = r.summary;
    console.log(
      `  acc${r.acc.index} (${r.acc.email}): ` +
      `joined=${s.joined} already=${s.already_member} no-btn=${s.no_button} ` +
      `no-result=${s.no_result} search-fail=${s.search_failed} ` +
      `unclear=${s.unclear} logged-out=${s.logged_out} rate-limited=${s.rate_limited} ` +
      `click-fail=${s.click_failed} nav-fail=${s.nav_failed}` +
      (r.fatal ? `  [stopped early: ${r.fatal}]` : ''),
    );
  }
  console.log('\nAll accounts processed. Exiting.');
}

main().catch((e) => {
  console.error(e);
  process.exit(1);
});
