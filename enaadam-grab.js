// enaadam.mn ticket grabber — runs all logged-in accounts in PARALLEL to:
//   1. open the event ticket page (reusing each saved session),
//   2. find the first available RED zone (price tier 157,500₮; zone number in
//      TARGET_ZONES) and click it,
//   3. auto-select up to MAX_TICKETS available (teal) seats,
//   4. click through to add them to the cart — then STOP before payment.
//
// Headless by default (set HEADLESS=false to watch). Optional scheduled start:
// set START_AT to an ISO time and the wave fires at that moment.
//
// ⚠️  The zone/seat DOM selectors here are built from a screenshot of a past
//     event — they MUST be verified/tuned against a live event (run with
//     HEADLESS=false and DEBUG=true once an event renders; it dumps DOM on miss).
//
// Usage (from project root):
//   EVENT_URL="https://www.enaadam.mn/ticket?..." node enaadam-grab.js
//   EVENT_URL="..." HEADLESS=false DEBUG=true node enaadam-grab.js 1 2 8
//   EVENT_URL="..." START_AT="2026-07-01T03:00:00Z" node enaadam-grab.js
import 'dotenv/config';
import path from 'node:path';
import fs from 'node:fs';
import { chromium } from 'playwright';
import { getEnaadamAccounts } from './enaadam-accounts.mjs';
import { isLoggedIn, TICKET_URL, delay } from './lib/enaadam-login.mjs';
import {
  TARGET_COLOR, TARGET_ZONES, STATUS_COLORS, parseRgb,
} from './enaadam-zones.mjs';

const UA =
  'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/124.0.0.0 Safari/537.36';
const PROFILES_DIR = path.resolve('./profiles');
const SHOTS_DIR = path.resolve('./grab-shots');

// ── Config (env-overridable) ──────────────────────────────────────
const EVENT_URL = process.env.EVENT_URL || TICKET_URL;
const HEADLESS = process.env.HEADLESS !== 'false';
const DEBUG = process.env.DEBUG === 'true';
const START_AT = process.env.START_AT || null;     // ISO time, e.g. 2026-07-01T03:00:00Z
const MAX_TICKETS = Number(process.env.MAX_TICKETS || 2);
const ZONE_POLL_MS = Number(process.env.ZONE_POLL_MS || 400);
const ZONE_TIMEOUT_MS = Number(process.env.ZONE_TIMEOUT_MS || 120_000);
const COLOR_TOL = 14;

// Buttons that move an order forward (Mongolian / English variants).
const PROCEED_PATTERNS = [
  /худалдан авах/i, /сагс(ан)?д нэмэх/i, /үргэлжлүүлэх/i, /тасалбар авах/i,
  /баталгаажуул/i, /захиалах/i, /continue/i, /buy|purchase|checkout|add to cart/i,
];

function shot(page, name) {
  return page.screenshot({ path: path.join(SHOTS_DIR, name), fullPage: true }).catch(() => {});
}

