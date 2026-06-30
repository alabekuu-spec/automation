# enaadam.mn Multi-Account Session Manager

A Node.js + Playwright tool that logs one or more accounts into
[enaadam.mn](https://www.enaadam.mn) and **saves each account's session in its
own persistent Chrome profile**, so every later run opens already logged in —
no repeated SMS codes.

enaadam.mn uses **phone-number + SMS one-time-code** login (no password). The
code can't be automated, so you enter it by hand **once** per account in a
visible browser window. After that the session is stored on disk in
`profiles/enaadam-account-N/` and reused until the server-side session expires.

## Setup

1. Install [Node.js](https://nodejs.org/) (v18 or later).
2. Install dependencies:
   ```
   npm install
   ```
3. Install the Chromium browser used by Playwright:
   ```
   npm run install-browser
   ```
4. Copy `.env.example` to `.env` and add your phone number(s):
   ```
   ENAADAM_MOBILE_1=88001122
   ```
   Add `ENAADAM_MOBILE_2`, `_3`, … for more accounts. Empty slots and values
   starting with `your_` are skipped.

## Usage

### Log in / save sessions
Opens a visible browser per account, pre-fills the phone number, and triggers
the SMS. **Type the SMS code in the window** — the script waits up to 5 minutes,
then saves the session. Accounts that are already logged in are skipped.
```
npm run enaadam-login           # all filled-in accounts
node enaadam-login.js 1 3       # only accounts 1 and 3
```

### Open an already-logged-in account
Opens a saved profile (already logged in) and leaves the window open.
```
node enaadam-open.js 1          # open account 1
```

## Files

| File | Purpose |
|---|---|
| `enaadam-accounts.mjs` | Reads `ENAADAM_MOBILE_N` from `.env`. |
| `lib/enaadam-login.mjs` | Login flow + logged-in-state detection. |
| `enaadam-login.js` | Logs each account in (manual SMS code), saves the session. |
| `enaadam-open.js` | Opens a saved, already-logged-in profile. |

Each account's cookies/session live in `profiles/enaadam-account-N/`
(git-ignored). Delete that folder to force a fresh login for an account.

## Notes
- Browsers open **visibly** so you can complete the SMS step and watch.
- Accounts are processed sequentially, one browser at a time.
- On login failure a `screenshot-enaadam-login-accountN.png` is saved for debugging.
- If `enaadam-open.js` reports "not logged in", the session expired — re-run
  `enaadam-login.js` for that account.
