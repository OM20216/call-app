import { exec } from 'node:child_process';

const url = 'https://hr-call.hr-call-worker.workers.dev';

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
});
