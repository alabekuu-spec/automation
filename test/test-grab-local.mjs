// Offline test for the enaadam ticket grabber.
//
// Imports and runs the ACTUAL functions from ../enaadam-grab.js against the local
// mock page ../naadam-stadium.html (a file:// URL) — no login, no profiles, no
// live event. Because it exercises the real exported scanners/helpers (not copies),
// a green run means the production grab logic works on a rendered seat map.
//
// Usage (from the project root, with Node on PATH):
//   node test/test-grab-local.mjs
//   HEADLESS=true node test/test-grab-local.mjs
//
import path from 'node:path';
import fs from 'node:fs';
import url from 'node:url';
import { chromium } from 'playwright';
import { TARGET_COLOR, TARGET_ZONES, STATUS_COLORS } from '../enaadam-zones.mjs';
import {
  pageEventLive,
  pageCalibrate,
  pageFindRedZone,
  pageTagSeats,
  pickAvailableSeats,
} from '../enaadam-grab.js';

const HERE = path.dirname(url.fileURLToPath(import.meta.url));
const HTML = path.resolve(HERE, '..', 'naadam-stadium.html');
const PAGE_URL = url.pathToFileURL(HTML).href;
const HEADLESS = process.env.HEADLESS === 'true';
const COLOR_TOL = Number(process.env.COLOR_TOL || 16);
const MAX_TICKETS = Number(process.env.MAX_TICKETS || 2);
const delay = (ms) => new Promise((r) => setTimeout(r, ms));

const results = [];
function record(stage, ok, detail) {
  results.push({ stage, ok, detail });
  console.log(`  ${ok ? '✅ PASS' : '❌ FAIL'}  ${stage}${detail ? ` — ${detail}` : ''}`);
}
function note(msg) { console.log(`  ·       ${msg}`); }

async function run() {
  if (!fs.existsSync(HTML)) { console.error(`❌ Local page not found: ${HTML}`); process.exit(1); }
  console.log(`🧪 Offline grab test (real enaadam-grab.js functions) against:`);
  console.log(`   ${PAGE_URL}`);
  console.log(`   headless=${HEADLESS} | target-zones=${TARGET_ZONES.join(',')} | red=${TARGET_COLOR}\n`);

  const browser = await chromium.launch({ headless: HEADLESS });
  const page = await browser.newPage({ viewport: { width: 1366, height: 900 } });
  let carted = 0;

  try {
    await page.goto(PAGE_URL, { waitUntil: 'domcontentloaded', timeout: 30_000 });
    await delay(800); // let the SVG seat map render

    console.log('GRAB FLOW (production code)');

    // 1 — liveness
    const live = await page.evaluate(pageEventLive).catch(() => false);
    record('detect seat map live (pageEventLive)', !!live, live ? 'map rendered' : 'no map');

    // 2 — color self-calibration from the legend
    const cal = await page.evaluate(pageCalibrate).catch(() => null);
    const redColor = cal && cal.redTier ? cal.redTier : TARGET_COLOR;
    const availColor = cal && cal.available ? cal.available : STATUS_COLORS.available;
    record('self-calibrate colors (pageCalibrate)', !!(cal && cal.redTier && cal.available),
      `red=${redColor}${cal && cal.redTier ? '' : ' (fallback)'} | avail=${availColor}${cal && cal.available ? '' : ' (fallback)'}`);

    // 3 — find + open a RED target zone (layered finder)
    const zoneN = await page.evaluate(pageFindRedZone, { targetColor: redColor, targetNums: TARGET_ZONES, tol: COLOR_TOL }).catch(() => null);
    if (zoneN != null) await page.click('[data-grab-zone]', { timeout: 4000 }).catch(() => {});
    record('find + open a RED target zone (pageFindRedZone)', zoneN != null,
      zoneN != null ? `opened zone ${zoneN}` : 'no red target zone matched');

    if (zoneN != null) {
      await delay(1_200); // let the seat grid render

      // 4 — available (teal) seats are detectable
      const seatsSeen = await page.evaluate(pageTagSeats, { availColor, tol: COLOR_TOL, max: 5 }).catch(() => 0);
      await page.evaluate(() => document.querySelectorAll('[data-grab-seat]').forEach((e) => e.removeAttribute('data-grab-seat'))).catch(() => {});
      record('find available teal seats (pageTagSeats)', seatsSeen > 0, `${seatsSeen} teal seat(s) detected`);

      // 5 — full seat → Сагслах cart flow (the real pickAvailableSeats)
      carted = await pickAvailableSeats(page, 'test', availColor, MAX_TICKETS);
      record(`seat → Сагслах cart flow (target ${MAX_TICKETS})`, carted >= MAX_TICKETS, `${carted}/${MAX_TICKETS} carted`);

      // 6 — the page reflects the selection (selected seats turn dark blue)
      const selected = await page.evaluate(() =>
        [...document.querySelectorAll('.seat')].filter((s) => /26,\s*58,\s*165/.test(getComputedStyle(s).fill)).length
      ).catch(() => -1);
      record('cart reflects selection (seats marked selected)', selected >= carted && carted > 0, `${selected} seat(s) shown selected`);
    }

    const shotPath = path.join(HERE, 'test-result.png');
    await page.screenshot({ path: shotPath, fullPage: true }).catch(() => {});
    note(`screenshot → ${path.relative(process.cwd(), shotPath)}`);
  } catch (e) {
    console.error('💥 harness error:', e?.message || e);
  } finally {
    if (!HEADLESS) { note('leaving the window open 4s so you can see the result…'); await delay(4_000); }
    await browser.close().catch(() => {});
  }

  const passed = results.filter((r) => r.ok).length;
  console.log(`\n──── Test summary ────`);
  for (const r of results) console.log(`  ${r.ok ? '✅' : '❌'} ${r.stage}`);
  console.log(`\n${passed}/${results.length} stages passed | ${carted}/${MAX_TICKETS} seats carted on the local mock.`);
  process.exit(passed === results.length && carted >= MAX_TICKETS ? 0 : 1);
}

run();
