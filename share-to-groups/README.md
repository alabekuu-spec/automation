# share-to-groups

Shares `POST_URL` (from project-root `.env`) into every group listed in
`Suhbaatar group.xlsx`, for every account in `.env`. Account sessions are
reused from `../profiles/account-N` (same persistent profiles
`join-groups.js` and `login-all.js` use), so logins are skipped when
cookies are still valid.

## Files in this folder
- `share-to-groups.js` — the script. Imports `accounts.mjs`, `groups.mjs`,
  and `lib/facebook-login.mjs` from the project root.

Everything else (creds, deps, group list, browser profiles) lives at the
project root and is shared across all scripts.

## Run (from project root)
```
node share-to-groups/share-to-groups.js          # all filled-in accounts
node share-to-groups/share-to-groups.js 1 3 5    # only accounts 1, 3, 5
GROUPS_FILE=other.xlsx node share-to-groups/share-to-groups.js
```

Or via npm:
```
npm run share-to-groups
```

## How it works
For each account, sequentially: open a visible Chromium with the persistent
profile, verify logged in (login if not), then for each group:

1. Navigate to `https://www.facebook.com/groups/<id>/`.
2. Skip if the group's "Write something…" composer isn't visible (means
   we're not a member, or the group is private/pending approval).
3. Click the composer trigger, paste `POST_URL` into the contenteditable.
4. Wait ~6s for Facebook to fetch the link preview.
5. Click `Post` / `Posting` / `Нийтлэх`.
6. Confirm the composer closes — if it stays open, it's logged as `unclear`.
7. Random 15–30s pause before the next group (anti-spam pacing).

Failures are screenshotted as `debug-*-accN-<groupId>.png` in the cwd.
