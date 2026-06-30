# Facebook Post Auto-Liker, Sharer & Commenter

A Node.js + Playwright script that logs into one or more Facebook accounts, opens a specific post, likes it, shares it to the profile, and posts a comment — all in a visible browser window so you can watch each step. Supports multiple accounts in a single run, automatic 2FA via TOTP secrets, and per-account CLI filtering.

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
4. Copy `.env.example` to `.env` and fill in your real values. `.env.example` is the canonical template — it documents every variable the script reads. The script:
   - Scans for `FB_EMAIL_N` / `FB_PASSWORD_N` / `FB_TOTP_SECRET_N` triples (N = 1, 2, 3, …) and processes every filled-in slot.
   - Slots whose values still start with `your_` are silently skipped, so you can leave unused slots untouched.
   - Picks a comment for each account by shuffling the available `COMMENT_TEXT_N` variants.

### `.env` variables

| Variable | Required? | Purpose |
|---|---|---|
| `FB_EMAIL_N` | Yes (at least N=1) | Facebook email / phone for account N |
| `FB_PASSWORD_N` | Yes (at least N=1) | Password for account N |
| `FB_TOTP_SECRET_N` | Optional | Base32 TOTP secret for account N — enables fully automatic 2FA. Without it, the script pauses and waits for you to enter the code in the browser. |
| `POST_URL` | Yes | Full URL of the post to like, share, and comment on. Shared across all accounts. |
| `COMMENT_TEXT_N` | Yes (at least N=1) | Comment text variant N. Each account is randomly assigned exactly one variant. |

### Getting a TOTP secret (for auto-2FA)

1. Facebook → Settings → Security → Two-Factor Authentication.
2. Remove your authenticator app, then re-add it.
3. When Facebook displays the QR code, it also shows a text key — copy that.
4. Paste it as `FB_TOTP_SECRET_N` in `.env`, then scan the QR with your authenticator app too so the account stays in sync.

## Run

Run every filled-in account:
```
npm start
```

Run a subset of accounts by passing their indices on the command line:
```
node comment.js 2          # only account 2
node comment.js 2 5 7      # accounts 2, 5, and 7
```

Indices match the `N` in `FB_EMAIL_N`. Indices that don't exist or that still have placeholder credentials are reported and the script exits.

## Notes

- The browser opens **visibly** so you can watch each step.
- Accounts are processed sequentially. If one account fails its login/navigation, the batch stops so you can fix the issue before running the rest.
- If anything goes wrong, a `screenshot-accountN.png` (and additional `debug-*.png` files for 2FA / share failures) is saved in the project folder for debugging.
- Facebook's UI changes often; if a selector breaks, update it in `comment.js`.
- If an account has 2FA but no `FB_TOTP_SECRET_N` is configured, the script pauses up to 2 minutes for you to enter the code in the browser. Add the secret to make it fully automatic.
