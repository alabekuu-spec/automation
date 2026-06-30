// Color + zone configuration for the enaadam.mn ticket seat map.
// Captured live from https://www.enaadam.mn/ticket (2026-06-30).
//
// Plan: once the seat ZONES render (each zone is a button bearing a number and
// colored by its price tier), the automation finds the RED zone buttons whose
// number is in TARGET_ZONES and clicks them.

// ── Price-tier colors (zone fill = price tier) ────────────────────
// Prices CONFIRMED CURRENT for the live event (2026-07-01). The seats.png
// screenshot showed a different ladder (105,000/52,500) but that was a PREVIOUS
// event — ignore it. The automation NEVER reads price: it keys purely on the
// tier `rgb` colors and on seat-availability color, so price is just a label.
export const PRICE_COLORS = {
  red: { rgb: 'rgb(194, 58, 57)', price: '157,500 ₮' },     // ← top tier, the one we click
  green: { rgb: 'rgb(89, 146, 34)', price: '136,500 ₮' },
  blue: { rgb: 'rgb(0, 50, 160)', price: '136,500 ₮' },
  purple: { rgb: 'rgb(111, 53, 177)', price: '84,000 ₮' },
};

// ── Seat-status legend colors ─────────────────────────────────────
export const STATUS_COLORS = {
  available: 'rgb(85, 182, 205)', // Боломжтой  (clickable)
  sold: 'rgb(234, 234, 234)',     // Зарагдсан
  locked: 'rgb(241, 194, 96)',    // Түгжигдсэн
  pillar: 'rgb(36, 36, 36)',      // Багана (column / not a seat)
};

// The zone number is what we match on the button. All of these are the targets
// we want to click; the listed RED_ZONES are the ones rendered in the red tier.
export const TARGET_ZONES = [13, 14, 15, 16, 17, 18, 1, 2, 3, 4, 5, 6];
export const RED_ZONES = [14, 15, 16, 17, 18, 1, 2, 3, 4, 5];

// The color the click logic keys on: a zone button is a click target when its
// fill matches TARGET_COLOR and its number is in TARGET_ZONES.
export const TARGET_COLOR = PRICE_COLORS.red.rgb; // 'rgb(194, 58, 57)'

// Parse an "rgb(r, g, b)" string into [r,g,b]; null if it doesn't parse.
export function parseRgb(str) {
  const m = /rgba?\(\s*(\d+)\s*,\s*(\d+)\s*,\s*(\d+)/.exec(str || '');
  return m ? [Number(m[1]), Number(m[2]), Number(m[3])] : null;
}

// True if two colors are within `tol` per channel (anti-aliasing / opacity slack).
export function colorMatches(a, b, tol = 12) {
  const x = parseRgb(a), y = parseRgb(b);
  if (!x || !y) return false;
  return Math.abs(x[0] - y[0]) <= tol && Math.abs(x[1] - y[1]) <= tol && Math.abs(x[2] - y[2]) <= tol;
}

export function isRedZone(colorStr) {
  return colorMatches(colorStr, TARGET_COLOR);
}
