// enaadam.mn ticket grabber — PRODUCTION "do-or-die" build.
//
// Runs every logged-in account in PARALLEL, each fully independent and crash-proof:
//   PHASE 1 WATCH — repeatedly reload EVENT_URL until the live seat map renders
//                   (the event is published). Refreshes the browser each cycle.
//   PHASE 2 GRAB  — the instant it's live: self-calibrate colors from the page's
//                   own legend, then loop the target zones, pick available seats
//                   and click "Сагслах" per seat. KEEPS cycling/refreshing for
//                   fresh availability until MAX_TICKETS are carted or the time
//                   budget runs out (does NOT give up after one pass).
//   PHASE 3 HOLD  — on success, leave the (headful) window OPEN and report which
//                   accounts to pay. Сагслах is the last click — never pay.
//
// Robustness guarantees: every page op is timeout-bounded and try/caught; a dead
// page is auto-relaunched; one account failing never aborts the others; global
// unhandledRejection/uncaughtException guards keep the process alive.
//
// Usage (from project root):
//   EVENT_URL="https://www.enaadam.mn/ticket?..." node enaadam-grab.js
//   EVENT_URL="..." DEBUG=true node enaadam-grab.js 1 2 8
//   EVENT_URL="..." START_AT="2026-07-08T03:00:00Z" node enaadam-grab.js
//   EVENT_URL="..." HEADLESS=true node enaadam-grab.js          # unattended/no payment
import 'dotenv/config';
import path from 'node:path';
import fs from 'node:fs';
import { pathToFileURL } from 'node:url';
import { chromium } from 'playwright';
import { getEnaadamAccounts } from './enaadam-accounts.mjs';
import { TICKET_URL, delay, isLoggedIn } from './lib/enaadam-login.mjs';
import { TARGET_COLOR, TARGET_ZONES, STATUS_COLORS } from './enaadam-zones.mjs';

// Global crash guards — a stray rejection/exception must NEVER kill the run.
process.on('unhandledRejection', (e) => console.warn(`⚠️  unhandledRejection: ${(e?.message || e)}`));
process.on('uncaughtException', (e) => console.warn(`⚠️  uncaughtException: ${(e?.message || e)}`));

const UA =
  'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/124.0.0.0 Safari/537.36';
const PROFILES_DIR = path.resolve('./profiles');
const SHOTS_DIR = path.resolve('./grab-shots');

// ── Config (env-overridable) ──────────────────────────────────────
const EVENT_URL = process.env.EVENT_URL || TICKET_URL;
const HEADLESS = process.env.HEADLESS === 'true';   // DEFAULT HEADFUL so you can pay.
const DEBUG = process.env.DEBUG === 'true';
const START_AT = process.env.START_AT || null;      // ISO time to begin the watch wave
const MAX_TICKETS = Number(process.env.MAX_TICKETS || 2);
const RUN_BUDGET_MS = Number(process.env.RUN_BUDGET_MS || 1_200_000); // total per-account budget (20 min)
const WATCH_POLL_MS = Number(process.env.WATCH_POLL_MS || 2_000);     // reload cadence while waiting for publish
const ZONE_POLL_MS = Number(process.env.ZONE_POLL_MS || 350);
const ZONE_OPEN_MS = Number(process.env.ZONE_OPEN_MS || 8_000);       // how long to wait for one zone to render
const SEAT_PASS_MS = Number(process.env.SEAT_PASS_MS || 12_000);      // per-zone seat-grab window
const NAV_TIMEOUT = Number(process.env.NAV_TIMEOUT || 30_000);
const ACTION_TIMEOUT = Number(process.env.ACTION_TIMEOUT || 8_000);
const COLOR_TOL = Number(process.env.COLOR_TOL || 16);
const STATUS_EVERY_MS = Number(process.env.STATUS_EVERY_MS || 15_000); // heartbeat cadence while watching

// "Сагслах" (add-to-cart) button — the ONLY required click. Tolerant of variants.
const SAGSLAH_PATTERN = /сагсл?ах|сагс(ан)?д нэмэх/i;

function shot(page, name) {
  return page.screenshot({ path: path.join(SHOTS_DIR, name), fullPage: true }).catch(() => {});
}

// ── In-page scanners (run in the browser; receive plain values) ───

