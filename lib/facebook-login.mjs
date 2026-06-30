import * as OTPAuth from 'otpauth';

export const delay = (ms) => new Promise((resolve) => setTimeout(resolve, ms));
export const randomDelay = (min, max) =>
  delay(Math.floor(Math.random() * (max - min + 1)) + min);

async function generateFreshTOTP(secret) {
  const secondsUsed = Math.floor(Date.now() / 1000) % 30;
  const secondsLeft = 30 - secondsUsed;
  if (secondsLeft < 5) {
    console.log(`⏳ Waiting ${secondsLeft + 1}s for a fresh TOTP window…`);
    await delay((secondsLeft + 1) * 1000);
  }
  const totp = new OTPAuth.TOTP({
    secret: OTPAuth.Secret.fromBase32(secret),
    digits: 6,
    period: 30,
    algorithm: 'SHA1',
  });
  return totp.generate();
}

async function clickLoginButton(page) {
  for (const sel of [
    'button[data-testid="royal_login_button"]',
    'button[name="login"]',
    'form#login_form button[type="submit"]',
  ]) {
    try {
      const el = page.locator(sel).first();
      await el.waitFor({ state: 'visible', timeout: 3_000 });
      await el.click();
      return;
    } catch { /* try next */ }
  }
  try {
    const roleBtn = page.getByRole('button', { name: /log\s*in/i }).first();
    await roleBtn.waitFor({ state: 'visible', timeout: 3_000 });
    await roleBtn.click();
    return;
  } catch { /* no match */ }
  throw new Error('Could not locate the Facebook login button with any known selector.');
}

function isAuthUrl(url) {
  try {
    const { pathname } = new URL(url);
    return /\/(login|checkpoint|recover|two_step|two_factor|auth)/i.test(pathname);
  } catch {
    return /login|\/checkpoint|recover|two_step|two_factor/i.test(url);
  }
}

async function pageShowsInvalid2FACode(page) {
  const patterns = [
    /doesn'?t match the one sent to your phone/i,
    /Please check the number and try again/i,
    /The login code you entered doesn'?t match/i,
    /That code isn'?t right/i,
    /incorrect verification code/i,
    /invalid.*code.*try again/i,
    /Kode.{0,80}tidak.{0,40}(benar|cocok|sesuai)/i,
    /Periksa nomor dan coba lagi/i,
  ];
  for (const pattern of patterns) {
    try {
      const loc = page.getByText(pattern).first();
      if ((await loc.count()) > 0 && await loc.isVisible().catch(() => false)) return true;
    } catch { /* next */ }
  }
  return false;
}

async function dismissRememberPasswordPopup(page) {
  try {
    for (const text of ['Nanti', 'Later', 'Not now', 'Tidak sekarang']) {
      const btn = page.getByRole('button', { name: new RegExp(text, 'i') }).first();
      if ((await btn.count()) > 0) {
        await btn.click();
        console.log('💬 Dismissed "Remember Password" popup');
        return;
      }
    }
    const closeBtn = page.locator('[aria-label="Close"], [aria-label="Tutup"]').first();
    if ((await closeBtn.count()) > 0) await closeBtn.click();
  } catch { /* ignore */ }
}

async function clickTrustButton(page) {
  for (const pattern of [/percayai perangkat ini/i, /trust this device/i, /percayai/i, /trust/i]) {
    try {
      const btn = page.getByRole('button', { name: pattern }).first();
      if ((await btn.count()) > 0) {
        await btn.click();
        return true;
      }
    } catch { /* try next */ }
  }
  for (const text of ['Percayai perangkat ini', 'Trust this device', 'Percayai', 'Trust']) {
    try {
      const el = page.getByText(text, { exact: false }).first();
      if ((await el.count()) > 0) {
        await el.click();
        return true;
      }
    } catch { /* try next */ }
  }
  for (const sel of [
    'div[data-testid*="trust"] button',
    'button[type="submit"]',
    'div[class*="primary"] div[role="button"]',
    'div[class*="blue"] div[role="button"]',
    'a[role="button"][class*="primary"]',
  ]) {
    try {
      const el = page.locator(sel).first();
      if ((await el.count()) > 0) {
        const txt = (await el.textContent().catch(() => '')) || '';
        if (/percayai|trust/i.test(txt)) {
          await el.click();
          return true;
        }
      }
    } catch { /* try next */ }
  }
  return false;
}

async function isActuallyLoggedIn(page) {
  const positiveSelectors = [
    '[role="navigation"][aria-label="Facebook"]',
    '[aria-label="Facebook"][role="banner"]',
    '[data-pagelet="ProfileCta"]',
    '[aria-label="Your profile"]',
    '[aria-label="Account Controls and Settings"]',
    '[aria-label="Account"]',
    'a[href="/me/"]',
    'a[href*="facebook.com/me"]',
    '[aria-label="Create"]',
    '[aria-label="Messenger"]',
  ];
  for (const sel of positiveSelectors) {
    const count = await page.locator(sel).count().catch(() => 0);
    if (count > 0) return true;
  }
  if (isAuthUrl(page.url())) return false;
  const loginFormCount = await page
    .locator('input[name="email"], input[name="pass"]')
    .count()
    .catch(() => 0);
  return loginFormCount === 0;
}

