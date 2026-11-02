# Hosting the Call App

The call app is a single Node service (`simple/`) with a SQLite file. Anything
that can run a container or `node server.js` can host it. HRMS is a **separate**
service and is not included in these steps (see the last section).

Everything below assumes the GitHub repo `OM20216/call-app` (already pushed).

---

## What the host must provide

| Need | Why |
|---|---|
| Node **22+** | `node:sqlite` is built into Node, no native compile |
| A **persistent disk** mounted somewhere | SQLite file must survive restarts/deploys |
| HTTPS | phone QR links + Twilio webhooks |
| Always-on (no sleep) | a sleeping app misses Twilio webhooks → calls fail |

Environment variables (all optional until you enable that feature):

| Variable | Example | Purpose |
|---|---|---|
| `PORT` | injected by host | listen port |
| `DATA_DIR` | `/data` | folder that holds `data.sqlite` (mount your disk here) |
| `PUBLIC_BASE_URL` | `https://call.yourdomain.com` | **required in production** — used in QR URLs and Twilio callbacks |
| `TWILIO_ACCOUNT_SID` | `AC…` | real calls |
| `TWILIO_AUTH_TOKEN` | `…` | real calls |
| `TWILIO_FROM_NUMBER` | `+1…` | caller ID / the number Twilio dials from |
| `GRAPH_TENANT_ID` / `GRAPH_CLIENT_ID` / `GRAPH_CLIENT_SECRET` | | optional Microsoft address book |

Health check endpoint: `GET /healthz` → `{"ok":true,...}`

---

## Option A — Render (easiest, managed)

`render.yaml` in this repo already describes the service.

1. Go to <https://dashboard.render.com> → **New +** → **Blueprint**.
2. Connect GitHub → choose `OM20216/call-app` → Apply.
3. When asked, fill the env vars (`PUBLIC_BASE_URL` = the `https://…onrender.com`
   URL Render shows, Twilio keys if you have them). Save.
4. Wait for the first build, then open `https://<name>.onrender.com/healthz`.

Cost note: a persistent disk requires the **Starter** plan (~$7/mo). The free
plan has no disk — `data.sqlite` is wiped on every deploy/restart, so call
counts and durations would reset. Free instances also sleep after 15 min.

After the service is up:

```text
PUBLIC_BASE_URL = https://<name>.onrender.com
DATA_DIR        = /data            (disk mounted at /data)
```

## Option B — Railway

1. <https://railway.app> → **New Project** → **Deploy from GitHub repo** → `call-app`.
2. Railway detects `simple/Dockerfile` (see `railway.json`).
3. Add a **Volume** mounted at `/data`, set `DATA_DIR=/data`.
4. Add `PUBLIC_BASE_URL=https://<your>.up.railway.app` (+ Twilio vars).
5. Deploy. Hobby plan is ~$5/mo including a small volume.

## Option C — Fly.io

```powershell
fly launch --dockerfile simple/Dockerfile --name hr-call-app
fly volumes create call_data --size 1
# fly.toml: mount the volume at /data and set the env vars
fly secrets set PUBLIC_BASE_URL=https://hr-call-app.fly.dev TWILIO_ACCOUNT_SID=... TWILIO_AUTH_TOKEN=... TWILIO_FROM_NUMBER=+1...
fly deploy
```

## Option D — keep this PC, but with a fixed URL (free)

Instead of the temporary `trycloudflare.com` URL, create a **named** Cloudflare
tunnel attached to a domain you own. The URL then never changes:

```powershell
cloudflared tunnel login
cloudflared tunnel create hr-call
cloudflared tunnel route dns hr-call call.yourdomain.com
cloudflared tunnel run --url http://localhost:3000 hr-call
```

Then `PUBLIC_BASE_URL=https://call.yourdomain.com` and run cloudflared as a
Windows service (`cloudflared service install`). The PC must stay on.

---

## After the first deploy (must do)

1. **Set `PUBLIC_BASE_URL`** to the final HTTPS URL, then restart the service.
   QR codes and Twilio callbacks are generated from it, so no console edits
   are needed on the Twilio side.
2. **Move the existing database** (optional — keeps real call history).
   Either upload it to the disk:
   ```powershell
   # Render: Dashboard -> your service -> Shell
   #   then upload data.sqlite to /data   (or use scp with the SSH address)
   ```
   or skip it and simply re-sync candidates from HRMS — contacts are recreated,
   but old attempts/counts are lost.
3. **Point HRMS at the new URL** in `HR CRM(OFFICIAL)/HRMS/.env`:
   ```env
   VITE_CALL_APP_URL=https://call.yourdomain.com
   VITE_CALL_PUBLIC_URL=https://call.yourdomain.com
   ```
   then `npm run build` in HRMS (and redeploy/restart HRMS).
4. **Re-download each QR** in HRMS (the old codes still contain the tunnel URL).
5. Verify:
   ```powershell
   curl.exe https://call.yourdomain.com/healthz
   curl.exe https://call.yourdomain.com/api/sync-from-hrms
   ```
   Scan a QR on the phone → tap Call → return → duration should appear.

## Security checklist before going public

- [ ] Set a real admin password (the seeded `admin@example.com` / demo login is not safe on the internet).
- [ ] Twilio credentials in host env vars only — never in git.
- [ ] Consider `ALLOWED_ORIGINS` for `/api/sync-from-hrms` (currently CORS is open).
- [ ] Back up `/data/data.sqlite` (Render disks are not a backup).

## Hosting HRMS too

HRMS is separate: Vite static build + `server/index.js` on port 5000, needing
`MS_CLIENT_SECRET` (SharePoint) and its own HTTPS URL. That is a second service
(Render Static Site + Web Service, or the same VPS). Ask and it can be prepared
the same way.