// Is the event LIVE? True once the seat map has rendered (many seat-sized colored
// dots, or several numbered zone buttons) — i.e. past the pre-publish skeleton.
export function pageEventLive() {
  let dots = 0, zones = 0;
  for (const el of document.querySelectorAll('*')) {
    const r = el.getBoundingClientRect ? el.getBoundingClientRect() : null;
    if (!r || r.width === 0) continue;
    const s = getComputedStyle(el);
    const bg = s.backgroundColor;
    const colored = (bg && bg !== 'rgba(0, 0, 0, 0)' && bg !== 'transparent') || (s.fill && s.fill !== 'none' && s.fill !== 'rgb(0, 0, 0)');
    if (colored && r.width >= 6 && r.height >= 6 && r.width <= 44 && r.height <= 44) dots++;
    const t = (el.textContent || '').trim();
    if (/^\d{1,2}$/.test(t) && r.width >= 14 && r.width <= 130 && r.height >= 14 && r.height <= 130) zones++;
    if (dots >= 20 || zones >= 6) return true;
  }
  return dots >= 20 || zones >= 6;
}

// Self-calibrate colors from the page's own legend so we don't trust a stale RGB.
// Returns the top price-tier color (highest price = "red" zone tier) and the
// "Боломжтой" (available) swatch color — nulls fall back to the constants.
export function pageCalibrate() {
  function bg(el) {
    const s = getComputedStyle(el);
    if (s.backgroundColor && s.backgroundColor !== 'rgba(0, 0, 0, 0)' && s.backgroundColor !== 'transparent') return s.backgroundColor;
    if (s.fill && s.fill !== 'none' && s.fill !== 'rgb(0, 0, 0)') return s.fill;
    return null;
  }
  const tiers = [];
  for (const el of document.querySelectorAll('*')) {
    const t = (el.textContent || '').trim();
    if (/^\d{2,3},\d{3}\s*₮?$/.test(t)) {
      const c = bg(el);
      if (c) tiers.push({ price: parseInt(t.replace(/\D/g, ''), 10), color: c });
    }
  }
  tiers.sort((a, b) => b.price - a.price);
  const redTier = tiers.length ? tiers[0].color : null;

  let available = null;
  for (const el of document.querySelectorAll('*')) {
    const t = (el.textContent || '').trim();
    if (/^Боломжтой$/i.test(t)) {
      // the swatch may be a CHILD (e.g. <span><i class=dot/> Боломжтой</span>),
      // a sibling, or another chip in the same row — check all.
      const cand = [el.querySelector('i'), el.querySelector('.dot'),
                    el.previousElementSibling, el.nextElementSibling,
                    ...(el.parentElement ? el.parentElement.children : [])].filter(Boolean);
      for (const s of cand) { const c = bg(s); if (c) { available = c; break; } }
      if (available) break;
    }
  }
  return { redTier, available };
}

// Tag an available RED zone whose number is a target. Returns its number or null.
// Marks it with data-grab-zone so Playwright can click it reliably. The number
// may live ON the colored element, in its data-sector, or in a SEPARATE label
// drawn over it — try all three so this works whether the zone is a button with
// its number inside (likely the live site) or an SVG shape + separate <text>
// label (the seat-map renderer). Takes ONE object arg (page.evaluate only
// forwards a single argument).
export function pageFindRedZone({ targetColor, targetNums, tol }) {
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
    const t = (el.textContent || '').trim();
    if (/^\d{1,2}$/.test(t)) return +t;
    const ds = el.getAttribute && el.getAttribute('data-sector');
    if (ds && /^\d{1,2}$/.test(ds)) return +ds;
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
        || (cur.hasAttribute && cur.hasAttribute('data-sector'))
        || tag === 'g' || tag === 'path' || tag === 'polygon' || tag === 'rect') return cur;
      cur = cur.parentElement;
    }
    return el;
  }
  const reds = [];
  for (const el of document.querySelectorAll('*')) {
    const c = colorOf(el);
    if (c && near(c, targetColor)) reds.push(el);
  }
  // (A) number is on the colored element / in its data-sector / on a descendant
  for (const el of reds) {
    const n = numberOf(el);
    if (n != null && targetNums.includes(n)) {
      const target = clickable(el);
      target.setAttribute('data-grab-zone', String(n));
      return n;
    }
  }
  // (B) number is a SEPARATE label whose center sits inside the colored shape
  const labels = [];
  for (const el of document.querySelectorAll('*')) {
    const t = (el.textContent || '').trim();
    if (!/^\d{1,2}$/.test(t)) continue;
    const n = +t;
    if (!targetNums.includes(n)) continue;
    const r = el.getBoundingClientRect ? el.getBoundingClientRect() : null;
    if (r && r.width) labels.push({ n, cx: r.left + r.width / 2, cy: r.top + r.height / 2 });
  }
  for (const el of reds) {
    const r = el.getBoundingClientRect ? el.getBoundingClientRect() : null;
    if (!r || !r.width) continue;
    for (const lb of labels) {
      if (lb.cx >= r.left && lb.cx <= r.right && lb.cy >= r.top && lb.cy <= r.bottom) {
        const target = clickable(el);
        target.setAttribute('data-grab-zone', String(lb.n));
        return lb.n;
      }
    }
  }
  return null;
}

