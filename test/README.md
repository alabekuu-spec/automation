# Offline test — enaadam ticket grabber

`test-grab-local.mjs` **imports the real exported functions from `../enaadam-grab.js`**
(`pageEventLive`, `pageCalibrate`, `pageFindRedZone`, `pageTagSeats`,
`pickAvailableSeats`) and runs them against the local mock page
`../naadam-stadium.html` (opened as a `file://` URL) instead of the live enaadam.mn
site. It needs **no login, no account profiles, and no live event**, so the actual
production grab logic can be verified any time. A green run = the real code works on
a rendered seat map (reaches **2/2 carted**).

It also reuses our targeting config (`TARGET_COLOR`, `TARGET_ZONES`, `STATUS_COLORS`
from `../enaadam-zones.mjs`).

## Run

```sh
# from the project root (C:\Users\hitech\Desktop\automation\automation)
node test/test-grab-local.mjs            # single-account flow, headful
HEADLESS=true node test/test-grab-local.mjs

node test/test-collision.mjs             # multi-account collision check, headless
ACCOUNTS=4 node test/test-collision.mjs
HEADLESS=false node test/test-collision.mjs
```

`test-grab-local.mjs` writes a screenshot to `test/test-result.png`. Both tests
exit `0` only when everything passes.

## Cross-account collision avoidance

When all accounts run in parallel, `enaadam-grab.js` spreads them so they don't
fight over the same seat:
- each account **rotates its zone sweep order** by its slot (`grabPass`), so they
  start in different zones (full coverage is preserved);
- each account uses a **seat-pick stride** (`pickAvailableSeats` → `pageTagSeats`
  `offset`), so even inside one zone they prefer different seats. The offset wraps,
  so an account is never starved when seats run low.

`test-collision.mjs` forces N accounts into the *same* zone (worst case) and
asserts they cart **disjoint** seats. Example result (3 accounts, zone 1):
`acc0 [1:14:1, 1:14:5]`, `acc1 [1:14:2, 1:14:7]`, `acc2 [1:14:3, 1:14:8]` — no clashes.

## Stages

1. detect seat map live (`pageEventLive`)
2. self-calibrate colors from the legend (`pageCalibrate`)
3. *(diagnostic)* find RED zone by color+number (`pageFindRedZone`)
4. open a RED target zone
5. find available (teal) seats (`pageTagSeats`)
6. seat → `Сагслах` cart flow (up to 2 tickets)
7. cart reflects the selection

## Bugs this test uncovered — now FIXED in `enaadam-grab.js`

These were latent because the grabber had never run against a rendered seat map
(no live event has been published). The mock + this test surfaced them, and all
four fixes have been applied to `enaadam-grab.js`:

1. **CRITICAL — `page.evaluate` multi-arg bug.** `enaadam-grab.js` calls
   `page.evaluate(pageFindRedZone, redColor, TARGET_ZONES, COLOR_TOL)` and
   `page.evaluate(pageTagSeats, availColor, COLOR_TOL, 1)`. Playwright's
   `page.evaluate` accepts **only one** argument and throws *"Too many arguments…"*.
   Those throws are swallowed by the surrounding `.catch(() => null/0)`, so the
   grabber silently **never finds a zone or tags a seat** — it can never cart.
   **Fix:** pass a single object, e.g.
   `page.evaluate(pageFindRedZone, { targetColor, targetNums, tol })` and destructure
   inside the in-page function (this harness shows the corrected form).

2. **Zone finder strategy doesn't fit the seat map.** `pageFindRedZone` needs the
   RED fill **and** the zone number on the *same* element. In this map (and likely
   the real one) the colored shape and the number label are **separate** elements,
   so it matches nothing. **Fix:** match the colored shape by its `data-sector` id
   (the stable hook the project's own TODO already recommends).

3. **SVG seats need a dispatched click.** Seat dots live inside a zoom wrapper
   (`.stadium-wrap`) that intercepts trusted Playwright clicks. **Fix:** fall back
   to `page.dispatchEvent(selector, 'click')` when `page.click` is intercepted.

4. **Seat selection should be on-screen / ordered.** Tagging seats purely by color
   in DOM order can pick a seat clipped under the legend bar that can't be clicked.
   **Fix:** restrict to on-screen seats and prefer the bottom-most ones.

All four fixes are layered/defensive (kept the original strategies and added
fallbacks) so they hold on the live site too, not just this mock. `enaadam-grab.js`
now reaches **2/2 carted** when driven by this test. The watch/hold phases and env
knobs are unchanged.