async function waitForPostLoginState(page, timeoutMs = 15_000) {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    const urlNow = page.url();
    if (isAuthUrl(urlNow)) return 'auth';
    const has2FAInput = (await page
      .locator('input[name="approvals_code"], input[id="approvals_code"], input[autocomplete="one-time-code"]')
      .count()
      .catch(() => 0)) > 0;
    if (has2FAInput) return '2fa';
    if (await isActuallyLoggedIn(page)) return 'logged_in';
    await delay(500);
  }
  return 'timeout';
}

async function waitFor2FACompletion(page) {
  const deadline = Date.now() + 300_000;
  while (Date.now() < deadline) {
    const urlNow = page.url();
    if (!isAuthUrl(urlNow)) return;
    await dismissRememberPasswordPopup(page);
    try {
      const clicked = await clickTrustButton(page);
      if (clicked) {
        console.log('🛡️  "Trust this device" prompt — clicking automatically…');
        await delay(2_000);
        continue;
      }
    } catch { /* keep polling */ }
    await delay(1_000);
  }
  throw new Error('2FA did not complete within 5 minutes. Check the browser for errors.');
}

/**
 * Opens facebook.com on `page`, fills credentials, handles 2FA (TOTP or manual),
 * and throws if login cannot be verified.
 */
export async function performFacebookLogin(page, { email, password, totpSecret, index }) {
  console.log('🌐 Opening Facebook…');
  await page.goto('https://www.facebook.com/', { waitUntil: 'domcontentloaded' });

  try {
    const cookieBtn = page.locator('[data-cookiebanner="accept_button"]').first();
    await cookieBtn.waitFor({ state: 'visible', timeout: 5_000 });
    await cookieBtn.click();
    console.log('🍪 Dismissed cookie consent dialog');
    await randomDelay(500, 1000);
  } catch {
    try {
      const fb = page.getByRole('button', { name: /allow.*cookies/i }).first();
      await fb.waitFor({ state: 'visible', timeout: 2_000 });
      await fb.click();
      console.log('🍪 Dismissed cookie consent dialog');
      await randomDelay(500, 1000);
    } catch { /* no banner */ }
  }

  await page.waitForSelector('input[name="email"]', { timeout: 30_000 });
  await page.fill('input[name="email"]', '');
  await page.type('input[name="email"]', email, { delay: 80 });
  await randomDelay(400, 900);

  await page.fill('input[name="pass"]', '');
  await page.type('input[name="pass"]', password, { delay: 80 });
  await randomDelay(400, 900);

  await clickLoginButton(page);
  await randomDelay(300, 600);

  const postLoginState = await waitForPostLoginState(page, 15_000);
  console.log(`🔍 Post-login state: ${postLoginState}`);
  const currentUrl = page.url();
  const is2FA = isAuthUrl(currentUrl)
    || (await page.locator('input[name="approvals_code"], input[id="approvals_code"]').count().catch(() => 0)) > 0;

  if (is2FA && totpSecret) {
    console.log('🔐 2FA checkpoint detected — monitoring for code field (up to 5 min)…');

    const codeInputSel =
      'input[name="approvals_code"], input[id="approvals_code"], ' +
      'input[autocomplete="one-time-code"], ' +
      'input[placeholder="Kode"], input[placeholder="Code"], ' +
      'input[placeholder*="kode" i], input[placeholder*="code" i], ' +
      'input[aria-label*="kode" i], input[aria-label*="code" i], ' +
      'input[data-testid*="code" i], ' +
      'input[name*="code" i]:not([name="email"]):not([name="pass"]), ' +
      'input[type="tel"], ' +
      'input[type="number"]:not([name="email"]):not([name="pass"]), ' +
      'input[type="text"]:not([name="email"]):not([name="pass"])';

    async function findCodeInput() {
      for (const labelText of ['Kode', 'Code', /kode/i, /code/i]) {
        try {
          const byLabel = page.getByLabel(labelText).first();
          if ((await byLabel.count()) > 0) return { locator: byLabel };
        } catch { /* try next */ }
      }
      const mainCount = await page.locator(codeInputSel).count().catch(() => 0);
      if (mainCount > 0) return { locator: page.locator(codeInputSel).first() };
      for (const frame of page.frames()) {
        if (frame === page.mainFrame()) continue;
        for (const labelText of ['Kode', 'Code', /kode/i, /code/i]) {
          try {
            const byLabel = frame.getByLabel(labelText).first();
            if ((await byLabel.count()) > 0) return { locator: byLabel };
          } catch { /* try next */ }
        }
        const frameCount = await frame.locator(codeInputSel).count().catch(() => 0);
        if (frameCount > 0) return { locator: frame.locator(codeInputSel).first() };
      }
      return null;
    }

    let codeFilled = false;
    let totpInvalidRetries = 0;
    const deadline = Date.now() + 300_000;
    let lastScreenshotAt = 0;
    let lastCheckpointWarnAt = 0;
    let lastUrl = '';

    while (Date.now() < deadline) {
      const urlNow = page.url();

      if (urlNow !== lastUrl) {
        console.log(`🔗 URL: ${urlNow}`);
        lastUrl = urlNow;
      }

      if (!isAuthUrl(urlNow)) break;

      if (/\/checkpoint\//i.test(urlNow) && !/two_step|two_factor/i.test(urlNow)) {
        const now = Date.now();
        if (now - lastCheckpointWarnAt > 25_000) {
          lastCheckpointWarnAt = now;
          console.warn(
            '⚠️  Generic /checkpoint/ page — Facebook wants extra verification. Complete it manually or skip this account.',
          );
          await page.screenshot({ path: `debug-checkpoint-account${index}.png`, fullPage: true }).catch(() => {});
          console.warn(`📸 checkpoint screenshot: debug-checkpoint-account${index}.png`);
        }
      }

      await dismissRememberPasswordPopup(page);

      try {
        const clicked = await clickTrustButton(page);
        if (clicked) {
          console.log('🛡️  "Trust this device" prompt — clicking automatically…');
          await delay(2_000);
          codeFilled = false;
          totpInvalidRetries = 0;
          continue;
        }
      } catch { /* keep polling */ }

      if (codeFilled && isAuthUrl(urlNow) && (await pageShowsInvalid2FACode(page))) {
        totpInvalidRetries += 1;
        if (totpInvalidRetries > 10) {
          throw new Error(
            '2FA code was rejected too many times. Check FB_TOTP_SECRET or complete SMS flow in the browser.',
          );
        }
        console.log('⚠️  Login code not accepted — generating a new TOTP and retrying…');
        try {
          const inp = await findCodeInput();
          if (inp) await inp.locator.fill('');
        } catch { /* field may have detached */ }
        codeFilled = false;
        await delay(1_000);
        continue;
      }

      const codeInputResult = !codeFilled ? await findCodeInput() : null;
      if (codeInputResult) {
        console.log('🔑 Code input found — generating TOTP…');
        const code = await generateFreshTOTP(totpSecret);
        console.log('🔑 TOTP code generated and entered');

        await codeInputResult.locator.fill(code);
        await randomDelay(800, 1200);

        await codeInputResult.locator.press('Enter');
        await delay(2_000);

        if (isAuthUrl(page.url())) {
          for (const sel of ['button[type="submit"]', '[data-testid="two_factor_submit"]']) {
            try {
              const btn = page.locator(sel).first();
              if ((await btn.count()) > 0) { await btn.click(); break; }
            } catch { /* try next */ }
          }
          try {
            await page.getByRole('button', { name: /lanjutkan|continue|submit|next|konfirmasi/i }).first().click();
          } catch { /* couldn't find submit */ }
          await delay(2_000);
        }

        codeFilled = true;
        console.log('✅ TOTP submitted — waiting for redirect…');
        continue;
      }

      const isCaptcha = (await page.locator('iframe[src*="recaptcha"], .g-recaptcha').count().catch(() => 0)) > 0;
      if (isCaptcha) console.log('🤖 reCAPTCHA on screen — waiting for it to clear…');

      if (Date.now() - lastScreenshotAt > 20_000) {
        await page.screenshot({ path: 'debug-2fa.png', fullPage: true }).catch(() => {});
        console.log('📸 debug-2fa.png updated — check it to see the current browser state');
        lastScreenshotAt = Date.now();
      }

      await delay(1_500);
    }

    if (isAuthUrl(page.url())) {
      throw new Error('2FA did not complete within 5 minutes. Check the browser for errors.');
    }

    await page.waitForLoadState('networkidle', { timeout: 20_000 }).catch(() => {});
    await delay(4_000);
    console.log('✅ 2FA completed, logged in successfully');
  } else if (is2FA) {
    console.log('🔐 2FA detected — please enter the code in the browser window.');
    console.log('   💡 Tip: add FB_TOTP_SECRET to .env to make this fully automatic.');
    console.log('   The script will resume automatically once login completes…');
    await waitFor2FACompletion(page);
    await page.waitForLoadState('networkidle', { timeout: 20_000 }).catch(() => {});
    await delay(4_000);
    console.log('✅ 2FA completed, logged in successfully');
  } else if (await isActuallyLoggedIn(page)) {
    console.log('✅ Logged in successfully (no 2FA required)');
  } else {
    console.log('⏳ Login page still showing — waiting up to 30s for it to resolve…');
    try {
      await page.waitForFunction(
        () => !/\/(login|checkpoint|recover|two_step|two_factor|auth)/i.test(window.location.pathname),
        { timeout: 30_000 }
      );
    } catch {
      throw new Error('Login did not complete within 30s. Check credentials or look for a CAPTCHA in the browser.');
    }
    console.log('✅ Logged in successfully');
  }
  await randomDelay(3000, 5000);

  if (!(await isActuallyLoggedIn(page))) {
    throw new Error('Login verification failed — page does not look logged in. Check the browser for errors.');
  }
}
