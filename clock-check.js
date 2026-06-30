import https from 'https';

function getServerDate(host) {
  return new Promise((resolve, reject) => {
    const req = https.request(
      { host, path: '/', method: 'HEAD', timeout: 8000 },
      (res) => {
        const localMs = Date.now();
        const dateHdr = res.headers.date;
        if (!dateHdr) { reject(new Error('no Date header')); return; }
        const serverMs = new Date(dateHdr).getTime();
        resolve({ host, dateHdr, serverMs, localMs, skewSec: (localMs - serverMs) / 1000 });
        res.resume();
      },
    );
    req.on('error', reject);
    req.on('timeout', () => { req.destroy(new Error('timeout')); });
    req.end();
  });
}

const hosts = ['www.facebook.com', 'www.google.com', 'www.cloudflare.com'];

console.log(`Local clock: ${new Date().toISOString()}\n`);

for (const h of hosts) {
  try {
    const r = await getServerDate(h);
    const skewMs = r.localMs - r.serverMs;
    const skewSec = Math.round(skewMs / 1000);
    const sign = skewSec >= 0 ? '+' : '';
    console.log(`${h.padEnd(22)} server says: ${r.dateHdr}`);
    console.log(`${' '.padEnd(22)} skew: ${sign}${skewSec}s  (local ${skewMs > 0 ? 'ahead' : 'behind'})\n`);
  } catch (e) {
    console.log(`${h.padEnd(22)} ERROR: ${e.message}\n`);
  }
}

console.log('TOTP windows are 30s wide. Facebook usually accepts ±1 window (60s tolerance).');
console.log('Skew under ~5s: safe. 5-25s: edge cases. 25s+: codes will be rejected often.');
