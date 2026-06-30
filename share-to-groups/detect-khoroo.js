// Read-only: open account 2, visit every group in workinggroups.txt, read its
// real name (page <title> + h1), and classify by khoroo number (18 / 19 / other).
// Writes the result to khoroo-map.json so we can review before posting.
//
// Usage (from project root):
//   node share-to-groups/detect-khoroo.js
//   node share-to-groups/detect-khoroo.js 2     # account index (default 2)

import 'dotenv/config';
import path from 'node:path';
import fs from 'node:fs';
import { chromium } from 'playwright';
import { getAccounts } from '../accounts.mjs';
import { performFacebookLogin, delay } from '../lib/facebook-login.mjs';
import { loadGroups } from '../groups.mjs';

const UA =
  'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/124.0.0.0 Safari/537.36';

const GROUPS_FILE = process.env.GROUPS_FILE || 'workinggroups.txt';
const PROFILES_DIR = path.resolve('./profiles');
const OUT_FILE = path.resolve('./khoroo-map.json');
const ACCOUNT_INDEX = Number(process.argv[2]) || 2;

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

// Pull the most reliable name strings off the group page.
async function readGroupName(page) {
  const data = await page.evaluate(() => {
    const title = document.title || '';
    const og = document.querySelector('meta[property="og:title"]')?.content || '';
    let h1 = '';
    const h1el = document.querySelector('h1');
    if (h1el) h1 = (h1el.textContent || '').trim();
    return { title, og, h1 };
  }).catch(() => ({ title: '', og: '', h1: '' }));
  return data;
}

// Decide the khoroo number from any of the name strings.
// Matches "18", "18-р", "18 р", "18р хороо", "18-р хороо", "18-р хороонд", etc.
// Also matches latin "suhbaatar18horoo" style handles.
function classifyKhoroo(strings) {
  const hay = strings.join(' ').toLowerCase();
  // Prefer an explicit "<num> хороо" / "<num>р хороо" / "<num>-р хороо" pattern.
  const cyr = hay.match(/(\d{1,2})\s*-?\s*р?\s*хороо/);
  if (cyr) return Number(cyr[1]);
  // Latin handle style: suhbaatar18horoo / sukhbaatar19horoo
  const lat = hay.match(/(?:suh|sukh)baatar\s*(\d{1,2})\s*horoo/);
  if (lat) return Number(lat[1]);
  // "horoo 18" / "хороо 18"
  const post = hay.match(/(?:хороо|horoo)\s*(\d{1,2})/);
  if (post) return Number(post[1]);
  return null;
}

async function main() {
  const acc = getAccounts().find((a) => a.index === ACCOUNT_INDEX);
  if (!acc) {
    console.error(`❌ No account ${ACCOUNT_INDEX} in .env`);
    process.exit(1);
  }
  const groups = loadGroups(GROUPS_FILE);
  if (!groups.length) {
    console.error(`❌ No groups in ${GROUPS_FILE}`);
    process.exit(1);
  }

  const userDataDir = path.join(PROFILES_DIR, `account-${acc.index}`);
  console.log(`▶ Detecting khoroo for ${groups.length} group(s) using account ${acc.index} (${acc.email})`);

  const context = await chromium.launchPersistentContext(userDataDir, {
    headless: false,
    slowMo: 20,
    viewport: { width: 1280, height: 800 },
    userAgent: UA,
  });
  const page = context.pages()[0] || (await context.newPage());
  page.setDefaultNavigationTimeout(45_000);

  const results = [];
  try {
    await page.goto('https://www.facebook.com/', { waitUntil: 'domcontentloaded' });
    await delay(2_000);
    if (!(await isLoggedIn(page))) {
      console.log('🔐 Session not valid — logging in…');
      await performFacebookLogin(page, {
        email: acc.email, password: acc.password, totpSecret: acc.totpSecret, index: acc.index,
      });
    } else {
      console.log('✅ Session valid');
    }

    for (const g of groups) {
      try {
        await page.goto(g.url, { waitUntil: 'domcontentloaded', timeout: 30_000 });
      } catch (e) {
        console.log(`  🚫 ${g.id.padEnd(28)} nav_failed`);
        results.push({ id: g.id, url: g.url, name: '', khoroo: null, status: 'nav_failed' });
        continue;
      }
      await delay(2_200);
      const names = await readGroupName(page);
      const khoroo = classifyKhoroo([names.title, names.og, names.h1, g.id]);
      const best = (names.h1 || names.og || names.title || '').replace(/\s+/g, ' ').slice(0, 60);
      const tag = khoroo === 18 ? '🟢18' : khoroo === 19 ? '🔵19' : khoroo ? `  ${khoroo}` : ' ??';
      console.log(`  ${tag}  ${g.id.padEnd(28)} ${best}`);
      results.push({ id: g.id, url: g.url, name: best, khoroo, status: 'ok' });
      await delay(700 + Math.random() * 900);
    }
  } finally {
    try { await context.close(); } catch { /* ignore */ }
  }

  fs.writeFileSync(OUT_FILE, JSON.stringify(results, null, 2));
  const k18 = results.filter((r) => r.khoroo === 18);
  const k19 = results.filter((r) => r.khoroo === 19);
  const unknown = results.filter((r) => r.khoroo == null && r.status === 'ok');

  console.log('\n──── Classification ────');
  console.log(`🟢 18р хороо (${k18.length}): ${k18.map((r) => r.id).join(', ') || '—'}`);
  console.log(`🔵 19р хороо (${k19.length}): ${k19.map((r) => r.id).join(', ') || '—'}`);
  console.log(`❓ unknown (${unknown.length}): ${unknown.map((r) => r.id).join(', ') || '—'}`);
  console.log(`\n💾 Wrote ${OUT_FILE} — review it, then we post.`);
}

main().catch((e) => { console.error(e); process.exit(1); });
