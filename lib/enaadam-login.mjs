// enaadam.mn login helpers.
//
// Login flow on https://www.enaadam.mn/auth/login is phone-number + SMS-OTP:
//   1. Enter phone number into #mobile
//   2. Click "Нэвтрэх" (submit) — this sends an SMS one-time code
//   3. Enter the SMS code in the field that appears, then submit
//   4. The SPA navigates away from /auth/login once authenticated
//
// There is no password, so step 3 cannot be automated — the operator types
// the SMS code in the visible browser. Because every account runs in its own
// persistent Chromium profile, the session is saved to disk and reused on
// later runs (no SMS needed until the server-side session expires).

export const LOGIN_URL = 'https://www.enaadam.mn/auth/login';
export const HOME_URL = 'https://www.enaadam.mn/';
export const TICKET_URL = 'https://www.enaadam.mn/ticket';

export const delay = (ms) => new Promise((resolve) => setTimeout(resolve, ms));
export const randomDelay = (min, max) =>
  delay(Math.floor(Math.random() * (max - min + 1)) + min);

// True if the page's localStorage/sessionStorage holds an auth-looking token.
async function hasAuthToken(page) {
  return await page
    .evaluate(() => {
      const scan = (store) => {
        try {
          for (let i = 0; i < store.length; i++) {
            const k = store.key(i) || '';
            if (/token|auth|user|session|jwt|access|login/i.test(k)) {
              const v = store.getItem(k);
              if (v && v.length > 10 && v !== 'null' && v !== 'undefined' && v !== '{}') return true;
            }
          }
        } catch { /* storage may be blocked */ }
        return false;
      };
      return scan(window.localStorage) || scan(window.sessionStorage);
    })
    .catch(() => false);
}

function onAuthRoute(page) {
  return /\/auth(\/|$)/.test(page.url());
}

async function loginFormVisible(page) {
  return (await page.locator('#mobile').count().catch(() => 0)) > 0;
}

// Best-effort logged-in check. Assumes the page is already on an enaadam.mn
// origin (so storage is readable). Logged in when an auth token exists, OR we
// are not on an /auth route and the phone-login form is absent.
export async function isLoggedIn(page) {
  if (await hasAuthToken(page)) return true;
  if (onAuthRoute(page)) return false;
  return !(await loginFormVisible(page));
}

// Navigate to the login route and decide whether this profile is already
// authenticated. Authenticated SPAs typically bounce off /auth/login.
export async function checkSession(page) {
  await page.goto(LOGIN_URL, { waitUntil: 'domcontentloaded' }).catch(() => {});
  await delay(2_500);
  return await isLoggedIn(page);
}

async function clickLoginSubmit(page) {
  for (const sel of [
    'button[type="submit"].shoppy-btn-block',
    'form button[type="submit"]',
    'button[type="submit"]',
  ]) {
    try {
      const btn = page.locator(sel).first();
      if ((await btn.count()) > 0 && (await btn.isVisible().catch(() => false))) {
        await btn.click();
        return true;
      }
    } catch { /* try next */ }
  }
  // Fallback: the form's "Нэвтрэх" button (skip the header nav button)
  try {
    const btn = page.getByRole('button', { name: /^нэвтрэх$/i }).last();
    if ((await btn.count()) > 0) { await btn.click(); return true; }
  } catch { /* none */ }
  return false;
}

// Polls until the profile is logged in or the timeout elapses. Intended to
// span the manual SMS-OTP entry, so the timeout is generous.
export async function waitForLogin(page, timeoutMs = 300_000) {
  const deadline = Date.now() + timeoutMs;
  let lastUrl = '';
  while (Date.now() < deadline) {
    const url = page.url();
    if (url !== lastUrl) {
      console.log(`   🔗 ${url}`);
      lastUrl = url;
    }
    if (await isLoggedIn(page)) return true;
    await delay(1_500);
  }
  return false;
}

// Opens the login page, pre-fills the phone number, and triggers the SMS.
// Then waits for the operator to enter the code in the visible browser.
export async function performEnaadamLogin(page, { mobile, index }) {
  console.log(`🌐 acc${index} — opening ${LOGIN_URL}`);
  await page.goto(LOGIN_URL, { waitUntil: 'domcontentloaded' });
  await delay(2_000);

  if (await isLoggedIn(page)) {
    console.log(`✅ acc${index} — already logged in (session still valid)`);
    return true;
  }

  try {
    await page.waitForSelector('#mobile', { timeout: 30_000 });
    await page.fill('#mobile', '');
    await page.type('#mobile', mobile, { delay: 60 });
    await randomDelay(400, 800);
    console.log(`📱 acc${index} — phone number entered, requesting SMS code…`);
    const clicked = await clickLoginSubmit(page);
    if (!clicked) console.log(`⚠️  acc${index} — could not find the submit button automatically; click "Нэвтрэх" in the window.`);
  } catch (e) {
    console.log(`⚠️  acc${index} — could not pre-fill phone (${e?.message || e}); do it manually in the window.`);
  }

  console.log(`✋ acc${index} — ENTER THE SMS CODE in the browser window and submit. Waiting up to 5 min…`);
  const ok = await waitForLogin(page, 300_000);
  if (!ok) {
    throw new Error(`acc${index}: login not completed within 5 minutes (SMS code not entered / failed).`);
  }
  console.log(`✅ acc${index} — logged in. Session saved to this profile.`);
  return true;
}
