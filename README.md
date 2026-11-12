# HR Click-to-Call

Click **Call** on your laptop → your phone dials the candidate on its own SIM (free, unlimited) →
every attempt is stored with status, pickup time, hang-up time, talk duration and full history.

## Main app (use this)

The permanent app is **`worker/`** (Cloudflare Workers + D1), live at:

**https://hr-call.hr-call-worker.workers.dev**

- Login: `admin@example.com` / `Admin@1234` (change after first login)
- No server to keep running, data persists in D1.
- Calling is **direct dial**: the QR page opens a `tel:` link on the HR's phone.
- Full guide: [`worker/README.md`](worker/README.md)

### Local testing

`wrangler dev` is blocked on some managed Windows machines (Application Control policy), so use
the offline suite — it runs the real worker code against `node:sqlite`:

```powershell
cd worker
node scripts/smoke.mjs     # 36 checks: auth, CRUD, sync, idempotency, QR, webhooks
```

`npm start` opens the live app (https://hr-call.hr-call-worker.workers.dev) in your default browser.
`npm test` runs `node --check` + the 36-check smoke suite (`worker/scripts/smoke.mjs`).

## Legacy variants (do NOT use for the new app)

These older experiments are still in the repo but are **not** the main app:

| Folder | Stack | Notes |
|---|---|---|
| `simple/` | Node + Express + SQLite | Old Node version; `npm start` used to run this. Now `npm run start:legacy`. |
| `frontend/` | React + Vite + PHP backend | Expects `backend/` (PHP) on port 8000. |
| `backend/` | PHP API | Legacy CRM adapter. |
| `docs/` | GitHub Pages | Static landing + redundant dashboard; QRs now point at the Worker. |

If you ran `npm start` in VS Code before and saw a different UI, that's why — it launched the
legacy `simple/` app. Use the live Worker URL above (or `worker/scripts/smoke.mjs` locally).

## HRMS integration

`HR CRM(OFFICIAL)/HRMS` talks to the Worker via `VITE_CALL_APP_URL` / `VITE_CALL_PUBLIC_URL`
(already set to the Worker URL). Candidate → QR → call flow works; writing call results back
to SharePoint needs `MS_CLIENT_SECRET` (see `worker/README.md`).
