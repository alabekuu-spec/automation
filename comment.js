import { chromium } from 'playwright';
import 'dotenv/config';
import { getAccounts } from './accounts.mjs';
import { delay, randomDelay, performFacebookLogin } from './lib/facebook-login.mjs';

// ── Comment text collection ───────────────────────────────────────────────
function getCommentTexts() {
  const texts = [];
  let i = 1;
  while (process.env[`COMMENT_TEXT_${i}`]) {
    texts.push(process.env[`COMMENT_TEXT_${i}`]);
    i++;
  }
  if (texts.length === 0 && process.env.COMMENT_TEXT) {
    texts.push(process.env.COMMENT_TEXT);
  }
  return texts;
}

// ── Balanced, shuffled comment assignment ─────────────────────────────────
function assignComments(accounts, commentTexts) {
  const pool = accounts.map((_, i) => commentTexts[i % commentTexts.length]);
  for (let i = pool.length - 1; i > 0; i--) {
    const j = Math.floor(Math.random() * (i + 1));
    [pool[i], pool[j]] = [pool[j], pool[i]];
  }
  return accounts.map((acc, i) => ({ ...acc, comment: pool[i] }));
}

// ── Validation ────────────────────────────────────────────────────────────
function validateEnv() {
  const errors = [];
  if (getAccounts().length === 0)
    errors.push('No filled-in accounts found. Add FB_EMAIL_1 + FB_PASSWORD_1 (and _2, _3 …) to .env');
  if (!process.env.POST_URL || process.env.POST_URL.includes('XXXXX'))
    errors.push('POST_URL is missing or still a placeholder');
  if (getCommentTexts().length === 0)
    errors.push('No comment text found. Add COMMENT_TEXT_1 to .env');
  if (errors.length > 0) {
    errors.forEach((e) => console.error(`❌ ${e}`));
    process.exit(1);
  }
}