// Tag up to `max` available (teal) seats. Returns how many were tagged. Only
// considers ON-SCREEN seats and prefers the BOTTOM-most ones — top sectors clip
// seats up under the fixed legend/header where they can't be clicked, so picking
// the lowest visible seats keeps the click clear of overlays. `offset` rotates
// the ordered candidate list so parallel accounts prefer DIFFERENT seats (it
// wraps, so an account is never starved when seats run low). Takes ONE object
// arg (page.evaluate only forwards a single argument).
export function pageTagSeats({ availColor, tol, max, offset = 0 }) {
  function rgb(s) { const m = /rgba?\(\s*(\d+)\s*,\s*(\d+)\s*,\s*(\d+)/.exec(s || ''); return m ? [+m[1], +m[2], +m[3]] : null; }
  function near(a, b) { const x = rgb(a), y = rgb(b); return x && y && Math.abs(x[0]-y[0])<=tol && Math.abs(x[1]-y[1])<=tol && Math.abs(x[2]-y[2])<=tol; }
  function colorOf(el) {
    const s = getComputedStyle(el);
    if (s.backgroundColor && s.backgroundColor !== 'rgba(0, 0, 0, 0)' && s.backgroundColor !== 'transparent') return s.backgroundColor;
    if (s.fill && s.fill !== 'none') return s.fill;
    return el.getAttribute && el.getAttribute('fill');
  }
  const cands = [];
  for (const el of document.querySelectorAll('*')) {
    const r = el.getBoundingClientRect ? el.getBoundingClientRect() : null;
    if (!r || r.width < 6 || r.height < 6 || r.width > 80 || r.height > 80) continue; // seat-sized
    const cx = r.left + r.width / 2, cy = r.top + r.height / 2;
    if (cx < 0 || cy < 0 || cx > innerWidth || cy > innerHeight) continue;            // on-screen
    const c = colorOf(el);
    if (c && near(c, availColor) && !el.hasAttribute('data-grab-seat')) cands.push({ el, cy });
  }
  cands.sort((a, b) => b.cy - a.cy); // bottom-most (most reachable) first
  // rotate by `offset` (wrapping) so different accounts prefer different seats
  const start = cands.length ? (((offset % cands.length) + cands.length) % cands.length) : 0;
  const ordered = cands.slice(start).concat(cands.slice(0, start));
  let tagged = 0;
  for (const { el } of ordered) {
    if (tagged >= max) break;
    el.setAttribute('data-grab-seat', String(tagged + 1));
    tagged++;
  }
  return tagged;
}

// DEBUG probe: surface the REAL selectors (tag/class/attrs) of seat dots and the
// Сагслах button, so color matching can later be replaced with a stable hook.
function pageProbeSelectors() {
  function bg(el) { const s = getComputedStyle(el); return s.backgroundColor !== 'rgba(0, 0, 0, 0)' ? s.backgroundColor : (s.fill || null); }
  const sig = (el) => ({
    tag: el.tagName.toLowerCase(),
    cls: (el.className && el.className.toString()).slice(0, 100) || null,
    attrs: [...el.attributes].map((a) => a.name).join(','),
    aria: el.getAttribute('aria-label') || null,
    color: bg(el),
  });
  const dots = [];
  for (const el of document.querySelectorAll('*')) {
    const r = el.getBoundingClientRect ? el.getBoundingClientRect() : null;
    if (!r || r.width < 6 || r.height < 6 || r.width > 40 || r.height > 40) continue;
    const c = bg(el);
    if (!c || c === 'rgba(0, 0, 0, 0)') continue;
    dots.push(sig(el));
    if (dots.length >= 10) break;
  }
  let sagslah = null;
  for (const el of document.querySelectorAll('button, a, [role="button"]')) {
    if (/сагсл?ах|сагс(ан)?д нэмэх/i.test((el.textContent || '').trim())) { sagslah = sig(el); break; }
  }
  return { sampleDots: dots, sagslah };
}

// ── Playwright-side helpers ───────────────────────────────────────

// Navigate without ever throwing (errors are swallowed; liveness is re-checked).
async function safeGoto(page, url) {
  try { await page.goto(url, { waitUntil: 'domcontentloaded', timeout: NAV_TIMEOUT }); return true; }
  catch { return false; }
}

// Click the blue "Сагслах" add-to-cart button. Returns true on a real click.
export async function clickSagslah(page) {
  for (const role of ['button', 'link']) {
    try {
      const el = page.getByRole(role, { name: SAGSLAH_PATTERN }).first();
      if ((await el.count()) > 0 && (await el.isVisible().catch(() => false))) {
        const disabled = (await el.getAttribute('aria-disabled').catch(() => null)) === 'true';
        if (!disabled) { await el.click({ timeout: ACTION_TIMEOUT }); return true; }
      }
    } catch { /* try next */ }
  }
  try {
    const el = page.getByText(SAGSLAH_PATTERN, { exact: false }).first();
    if ((await el.count()) > 0 && (await el.isVisible().catch(() => false))) {
      await el.click({ timeout: ACTION_TIMEOUT });
      return true;
    }
  } catch { /* none */ }
  return false;
}

// Return to the zone-selection map between attempts (Back; else reload the event).
async function gotoZoneMap(page, redColor) {
  try { await page.goBack({ waitUntil: 'domcontentloaded', timeout: 6000 }); } catch { /* no history */ }
  await delay(700);
  const onMap = await page.evaluate(pageFindRedZone, { targetColor: redColor, targetNums: TARGET_ZONES, tol: COLOR_TOL }).catch(() => null);
  if (onMap == null) await safeGoto(page, EVENT_URL);
  await page.evaluate(() => document.querySelectorAll('[data-grab-zone]').forEach((e) => e.removeAttribute('data-grab-zone'))).catch(() => {});
}

// Grab up to `maxAdd` available seats in the CURRENT zone. For each seat:
// click it → popup → click "Сагслах" (with a couple retries) → repeat. Returns
// how many made it into the cart. Bails fast on a full zone (3 empty scans).
export async function pickAvailableSeats(page, tag, availColor, maxAdd, slot = 0, total = 1) {
  let added = 0;
  let emptyScans = 0;
  const seatDeadline = Date.now() + SEAT_PASS_MS;
  while (Date.now() < seatDeadline && added < maxAdd) {
    // Stride by `total`: account `slot` prefers seat positions slot, slot+total,
    // slot+2·total, … so concurrent accounts don't fight over the same seat.
    const offset = slot + added * total;
    const n = await page.evaluate(pageTagSeats, { availColor, tol: COLOR_TOL, max: 1, offset }).catch(() => 0);
    if (n > 0) {
      emptyScans = 0;
      let ok = false;
      for (let attempt = 0; attempt < 2 && !ok; attempt++) {
        try {
          // SVG seats can sit under a zoom/pan wrapper that intercepts trusted
          // clicks — fall back to a dispatched DOM click that still fires the
          // seat's handler.
          try { await page.click('[data-grab-seat="1"]', { timeout: 2500 }); }
          catch { await page.dispatchEvent('[data-grab-seat="1"]', 'click'); }
          await delay(400);                          // let the seat popup render
          if (await clickSagslah(page)) { ok = true; break; }
          await delay(400);                          // popup slow? retry the button
          if (await clickSagslah(page)) { ok = true; break; }
        } catch { /* seat/popup vanished; re-scan */ }
      }
      if (ok) {
        added++;
        console.log(`  🛒 ${tag} added seat ${added}/${maxAdd} to cart (Сагслах)`);
        await delay(600);                            // let the cart update / popup close
      }
      await page.evaluate(() => document.querySelectorAll('[data-grab-seat]').forEach((e) => e.removeAttribute('data-grab-seat'))).catch(() => {});
    } else {
      if (++emptyScans >= 3) break;                  // zone full — move on
      await delay(400);
    }
  }
  return added;
}

// One full sweep of the target zones. Returns seats carted this pass + which zone.
// The sweep order is ROTATED by `slot` so parallel accounts start in different
// zones (all zones are still covered — coverage is preserved, only the start
// point differs), which keeps them from colliding on the same seats.
async function grabPass(page, tag, redColor, availColor, deadline, need, probeRef, slot = 0, total = 1) {
  let carted = 0, usedZone = null, sawAnyZone = false;
  const z = TARGET_ZONES.length;
  const rot = z ? (((slot % z) + z) % z) : 0;
  const zones = TARGET_ZONES.slice(rot).concat(TARGET_ZONES.slice(0, rot));
  for (const zoneN of zones) {
    if (Date.now() >= deadline || carted >= need) break;

    // open this specific zone (poll briefly in case it's still rendering)
    let clicked = false;
    const zoneDeadline = Math.min(deadline, Date.now() + ZONE_OPEN_MS);
    while (Date.now() < zoneDeadline && !clicked) {
      const found = await page.evaluate(pageFindRedZone, { targetColor: redColor, targetNums: [zoneN], tol: COLOR_TOL }).catch(() => null);
      if (found != null) {
        sawAnyZone = true;
        await page.click('[data-grab-zone]', { timeout: 4000 }).catch(() => {});
        clicked = true;
      } else {
        await delay(ZONE_POLL_MS);
      }
    }
    if (!clicked) continue;

    console.log(`  🎯 ${tag} opened zone ${zoneN} — scanning for available seats…`);
    await delay(1_200); // let the seat grid render

    if (DEBUG && !probeRef.done) {
      probeRef.done = true;
      const probe = await page.evaluate(pageProbeSelectors).catch(() => null);
      if (probe) {
        fs.writeFileSync(path.join(SHOTS_DIR, `${tag}-selectors.json`), JSON.stringify(probe, null, 2), 'utf8');
        console.log(`  🔬 ${tag} selectors dumped → grab-shots/${tag}-selectors.json`);
      }
    }

    const got = await pickAvailableSeats(page, tag, availColor, need - carted, slot, total);
    carted += got;
    if (got > 0 && usedZone == null) usedZone = zoneN;
    if (carted >= need) break;

    await gotoZoneMap(page, redColor); // full zone → next zone
  }
  return { carted, usedZone, sawAnyZone };
}

// ── Per-account driver: WATCH → GRAB → HOLD, crash-proof ───────────
async function grabForAccount(acc, slot = 0, total = 1) {
  const userDataDir = path.join(PROFILES_DIR, `enaadam-account-${acc.index}`);
  if (!fs.existsSync(userDataDir)) return { acc, status: 'no_profile' };

  const tag = `acc${acc.index}`;
  const deadline = Date.now() + RUN_BUDGET_MS;
  const probeRef = { done: false };
  let context = null, page = null;
  let carted = 0, usedZone = null;
  let calibrated = false, redColor = TARGET_COLOR, availColor = STATUS_COLORS.available;
  let everLive = false;
  let warnedLogin = false, loggedOut = false, diagnosed = false;
  const startedAt = Date.now();
  let lastBeat = startedAt;

  async function ensureBrowser() {
    if (page && !page.isClosed()) return;
    try { await context?.close(); } catch { /* */ }
    context = await chromium.launchPersistentContext(userDataDir, {
      headless: HEADLESS, viewport: { width: 1366, height: 900 }, userAgent: UA,
    });
    page = context.pages()[0] || (await context.newPage());
    page.setDefaultNavigationTimeout(NAV_TIMEOUT);
    page.setDefaultTimeout(ACTION_TIMEOUT);
  }

  try {
    await ensureBrowser();
    await safeGoto(page, EVENT_URL);

    while (Date.now() < deadline && carted < MAX_TICKETS) {
      try {
        if (!page || page.isClosed()) { await ensureBrowser(); await safeGoto(page, EVENT_URL); }

        // ── PHASE 1: WATCH ── reload until the seat map is live ──────
        const live = await page.evaluate(pageEventLive).catch(() => false);
        if (!live) {
          // Why not live? Tell "logged out / on /auth" apart from "not published
          // yet / skeleton" so a dead session can't masquerade as a normal wait.
          const onAuth = /\/auth(\/|$)/.test(page.url());
          const authed = onAuth ? false : await isLoggedIn(page).catch(() => true);
          loggedOut = !authed;
          if (loggedOut && !warnedLogin) {
            warnedLogin = true;
            console.log(`  🔴 ${tag} NOT LOGGED IN (session expired or on /auth). Log in in this window, or run:  node enaadam-login.js ${acc.index}`);
          }
          if (!loggedOut) warnedLogin = false; // recovered — operator logged in
          const now = Date.now();
          if (now - lastBeat >= STATUS_EVERY_MS) {
            lastBeat = now;
            console.log(`  ⏳ ${tag} ${loggedOut ? 'WAITING FOR LOGIN' : 'watching for go-live'} — ${((now - startedAt) / 60000).toFixed(1)}m elapsed`);
          }
          await safeGoto(page, EVENT_URL);
          await delay(WATCH_POLL_MS + Math.floor(Math.random() * 400));
          continue;
        }
        if (!everLive) {
          everLive = true;
          const startZone = TARGET_ZONES[((slot % TARGET_ZONES.length) + TARGET_ZONES.length) % TARGET_ZONES.length];
          console.log(`  🟢 ${tag} event is LIVE — grabbing (starts at zone ${startZone}, seat stride ${total})`);
        }

        // ── self-calibrate colors once ──────────────────────────────
        if (!calibrated) {
          const c = await page.evaluate(pageCalibrate).catch(() => null);
          if (c && c.redTier) redColor = c.redTier;
          if (c && c.available) availColor = c.available;
          calibrated = true;
          console.log(`  🎨 ${tag} colors — red=${redColor}${c && c.redTier ? '' : ' (fallback)'} | avail=${availColor}${c && c.available ? '' : ' (fallback)'}`);
        }

        // ── PHASE 2: GRAB ── one sweep of the zones ─────────────────
        const pass = await grabPass(page, tag, redColor, availColor, deadline, MAX_TICKETS - carted, probeRef, slot, total);
        carted += pass.carted;
        if (pass.usedZone != null && usedZone == null) usedZone = pass.usedZone;
        if (carted >= MAX_TICKETS) break;

        // Real-time debug: LIVE but no RED target zone was found → almost always a
        // selector/color mismatch vs the real DOM. Dump everything needed to fix
        // it fast (screenshot + DOM + the actual seat/button selectors), once.
        if (everLive && !pass.sawAnyZone && carted === 0 && !diagnosed) {
          diagnosed = true;
          console.log(`  🔬 ${tag} LIVE but found NO red target zone — likely a selector/color mismatch. Dumping diagnostics…`);
          await shot(page, `${tag}-no-zone.png`);
          try { fs.writeFileSync(path.join(SHOTS_DIR, `${tag}-dom.html`), await page.content(), 'utf8'); } catch { /* */ }
          const probe = await page.evaluate(pageProbeSelectors).catch(() => null);
          if (probe) { try { fs.writeFileSync(path.join(SHOTS_DIR, `${tag}-selectors.json`), JSON.stringify(probe, null, 2), 'utf8'); } catch { /* */ } }
          console.log(`  🔬 ${tag} wrote grab-shots/${tag}-no-zone.png + ${tag}-dom.html + ${tag}-selectors.json — share these to fix selectors fast.`);
        }

        // didn't fill up — refresh for fresh availability and sweep again.
        // (No cart yet → hard reload; some carted → soft back-nav to protect it.)
        if (carted === 0) { await safeGoto(page, EVENT_URL); await delay(WATCH_POLL_MS); }
        else { await gotoZoneMap(page, redColor); }
      } catch (inner) {
        console.log(`  ⚠️  ${tag} recovered: ${(inner?.message || inner).toString().slice(0, 80)}`);
        try { if (!page || page.isClosed()) await ensureBrowser(); } catch { /* */ }
        await delay(800);
      }
    }

    await shot(page, `${tag}-final.png`);
    if (DEBUG && carted === 0) {
      try { fs.writeFileSync(path.join(SHOTS_DIR, `${tag}-dom.html`), await page.content(), 'utf8'); } catch { /* */ }
    }

    if (carted > 0) {
      console.log(`  ✅ ${tag} ${carted} seat(s) IN CART (zone ${usedZone}). 💳 PAY NOW — window left open.`);
      return { acc, status: `cart:zone${usedZone}:${carted}seat`, context };
    }
    return { acc, status: everLive ? 'no_seats_in_budget' : (loggedOut ? 'not_logged_in' : 'event_never_live') };
  } catch (e) {
    await shot(page, `${tag}-error.png`).catch(() => {});
    return { acc, status: `error:${(e?.message || e).toString().slice(0, 80)}` };
  } finally {
    // Keep a headful window with a cart OPEN (so you can pay). Close otherwise.
    if (HEADLESS || carted === 0) { try { await context?.close(); } catch { /* */ } }
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

  console.log(`🎟  Grab: ${accounts.length} account(s) | headless=${HEADLESS} | max-tickets=${MAX_TICKETS}`);
  console.log(`   url=${EVENT_URL}`);
  console.log(`   zones=${TARGET_ZONES.join(',')} | budget=${(RUN_BUDGET_MS / 60000).toFixed(0)}min | watch=${WATCH_POLL_MS}ms`);
  if (EVENT_URL === TICKET_URL) {
    console.warn('   ⚠️  EVENT_URL is the bare /ticket page. Set EVENT_URL to the published event URL so WATCH can detect go-live.');
  }

  await waitUntilStart();
  console.log('👀 Watching for the event to go live (refreshing every browser)…');

  // slot = position in the running set, total = how many run in parallel — used
  // to spread accounts across zones/seats so they don't collide on the same seat.
  const settledRaw = await Promise.allSettled(accounts.map((acc, i) => grabForAccount(acc, i, accounts.length)));
  const results = settledRaw.map((r, i) =>
    r.status === 'fulfilled' ? r.value : { acc: accounts[i], status: `crash:${(r.reason?.message || r.reason).toString().slice(0, 60)}` });

  console.log('\n──── Grab summary ────');
  for (const r of results) {
    const icon = r.status.startsWith('cart:') ? '✅'
      : r.status === 'not_logged_in' ? '🔴'
      : r.status.startsWith('error') || r.status.startsWith('crash') ? '💥' : '·';
    console.log(`  ${icon} acc${r.acc.index} (${r.acc.mobile}): ${r.status}`);
  }
  const carted = results.filter((r) => r.status.startsWith('cart:'));
  const loggedOut = results.filter((r) => r.status === 'not_logged_in');
  console.log(`\n🧾 ${carted.length}/${accounts.length} reached cart. Screenshots in grab-shots/.`);
  if (loggedOut.length > 0) {
    console.log(`🔴 ${loggedOut.length} account(s) were NOT LOGGED IN: ${loggedOut.map((r) => `acc${r.acc.index}`).join(', ')}`);
    console.log(`   Fix: node enaadam-login.js ${loggedOut.map((r) => r.acc.index).join(' ')}`);
  }

  // HOLD: keep the carted (headful) windows open until you close them — pay there.
  const open = results.filter((r) => r.context);
  if (open.length > 0 && !HEADLESS) {
    console.log('\n════════════════════════════════════════════════════');
    console.log(`💳 PAY NOW — ${open.length} window(s) are OPEN with seats in the cart:`);
    for (const r of open) console.log(`     • acc${r.acc.index} (${r.acc.mobile}) — ${r.status}`);
    console.log('   Switch to each browser window and complete payment.');
    console.log('   This console stays alive until you CLOSE every paid window.');
    console.log('════════════════════════════════════════════════════');
    await Promise.all(open.map((r) => new Promise((res) => r.context.on('close', res))));
    console.log('✅ All carted windows closed. Exiting.');
  } else if (carted.length === 0) {
    console.log('\nNo seats were carted this run. If the event WAS live, check grab-shots/*-no-zone.* for selector mismatches.');
  }
}

// Only auto-run when invoked directly (`node enaadam-grab.js`). When imported
// (e.g. by the offline test) the scanners/helpers are reused without launching.
const invokedDirectly = process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href;
if (invokedDirectly) main().catch((e) => { console.error(e); process.exit(1); });
