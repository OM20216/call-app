import { exec } from 'node:child_process';
import os from 'node:os';

const LOCAL = 'http://127.0.0.1:4200';
const CLOUD = 'https://hr-call.hr-call-worker.workers.dev';

/** The first LAN IPv4 address people on the office Wi-Fi can use. */
function lanIp() {
  for (const list of Object.values(os.networkInterfaces())) {
    for (const net of list || []) {
      if (net.family === 'IPv4' && !net.internal) return net.address;
    }
  }
  return null;
}

async function target() {
  if (process.env.CALL_APP_URL) return process.env.CALL_APP_URL;
  try {
    const res = await fetch(`${LOCAL}/healthz`, { signal: AbortSignal.timeout(2000) });
    if (res.ok) return LOCAL;
  } catch {
    // office server not running
  }
  return CLOUD;
}

const url = await target();
const cmd =
  process.platform === 'win32' ? `start "" "${url}"` :
  process.platform === 'darwin' ? `open "${url}"` :
  `xdg-open "${url}"`;

exec(cmd, (err) => {
  if (err) {
    console.error('Could not open the browser automatically. Open this URL manually:');
    console.error(url);
    process.exit(1);
  }
  console.log('Opened the HR call app in your default browser:');
  console.log(url);
  const ip = lanIp();
  if (url === LOCAL && ip) {
    console.log('');
    console.log(`Office link for everyone on the Wi-Fi: http://${ip}:4200`);
  }
});