// ── Per-account automation ────────────────────────────────────────────────
async function runAccount({ email, password, totpSecret, index, comment }, total) {
  const postUrl = process.env.POST_URL;
  const mode = totpSecret ? '🤖 auto-2FA' : '✋ manual-2FA';

  console.log(`\n${'─'.repeat(60)}`);
  console.log(`👤 Account ${index}/${total}: ${email}  [${mode}]`);
  console.log(`💬 Comment: ${comment}`);
  console.log('─'.repeat(60));

  const browser = await chromium.launch({ headless: false, slowMo: 50 });
  const context = await browser.newContext({
    viewport: { width: 1280, height: 800 },
    userAgent:
      'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/124.0.0.0 Safari/537.36',
  });
  const page = await context.newPage();
  page.setDefaultNavigationTimeout(60_000);

  let accountSucceeded = false;
  let likeOk = false;
  let shareOk = false;
  let commentOk = false;
  try {
    await performFacebookLogin(page, { email, password, totpSecret, index });

    // ── Navigate to post ───────────────────────────────────────────────────
    console.log(`🔗 Navigating to post: ${postUrl}`);
    await page.goto(postUrl, { waitUntil: 'domcontentloaded' });
    try { await page.waitForLoadState('networkidle', { timeout: 20_000 }); } catch { /* flaky */ }
    await randomDelay(2000, 3000);
    console.log('✅ Post page loaded');

    // ── LIKE ──────────────────────────────────────────────────────────────
    for (let attempt = 0; attempt < 3 && !likeOk; attempt++) {
      if (attempt > 0) {
        console.log(`🔁 Like retry ${attempt + 1}/3…`);
        await delay(1_500);
      }
      try {
        const alreadyLiked = page.locator(
          '[aria-label="Unlike"], [aria-label="Tidak Suka"], [aria-label*="Unlike" i], [aria-label*="Tidak Suka" i]'
        ).first();
        if ((await alreadyLiked.count().catch(() => 0)) > 0) {
          console.log('ℹ️  Post is already liked');
          likeOk = true;
        } else {
          const likeSelectors = [
            '[aria-label="Like"]', '[aria-label="Suka"]',
            '[aria-label*="Like" i]:not([aria-label*="Unlike" i])',
            '[aria-label*="Suka" i]:not([aria-label*="Tidak Suka" i])',
          ];
          let liked = false;
          for (const sel of likeSelectors) {
            try {
              const btn = page.locator(sel).first();
              await btn.waitFor({ state: 'visible', timeout: 5_000 });
              await btn.click();
              liked = true;
              break;
            } catch { /* try next */ }
          }
          if (!liked) {
            await page.getByRole('button', { name: /^(like|suka)$/i }).first()
              .waitFor({ state: 'visible', timeout: 5_000 });
            await page.getByRole('button', { name: /^(like|suka)$/i }).first().click();
          }
          await randomDelay(1000, 2000);
          console.log('✅ Post liked successfully');
          likeOk = true;
        }
      } catch (likeErr) {
        if (attempt === 2) {
          console.error('⚠️  Could not like post after 3 attempts:', likeErr?.message || likeErr);
        }
      }
    }

    // ── SHARE ─────────────────────────────────────────────────────────────
    try {
      // Exclude indicator labels like "Shared with Public", "Shares 42", "Sharing"
      // and the share-count display — those are not actionable buttons.
      const notIndicator =
        ':not([aria-label*="Shared with" i])' +
        ':not([aria-label*="Shares " i])' +
        ':not([aria-label*="Sharing " i])' +
        ':not([aria-label*="Sharing to" i])';
      const shareSelectors = [
        '[aria-label="Send this to friends or post it on your profile."]',
        '[aria-label="Bagikan"]',
        `[aria-label^="Share" i]${notIndicator}`,
        `[aria-label^="Bagikan" i]${notIndicator}`,
        `[aria-label^="Хуваалц" i]${notIndicator}`,
        `[aria-label^="Send" i]${notIndicator}`,
        `[aria-label^="Kirim" i]${notIndicator}`,
        `[role="button"][aria-label*="share" i]${notIndicator}`,
        `[role="button"][aria-label*="bagikan" i]${notIndicator}`,
        `[role="button"][aria-label*="хуваалц" i]${notIndicator}`,
      ];
      let shareBtn = null;
      let matchedSel = null;
      for (const sel of shareSelectors) {
        const candidates = page.locator(sel);
        const cnt = await candidates.count().catch(() => 0);
        if (cnt === 0) continue;
        for (let i = 0; i < Math.min(cnt, 12); i++) {
          const c = candidates.nth(i);
          if (!(await c.isVisible().catch(() => false))) continue;
          // Reject tiny elements — real share button is ≥ 20px on each side;
          // privacy/count indicators are typically 12px icons.
          const box = await c.boundingBox().catch(() => null);
          if (!box || box.width < 20 || box.height < 20) continue;
          shareBtn = c;
          matchedSel = sel;
          break;
        }
        if (shareBtn) break;
      }
      if (!shareBtn) {
        const fb = page.getByRole('button', { name: /share|bagikan|хуваалц/i }).first();
        if ((await fb.count().catch(() => 0)) > 0) {
          shareBtn = fb;
          matchedSel = 'role=button name=/share|bagikan|хуваалц/i';
        }
      }
      if (!shareBtn) throw new Error('No share button matched any selector');
      const btnAria = await shareBtn.getAttribute('aria-label').catch(() => null);
      const btnText = ((await shareBtn.textContent().catch(() => '')) || '').replace(/\s+/g, ' ').trim().slice(0, 60);
      const btnBox = await shareBtn.boundingBox().catch(() => null);
      console.log(`🔍 Share button matched by: ${matchedSel}`);
      console.log(`   aria-label=${JSON.stringify(btnAria)}  text=${JSON.stringify(btnText)}  box=${JSON.stringify(btnBox)}`);
      await shareBtn.waitFor({ state: 'visible', timeout: 10_000 });
      await page.screenshot({ path: `debug-share-preclick-account${index}.png`, fullPage: true }).catch(() => {});
      // Hover first — reels sometimes only enable the icon after hover.
      await shareBtn.hover().catch(() => {});
      await delay(400);
      await shareBtn.click();
      await delay(800);
      await page.screenshot({ path: `debug-share-postclick-account${index}.png`, fullPage: true }).catch(() => {});
      await randomDelay(1_200, 2_400);

      // Diagnostic: capture the dialog state immediately after opening so we
      // can see what the reel-share UI actually looks like.
      await page.screenshot({ path: `debug-share-open-account${index}.png`, fullPage: true }).catch(() => {});
      console.log(`📸 debug-share-open-account${index}.png saved (dialog open)`);
      try {
        const dialogs = page.locator('[role="dialog"], [aria-modal="true"]');
        const n = await dialogs.count();
        let visN = 0;
        for (let i = 0; i < n; i++) {
          if (await dialogs.nth(i).isVisible().catch(() => false)) visN++;
        }
        console.log(`🔍 Dialogs on page: total=${n} visible=${visN}`);
        for (let i = 0; i < n; i++) {
          const d = dialogs.nth(i);
          if (!(await d.isVisible().catch(() => false))) continue;
          const clickable = d.locator('[role="button"], [role="menuitem"], [role="link"], button, a');
          const bn = await clickable.count();
          const labels = [];
          for (let j = 0; j < Math.min(bn, 40); j++) {
            const b = clickable.nth(j);
            if (!(await b.isVisible().catch(() => false))) continue;
            const aria = await b.getAttribute('aria-label').catch(() => null);
            const role = await b.getAttribute('role').catch(() => null);
            const text = ((await b.textContent().catch(() => '')) || '').replace(/\s+/g, ' ').trim().slice(0, 50);
            labels.push(`[${role || 'button'}] aria=${JSON.stringify(aria)} text=${JSON.stringify(text)}`);
          }
          console.log(`🔍 Dialog ${i} clickables (${labels.length}/${bn}):\n    ${labels.join('\n    ')}`);
        }
      } catch (e) {
        console.log('🔍 Dialog inspection failed:', e?.message || e);
      }

      // Share icon sometimes opens a menu; pick timeline / feed before composer.
      try {
        const menuPatterns = [
          /share.*news feed/i,
          /share.*feed/i,
          /bagikan.*beranda/i,
          /bagikan.*feed/i,
          /news feed/i,
          /beranda/i,
          /your feed/i,
          /timeline/i,
          /profil/i,
        ];
        for (const pattern of menuPatterns) {
          const mi = page.getByRole('menuitem', { name: pattern }).first();
          if ((await mi.count()) === 0) continue;
          await mi.click({ timeout: 5_000 });
          await delay(1_000);
          break;
        }
      } catch { /* no intermediate menu */ }

      // Composer may not be `role="dialog"[0]` — cookie UIs also use dialogs.
      async function resolveShareComposerRoot() {
        const looksLike = /share|bagikan|post|beranda|news feed|buat postingan|create post/i;
        let d = page.locator('[role="dialog"]').filter({ hasText: looksLike }).first();
        if ((await d.count()) > 0 && (await d.isVisible().catch(() => false))) return d;
        d = page.locator('[aria-modal="true"]').filter({ hasText: looksLike }).first();
        if ((await d.count()) > 0 && (await d.isVisible().catch(() => false))) return d;
        const allDialogs = page.locator('[role="dialog"]');
        const n = await allDialogs.count();
        for (let i = n - 1; i >= 0; i--) {
          const one = allDialogs.nth(i);
          if (await one.isVisible().catch(() => false)) return one;
        }
        return page;
      }

      const root = await resolveShareComposerRoot();
      if (root !== page) {
        await root.waitFor({ state: 'visible', timeout: 15_000 }).catch(() => {});
      }
      await delay(500);

      async function pickTimelineDestination(scope) {
        for (const pattern of [
          /share to your feed/i,
          /share to news feed/i,
          /bagikan ke (beranda|news feed)/i,
          /bagikan di beranda/i,
          /^news feed$/i,
          /^beranda$/i,
        ]) {
          for (const role of ['menuitem', 'button']) {
            try {
              const o = scope.getByRole(role, { name: pattern }).first();
              if ((await o.count()) === 0) continue;
              await o.click({ timeout: 3_000 });
              await delay(600);
              return;
            } catch { /* next */ }
          }
        }
      }
      await pickTimelineDestination(root);

      const primaryNames = [
        /^share now$/i,
        /^post$/i,
        /^posting$/i,
        /^bagikan$/i,
        /bagikan sekarang/i,
        /share to your feed/i,
        /share to news feed/i,
        /bagikan ke (news feed|beranda|profil)/i,
        /bagikan di (news feed|profil|beranda)/i,
        /terbitkan/i,
        /publikasikan/i,
      ];

      async function tryClickShareConfirm(scope) {
        for (const pattern of primaryNames) {
          for (const role of ['button', 'menuitem']) {
            try {
              const el = scope.getByRole(role, { name: pattern }).first();
              if ((await el.count()) === 0) continue;
              await el.waitFor({ state: 'visible', timeout: 4_000 });
              await el.click();
              return true;
            } catch { /* next */ }
          }
        }
        // Text nodes (Facebook often uses div[role="button"] without clean name)
        for (const t of [
          'Share now',
          'Bagikan sekarang',
          'Posting',
          'Post',
          'Share to News Feed',
          'Bagikan ke News Feed',
        ]) {
          try {
            let el = scope.getByText(t, { exact: true }).first();
            if ((await el.count()) === 0)
              el = scope.getByText(t, { exact: false }).first();
            if ((await el.count()) === 0) continue;
            await el.waitFor({ state: 'visible', timeout: 3_000 });
            await el.click();
            return true;
          } catch { /* next */ }
        }
        // Last resort: scan primary-looking buttons in composer
        try {
          const candidates = scope.locator(
            '[data-testid*="primary" i], div[role="button"][tabindex="0"]'
          );
          const n = await candidates.count();
          for (let i = n - 1; i >= 0; i--) {
            const c = candidates.nth(i);
            const txt = ((await c.textContent()) || '').replace(/\s+/g, ' ').trim();
            if (/post|share|bagikan|posting|terbitkan|publikasikan/i.test(txt)
              && !/undo|batal|cancel|hapus/i.test(txt)) {
              await c.click({ timeout: 5_000 });
              return true;
            }
          }
        } catch { /* no */ }
        try {
          const blue = scope.locator('div[role="button"]').filter({
            hasText: /^(Post|Posting|Share now|Bagikan sekarang)$/i,
          }).first();
          if ((await blue.count()) > 0) {
            await blue.click({ timeout: 5_000 });
            return true;
          }
        } catch { /* no */ }
        try {
          const postByAria = scope.locator(
            '[aria-label="Post"], [aria-label="Posting"], [aria-label*="Post to" i], '
              + '[aria-label*="Bagikan sekarang" i], [aria-label*="Share now" i]'
          ).first();
          if ((await postByAria.count()) > 0 && await postByAria.isVisible().catch(() => false)) {
            await postByAria.click({ timeout: 5_000 });
            return true;
          }
        } catch { /* no */ }
        return false;
      }

      let shared = false;
      for (let attempt = 0; attempt < 5 && !shared; attempt++) {
        if (attempt > 0) await delay(1_600);
        const activeRoot = await resolveShareComposerRoot();
        shared = await tryClickShareConfirm(activeRoot);
        if (!shared) shared = await tryClickShareConfirm(page);
      }

      if (!shared) {
        const shot = `debug-share-account${index}.png`;
        await page.screenshot({ path: shot, fullPage: true }).catch(() => {});
        console.error(`📸 ${shot} — URL: ${page.url()}`);
        throw new Error('Could not find Share now / Post in share dialog');
      }

      await delay(3_000);
      console.log('✅ Post shared to profile successfully');
      shareOk = true;
    } catch (shareErr) {
      console.error('⚠️  Could not share post:', shareErr?.message || shareErr);
      try {
        await page.keyboard.press('Escape');
        await delay(350);
        await page.keyboard.press('Escape');
        await delay(500);
      } catch { /* page may be gone */ }
    }

    // ── COMMENT ───────────────────────────────────────────────────────────
    for (let attempt = 0; attempt < 3 && !commentOk; attempt++) {
      if (attempt > 0) {
        console.log(`🔁 Comment retry ${attempt + 1}/3…`);
        await delay(1_500);
      }
      try {
        if (page.isClosed()) {
          console.error('⚠️  Page closed before comment — cannot post (did the browser window close?)');
          throw new Error('Page closed before comment');
        }
        const commentBoxSel =
          'div[contenteditable="true"][aria-label*="comment" i], ' +
          'div[contenteditable="true"][aria-label*="komentar" i], ' +
          'div[contenteditable="true"][role="textbox"]';

        let commentBox = page.locator(commentBoxSel).first();
        if (!(await commentBox.isVisible().catch(() => false))) {
          // Reel layout: open the comment panel first
          for (const sel of [
            '[aria-label="Comment"]', '[aria-label="Komentar"]',
            '[aria-label*="Comment" i]', '[aria-label*="Komentar" i]',
          ]) {
            try {
              const icon = page.locator(sel).first();
              if ((await icon.count().catch(() => 0)) > 0) {
                await icon.click();
                await delay(1_500);
                break;
              }
            } catch { /* try next */ }
          }
          commentBox = page.locator(commentBoxSel).first();
        }

        await commentBox.waitFor({ state: 'visible', timeout: 10_000 });
        await commentBox.click();
        await delay(1000);
        await page.keyboard.type(comment, { delay: 50 });
        await delay(1000);
        await page.keyboard.press('Enter');
        await delay(3000);
        console.log('✅ Comment posted successfully');
        commentOk = true;
      } catch (commentErr) {
        if (attempt === 2) {
          console.error('⚠️  Could not post comment after 3 attempts:', commentErr?.message || commentErr);
        }
      }
    }

    // Comment is the primary purpose of the tool — succeed only if the comment posted.
    accountSucceeded = commentOk;

    // Per-account action summary
    const failedActions = [];
    if (!likeOk) failedActions.push('like');
    if (!shareOk) failedActions.push('share');
    if (!commentOk) failedActions.push('comment');
    if (failedActions.length === 0) {
      console.log(`📋 Account ${index} summary: like, share, comment all OK`);
    } else {
      console.warn(`⚠️  Account ${index} summary — failed actions: ${failedActions.join(', ')}`);
    }

    await delay(1_000);
  } catch (err) {
    console.error(`❌ Error on account ${index}:`, err?.message || err);
    try {
      const p = `screenshot-account${index}.png`;
      await page.screenshot({ path: p, fullPage: true });
      console.error(`📸 Screenshot saved to ${p}`);
    } catch { /* ignore */ }
  } finally {
    await context.close().catch(() => {});
    await browser.close().catch(() => {});
    console.log(`🏁 Account ${index} done. Browser closed.`);
  }
  return accountSucceeded;
}