// ── In-page scanners (run in the browser; receive plain values) ───
// Tag the first available RED zone whose number is a target. Returns its number
// or null. We mark it with data-grab-zone so Playwright can click it reliably.
function pageFindRedZone(targetColor, targetNums, tol) {
  function rgb(s) { const m = /rgba?\(\s*(\d+)\s*,\s*(\d+)\s*,\s*(\d+)/.exec(s || ''); return m ? [+m[1], +m[2], +m[3]] : null; }
  function near(a, b) { const x = rgb(a), y = rgb(b); return x && y && Math.abs(x[0]-y[0])<=tol && Math.abs(x[1]-y[1])<=tol && Math.abs(x[2]-y[2])<=tol; }
  function colorOf(el) {
    const s = getComputedStyle(el);
    if (s.backgroundColor && s.backgroundColor !== 'rgba(0, 0, 0, 0)' && s.backgroundColor !== 'transparent') return s.backgroundColor;
    if (s.fill && s.fill !== 'none' && s.fill !== 'rgb(0, 0, 0)') return s.fill;
    const f = el.getAttribute && el.getAttribute('fill');
    return f || null;
  }
  function numberOf(el) {
    // a number printed in this element or a close child
    const t = (el.textContent || '').trim();
    if (/^\d{1,2}$/.test(t)) return +t;
    for (const c of el.querySelectorAll('*')) {
      const ct = (c.textContent || '').trim();
      if (/^\d{1,2}$/.test(ct)) return +ct;
    }
    return null;
  }
  function clickable(el) {
    let cur = el;
    for (let i = 0; i < 6 && cur; i++) {
      const tag = cur.tagName ? cur.tagName.toLowerCase() : '';
      if (tag === 'a' || tag === 'button' || cur.getAttribute('role') === 'button'
        || cur.onclick || cur.getAttribute('tabindex') !== null
        || tag === 'g' || tag === 'path' || tag === 'polygon') return cur;
      cur = cur.parentElement;
    }
    return el;
  }
  const reds = [];
  for (const el of document.querySelectorAll('*')) {
    const c = colorOf(el);
    if (c && near(c, targetColor)) reds.push(el);
  }
  for (const el of reds) {
    const n = numberOf(el);
    if (n != null && targetNums.includes(n)) {
      const target = clickable(el);
      target.setAttribute('data-grab-zone', String(n));
      return n;
    }
  }
  return null;
}

// Tag up to `max` available (teal) seats. Returns how many were tagged.
function pageTagSeats(availColor, tol, max) {
  function rgb(s) { const m = /rgba?\(\s*(\d+)\s*,\s*(\d+)\s*,\s*(\d+)/.exec(s || ''); return m ? [+m[1], +m[2], +m[3]] : null; }
  function near(a, b) { const x = rgb(a), y = rgb(b); return x && y && Math.abs(x[0]-y[0])<=tol && Math.abs(x[1]-y[1])<=tol && Math.abs(x[2]-y[2])<=tol; }
  function colorOf(el) {
    const s = getComputedStyle(el);
    if (s.backgroundColor && s.backgroundColor !== 'rgba(0, 0, 0, 0)' && s.backgroundColor !== 'transparent') return s.backgroundColor;
    if (s.fill && s.fill !== 'none') return s.fill;
    return el.getAttribute && el.getAttribute('fill');
  }
  let tagged = 0;
  for (const el of document.querySelectorAll('*')) {
    if (tagged >= max) break;
    const r = el.getBoundingClientRect ? el.getBoundingClientRect() : null;
    if (!r || r.width < 6 || r.height < 6 || r.width > 80 || r.height > 80) continue; // seat-sized
    const c = colorOf(el);
    if (c && near(c, availColor) && !el.hasAttribute('data-grab-seat')) {
      el.setAttribute('data-grab-seat', String(tagged + 1));
      tagged++;
    }
  }
  return tagged;
}

async function clickProceed(page) {
  for (const re of PROCEED_PATTERNS) {
    for (const role of ['button', 'link']) {
      try {
        const el = page.getByRole(role, { name: re }).first();
        if ((await el.count()) > 0 && (await el.isVisible().catch(() => false))) {
          const disabled = (await el.getAttribute('aria-disabled').catch(() => null)) === 'true';
          if (disabled) continue;
          await el.click({ timeout: 4000 });
          return true;
        }
      } catch { /* next */ }
    }
  }
  return false;
}

async function grabForAccount(acc) {
  const userDataDir = path.join(PROFILES_DIR, `enaadam-account-${acc.index}`);
  if (!fs.existsSync(userDataDir)) return { acc, status: 'no_profile' };

  const context = await chromium.launchPersistentContext(userDataDir, {
    headless: HEADLESS, viewport: { width: 1366, height: 900 }, userAgent: UA,
  });
  const page = context.pages()[0] || (await context.newPage());
  page.setDefaultNavigationTimeout(60_000);
  const tag = `acc${acc.index}`;

  try {
    await page.goto(EVENT_URL, { waitUntil: 'domcontentloaded' });
    await delay(2500);
    if (!(await isLoggedIn(page))) return { acc, status: 'not_logged_in' };

    // ── 1) find + click first available red target zone ──────────
    let zoneNum = null;
    const deadline = Date.now() + ZONE_TIMEOUT_MS;
    while (Date.now() < deadline && zoneNum == null) {
      zoneNum = await page.evaluate(pageFindRedZone, TARGET_COLOR, TARGET_ZONES, COLOR_TOL).catch(() => null);
      if (zoneNum == null) await delay(ZONE_POLL_MS);
    }
    if (zoneNum == null) {
      await shot(page, `${tag}-no-zone.png`);
      if (DEBUG) fs.writeFileSync(path.join(SHOTS_DIR, `${tag}-dom.html`), await page.content(), 'utf8');
      return { acc, status: 'no_red_zone' };
    }
    await page.click('[data-grab-zone]', { timeout: 5000 });
    console.log(`  🎯 ${tag} clicked red zone ${zoneNum}`);
    await delay(2500);

    // ── 2) auto-pick up to MAX_TICKETS available seats ───────────
    let picked = 0;
    const seatDeadline = Date.now() + 30_000;
    while (Date.now() < seatDeadline && picked < MAX_TICKETS) {
      const n = await page.evaluate(pageTagSeats, STATUS_COLORS.available, COLOR_TOL, MAX_TICKETS - picked).catch(() => 0);
      if (n > 0) {
        for (let i = 1; i <= n && picked < MAX_TICKETS; i++) {
          try {
            await page.click(`[data-grab-seat="${i}"]`, { timeout: 3000 });
            picked++;
            await delay(600);
          } catch { /* seat vanished; re-scan */ }
        }
        // clear markers so the next scan finds fresh seats
        await page.evaluate(() => document.querySelectorAll('[data-grab-seat]').forEach((e) => e.removeAttribute('data-grab-seat'))).catch(() => {});
      } else {
        await delay(500);
      }
    }
    await shot(page, `${tag}-after-seats.png`);
    if (picked === 0) {
      if (DEBUG) fs.writeFileSync(path.join(SHOTS_DIR, `${tag}-seat-dom.html`), await page.content(), 'utf8');
      return { acc, status: `zone${zoneNum}_no_seats` };
    }

    // ── 3) add to cart / proceed (stop before payment) ───────────
    const proceeded = await clickProceed(page);
    await delay(2500);
    await shot(page, `${tag}-cart.png`);
    console.log(`  ✅ ${tag} zone ${zoneNum}, ${picked} seat(s), proceed=${proceeded}`);
    return { acc, status: `cart:zone${zoneNum}:${picked}seat${proceeded ? ':proceeded' : ''}` };
  } catch (e) {
    await shot(page, `${tag}-error.png`).catch(() => {});
    return { acc, status: `error:${(e?.message || e).toString().slice(0, 80)}` };
  } finally {
    // Leave the browser OPEN if we reached the cart (so the user can pay);
    // close it otherwise to free resources.
    // For an unattended scheduled run you may prefer to always keep open.
    if (HEADLESS) { try { await context.close(); } catch { /* */ } }
  }
}

async function waitUntilStart() {
  if (!START_AT) return;
  const target = Date.parse(START_AT);
  if (Number.isNaN(target)) { console.warn(`⚠️  START_AT not a valid ISO date: ${START_AT} — starting now`); return; }
  let now = Date.now();
  console.log(`⏰ Scheduled start at ${START_AT}. Waiting ${(Math.max(0, target - now) / 1000).toFixed(0)}s…`);
  while ((now = Date.now()) < target) {
    const left = target - now;
    await delay(left > 5000 ? 1000 : Math.max(20, left)); // tighten near the deadline
  }
  console.log('🚀 Start time reached — firing all accounts.');
}

async function main() {
  fs.mkdirSync(SHOTS_DIR, { recursive: true });
  const all = getEnaadamAccounts();
  const requested = process.argv.slice(2).map(Number).filter(Boolean);
  const accounts = (requested.length > 0 ? all.filter((a) => requested.includes(a.index)) : all)
    .filter((a) => fs.existsSync(path.join(PROFILES_DIR, `enaadam-account-${a.index}`)));

  if (accounts.length === 0) {
    console.error('❌ No logged-in accounts to run. Run enaadam-login.js first.');
    process.exit(1);
  }

  console.log(`🎟  Grab: ${accounts.length} account(s) | headless=${HEADLESS} | url=${EVENT_URL}`);
  console.log(`   zones=${TARGET_ZONES.join(',')} | max-tickets=${MAX_TICKETS}`);
  if (EVENT_URL === TICKET_URL) {
    console.warn('   ⚠️  Using the bare /ticket URL — set EVENT_URL to the live event URL when sales open.');
  }

  await waitUntilStart();

  const results = await Promise.all(accounts.map((acc) => grabForAccount(acc)));

  console.log('\n──── Grab summary ────');
  for (const r of results) console.log(`  acc${r.acc.index} (${r.acc.mobile}): ${r.status}`);
  const carted = results.filter((r) => r.status.startsWith('cart:')).length;
  console.log(`\n🧾 ${carted}/${accounts.length} reached cart. Screenshots in grab-shots/.`);
  if (!HEADLESS) console.log('   (headful windows left open where a cart was reached — complete payment there.)');
}

main().catch((e) => { console.error(e); process.exit(1); });
