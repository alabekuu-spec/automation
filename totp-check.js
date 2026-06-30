import 'dotenv/config';
import * as OTPAuth from 'otpauth';

const idx = Number(process.argv[2]) || 1;
const rawSecret = process.env[`FB_TOTP_SECRET_${idx}`] || '';
const secret = rawSecret.replace(/\s+/g, '');

if (!secret || secret.startsWith('your_')) {
  console.error(`❌ FB_TOTP_SECRET_${idx} is missing or still a placeholder`);
  process.exit(1);
}

const email = process.env[`FB_EMAIL_${idx}`];
const masked = secret.length > 8
  ? `${secret.slice(0, 4)}…${secret.slice(-4)} (len=${secret.length})`
  : `(len=${secret.length})`;

console.log(`Account ${idx}: ${email}`);
console.log(`Secret:    ${masked}`);
console.log(`Raw chars: contains-space=${/\s/.test(rawSecret)} contains-equals=${/=/.test(rawSecret)} lowercase=${/[a-z]/.test(secret)}`);

const localMs = Date.now();
const localIso = new Date(localMs).toISOString();
console.log(`\nLocal clock (UTC): ${localIso}  unix=${Math.floor(localMs/1000)}`);

try {
  const res = await fetch('https://worldtimeapi.org/api/timezone/Etc/UTC');
  const j = await res.json();
  const remoteMs = new Date(j.utc_datetime).getTime();
  const skewSec = Math.round((localMs - remoteMs) / 1000);
  console.log(`Remote UTC (worldtimeapi): ${j.utc_datetime}`);
  console.log(`Clock skew: ${skewSec >= 0 ? '+' : ''}${skewSec}s  (positive = local clock is ahead)`);
  if (Math.abs(skewSec) > 5) {
    console.warn(`⚠️  Clock skew > 5s — this alone can cause TOTP rejection`);
  }
} catch (e) {
  console.warn(`(could not fetch remote time: ${e.message})`);
}

let totp;
try {
  totp = new OTPAuth.TOTP({
    secret: OTPAuth.Secret.fromBase32(secret),
    digits: 6, period: 30, algorithm: 'SHA1',
  });
} catch (e) {
  console.error(`❌ Secret is not valid base32: ${e.message}`);
  process.exit(1);
}

const nowSec = Math.floor(localMs / 1000);
const secondsLeft = 30 - (nowSec % 30);

console.log(`\nCodes for adjacent 30-s windows (compare to your authenticator app):`);
for (const delta of [-60, -30, 0, 30, 60]) {
  const ts = (nowSec + delta) * 1000;
  const code = totp.generate({ timestamp: ts });
  const label = delta === 0 ? '  CURRENT' : (delta < 0 ? `t${delta}s ` : `t+${delta}s`);
  console.log(`  ${label}: ${code}`);
}
console.log(`\n${secondsLeft}s left in the current window.`);
console.log(`If the CURRENT code matches your authenticator, the secret is right.`);
console.log(`If t-30 or t+30 matches instead, your clock is skewed by ~30s.`);
console.log(`If none match, FB_TOTP_SECRET_${idx} is for a different account / stale.`);