// ── Entry point ───────────────────────────────────────────────────────────
// CLI usage:
//   node comment.js          → run all filled-in accounts
//   node comment.js 2        → run only account 2
//   node comment.js 2 5 7    → run accounts 2, 5, and 7
async function run() {
  validateEnv();
  const allAccounts = getAccounts();
  const commentTexts = getCommentTexts();

  // Filter by CLI args if provided (e.g. "node comment.js 2")
  const requestedIndices = process.argv.slice(2).map(Number).filter(Boolean);
  const accounts = requestedIndices.length > 0
    ? allAccounts.filter((a) => requestedIndices.includes(a.index))
    : allAccounts;

  if (accounts.length === 0) {
    const tried = requestedIndices.length > 0
      ? `account(s) ${requestedIndices.join(', ')} not found or credentials are still placeholders`
      : 'no filled-in accounts found';
    console.error(`❌ ${tried}. Check .env and try again.`);
    process.exit(1);
  }

  const accountsWithComments = assignComments(accounts, commentTexts);
  const autoCount = accounts.filter((a) => a.totpSecret).length;
  const manualCount = accounts.length - autoCount;

  console.log(`\n🚀 ${accounts.length} account(s) to process`);
  console.log(`   🤖 ${autoCount} fully automatic (TOTP secret configured)`);
  console.log(`   ✋ ${manualCount} manual 2FA (enter code yourself in the browser)`);

  const failedIndices = [];
  for (let i = 0; i < accountsWithComments.length; i++) {
    const ok = await runAccount(accountsWithComments[i], accounts.length);
    if (!ok) {
      const failedIdx = accountsWithComments[i].index;
      failedIndices.push(failedIdx);
      console.error(`\n⏭️  Account ${failedIdx} failed — skipping and continuing with the next account.`);
    }
    if (i < accountsWithComments.length - 1) {
      console.log('\n➡️  Opening next account (short pause)…');
      await delay(1_500);
    }
  }

  if (failedIndices.length) {
    console.log(`\n🧾 Failed accounts in this batch: ${failedIndices.join(', ')}`);
  }
  console.log('\n🎉 All done!');
}

run();
