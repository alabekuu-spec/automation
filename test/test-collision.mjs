// Multi-account collision test for the enaadam ticket grabber.
//
// Launches N independent browser contexts (one per "account") against the local
// mock ../naadam-stadium.html, forces them all into the SAME zone (worst case for
// contention), and runs the REAL pickAvailableSeats from ../enaadam-grab.js with a
// per-account slot + total. It then reads each account's carted seats and asserts
// they are DISJOINT — i.e. the zone-rotation + seat-stride logic keeps parallel
// accounts off each other's seats.
//
// Note: each context has its own (identical) client-side state, so this verifies
// the SELECTION logic deterministically. The live site adds server-side seat locks
// on top, which only helps further.
//
// Usage (from the project root):
//   node test/test-collision.mjs            # 3 accounts, headless
//   ACCOUNTS=4 node test/test-collision.mjs
//   HEADLESS=false node test/test-collision.mjs
//
import path from 'node:path';
import fs from 'node:fs';
import url from 'node:url';
import { chromium } from 'playwright';
import { TARGET_COLOR, STATUS_COLORS } from '../enaadam-zones.mjs';
import { pageCalibrate, pageFindRedZone, pickAvailableSeats } from '../enaadam-grab.js';

const HERE = path.dirname(url.fileURLToPath(import.meta.url));
const HTML = path.resolve(HERE, '..', 'naadam-stadium.html');
const PAGE_URL = url.pathToFileURL(HTML).href;
const HEADLESS = process.env.HEADLESS !== 'false';
const N = Number(process.env.ACCOUNTS || 3);
const ZONE = Number(process.env.ZONE || 1);       // force everyone into one zone
const PER_ACCOUNT = Number(process.env.MAX_TICKETS || 2);
const COLOR_TOL = 16;
const delay = (ms) => new Promise((r) => setTimeout(r, ms));

// Read this context's carted seats as "sector:row:seat" keys.
function readCartKeys() {
  const out = [];
  for (const row of document.querySelectorAll('#cart-area .cart-row')) {
    const sec = row.querySelector('.cart-info strong');
    const small = row.querySelector('.cart-info .small');
    if (!sec || !small) continue;
    const s = (sec.textContent || '').replace(/\D/g, '');
    const m = /Эгнээ\s*(\d+).*Суудал\s*(\d+)/.exec(small.textContent || '');
    if (s && m) out.push(`${s}:${m[1]}:${m[2]}`);
  }
  return out;
}

async function runAccount(browser, slot) {
  const tag = `acc${slot}`;
  const ctx = await browser.newContext({ viewport: { width: 1366, height: 900 } });
  const page = await ctx.newPage();
  await page.goto(PAGE_URL, { waitUntil: 'domcontentloaded', timeout: 30_000 });
  await delay(800);

  const cal = await page.evaluate(pageCalibrate).catch(() => null);
  const redColor = cal && cal.redTier ? cal.redTier : TARGET_COLOR;
  const availColor = cal && cal.available ? cal.available : STATUS_COLORS.available;

  // open the shared target zone
  const zoneN = await page.evaluate(pageFindRedZone, { targetColor: redColor, targetNums: [ZONE], tol: COLOR_TOL }).catch(() => null);
  if (zoneN != null) await page.click('[data-grab-zone]', { timeout: 4000 }).catch(() => {});
  await delay(1_200);

  // REAL seat-grab with this account's slot + total
  const carted = await pickAvailableSeats(page, tag, availColor, PER_ACCOUNT, slot, N);
  const keys = await page.evaluate(readCartKeys).catch(() => []);
  await ctx.close().catch(() => {});
  return { tag, slot, carted, keys };
}

async function run() {
  if (!fs.existsSync(HTML)) { console.error(`❌ Local page not found: ${HTML}`); process.exit(1); }
  console.log(`🧪 Collision test — ${N} accounts, all forced into zone ${ZONE}, ${PER_ACCOUNT} seats each`);
  console.log(`   ${PAGE_URL}\n`);

  const browser = await chromium.launch({ headless: HEADLESS });
  let accounts = [];
  try {
    // run all accounts in parallel, exactly like enaadam-grab.js does
    accounts = await Promise.all(Array.from({ length: N }, (_, i) => runAccount(browser, i)));
  } catch (e) {
    console.error('💥 harness error:', e?.message || e);
  } finally {
    await browser.close().catch(() => {});
  }

  for (const a of accounts) console.log(`  ${a.tag}: carted ${a.carted}/${PER_ACCOUNT} → [${a.keys.join(', ')}]`);

  // every account should cart its full quota
  const allCarted = accounts.every((a) => a.carted >= PER_ACCOUNT);
  // and no seat key may appear for two different accounts
  const seen = new Map(); // key -> tag
  const clashes = [];
  for (const a of accounts) for (const k of a.keys) {
    if (seen.has(k)) clashes.push(`${k} taken by both ${seen.get(k)} and ${a.tag}`);
    else seen.set(k, a.tag);
  }

  console.log(`\n──── Collision summary ────`);
  console.log(`  ${allCarted ? '✅' : '❌'} every account carted ${PER_ACCOUNT} seat(s)`);
  console.log(`  ${clashes.length === 0 ? '✅' : '❌'} all seats disjoint across accounts (${seen.size} unique seats)`);
  for (const c of clashes) console.log(`     ⚠️  ${c}`);

  const ok = allCarted && clashes.length === 0;
  console.log(`\n${ok ? '✅ PASS — no two accounts grabbed the same seat.' : '❌ FAIL — see clashes above.'}`);
  process.exit(ok ? 0 : 1);
}

run();
