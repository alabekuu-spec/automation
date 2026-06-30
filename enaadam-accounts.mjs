// Reads ENAADAM_MOBILE_N from .env.
// Slots that are empty or still start with "your_" are silently skipped.
//
// Each entry becomes: { mobile, index }
export function getEnaadamAccounts() {
  const accounts = [];
  let i = 1;
  while (process.env[`ENAADAM_MOBILE_${i}`] !== undefined) {
    const raw = process.env[`ENAADAM_MOBILE_${i}`] || '';
    const mobile = raw.replace(/[\s-]+/g, ''); // strip spaces / dashes
    const isPlaceholder = !mobile || mobile.startsWith('your_');
    if (!isPlaceholder) {
      accounts.push({ mobile, index: i });
    }
    i++;
  }
  // Single-account fallback (ENAADAM_MOBILE with no index)
  if (accounts.length === 0 && process.env.ENAADAM_MOBILE) {
    accounts.push({ mobile: process.env.ENAADAM_MOBILE.replace(/[\s-]+/g, ''), index: 1 });
  }
  return accounts;
}
