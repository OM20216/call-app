# Graph Call on this PC (office link, no cloud)

Runs the same app as the Cloudflare Worker, but entirely on this computer:

- **Office link:** http://<office-Wi-Fi-IP>:4200 (auto-detected; currently 172.16.0.177 — check `/api/status`)
- **By hostname:** http://DESKTOP-BU8F10S:4200
- **On this PC:** http://127.0.0.1:4200

Anyone on the office Wi-Fi can open it. It does **not** need Cloudflare or the internet.

Nothing to install: it uses the Node.js that is already on this PC and Node's built-in SQLite.

## What runs

| Piece | What it does |
|---|---|
| `server.mjs` | Serves the app and runs the real Worker code (`../src/index.js`) on Node |
| `data/call-app.sqlite` | The database (users, contacts, every call attempt) |
| `run.ps1` | Keeps Node running; if it crashes it starts again after 10 seconds |
| `watchdog.ps1` | Checks `/healthz` every 20 s; after 3 failures it restarts the service |
| `install.ps1` | Puts two hidden launchers in the Startup folder so both start at logon |
| `logs/` | `call-app.log`, `call-app-error.log`, `watchdog.log` |

## Install / start

```powershell
powershell -ExecutionPolicy Bypass -File worker\local\install.ps1
```

It starts the service immediately and again at every Windows logon.

## Stop / remove

```powershell
powershell -ExecutionPolicy Bypass -File worker\local\install.ps1 -Uninstall
```

Temporary stop: `powershell -File worker\local\watchdog.ps1 stop` (the watchdog keeps running but
the stop flag ends `run.ps1`; remove `worker\local\call-app.stop` and start again to resume).

## Mobile data access (phone not on office Wi-Fi)

The office link (the current Wi-Fi IP) only works on the office Wi-Fi. To scan a QR code
from a phone that is on mobile data, point the app at a reachable address:

1. Set the address in `worker/local/public-base-url.txt` (one line, e.g.
   `http://desktop-bu8f10s.tail339620.ts.net:4200` for Tailscale, or an ngrok URL).
   `server.mjs` reads this file on startup (env var `PUBLIC_BASE_URL` also works and
   takes precedence).
2. Restart the service (kill the process on port 4200 and let run.ps1 start it again).
3. QR codes generated afterwards use the new address.

### Option A - Tailscale (recommended, stable, free)

- Install Tailscale on this PC and on the phone, sign in with the same account.
- The PC gets a stable address like `http://desktop-bu8f10s.tail339620.ts.net:4200`.
- Put that in `public-base-url.txt`, restart. The phone (on mobile data, Tailscale on)
  can now open every QR code.

### Option B - ngrok (no app on the phone, but needs a free account)

- Create a free account, run `ngrok config add-authtoken <token>`.
- Run `ngrok http 4200`, copy the `https://....ngrok-free.app` URL into
  `public-base-url.txt`, restart.
- The URL changes each run unless you claim a free static domain in the ngrok dashboard.

### Reverting to office Wi-Fi only

Delete `worker/local/public-base-url.txt` (or empty it) and restart. The app goes back to
auto-detecting the office LAN IP.

## Check it is alive

```powershell
Invoke-RestMethod http://127.0.0.1:4200/healthz
```

Expected: `ok : True`.

## Backup

The whole database is one file. Copy it while the service is stopped, or use SQLite's online backup:

```powershell
stop:  powershell -File worker\local\watchdog.ps1 stop
copy:  Copy-Item worker\local\data\call-app.sqlite "D:\backups\call-app-$(Get-Date -f yyyyMMdd).sqlite"
start: powershell -ExecutionPolicy Bypass -File worker\local\install.ps1
```

## Good to know

- **The PC must stay on and you must be signed in to Windows**, exactly like the LOTS CRM.
- **The IP is DHCP** (172.16.0.177 today, was 172.16.0.238 earlier). If it changes, QR codes update
  automatically — the server detects the current LAN IP at startup. Run `ipconfig` for the new address
  or check `/api/status`. **HRMS is unaffected** because it syncs via `http://127.0.0.1:4200`
  (both apps run on this PC), and the call app returns the current LAN URL for the QR.
- The **Cloudflare copy is a separate database.** The two do not sync automatically. This office
  copy is now the one HRMS talks to (`VITE_CALL_APP_URL=http://127.0.0.1:4200` in the HRMS `.env`).
- Phone QR codes point at `http://<current-office-IP>:4200/...`, so the phone must be on the office Wi-Fi
  when scanning.
- Login is the same account as before (`admin@example.com` / `Admin@1234` until you change it).
