// Reads FB_EMAIL_N / FB_PASSWORD_N / FB_TOTP_SECRET_N from .env.
// Slots whose values still start with "your_" are silently skipped.
export function getAccounts() {
  const accounts = [];
  let i = 1;
  while (process.env[`FB_EMAIL_${i}`] !== undefined) {
    const email = process.env[`FB_EMAIL_${i}`];
    const password = process.env[`FB_PASSWORD_${i}`];
    const isPlaceholder =
      !email || email.startsWith('your_') ||
      !password || password.startsWith('your_');

    if (!isPlaceholder) {
      const rawSecret = process.env[`FB_TOTP_SECRET_${i}`] || '';
      const totpSecret = rawSecret && !rawSecret.startsWith('your_')
        ? rawSecret.replace(/\s+/g, '')
        : null;
      accounts.push({ email, password, totpSecret, index: i });
    }
    i++;
  }
  if (accounts.length === 0 && process.env.FB_EMAIL && process.env.FB_PASSWORD) {
    accounts.push({
      email: process.env.FB_EMAIL,
      password: process.env.FB_PASSWORD,
      totpSecret: null,
      index: 1,
    });
  }
  return accounts;
}
