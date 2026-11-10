# HR call app — Cloudflare Workers + D1

This is the permanent-host version of `../simple` (Node + SQLite). Same API,
same dashboard, same QR flow, but the database is Cloudflare D1 (managed
SQLite) and there is no server to keep alive and no tunnel.

```
laptop click ──▶ Worker /api/contacts/:id/call ──▶ Twilio rings HR mobile
                                                        │
                                              candidate bridged
                                                        │
                        D1: call_attempts (status, answered_at, duration)
                                                        │
                          HRMS ──▶ POST /api/sync-from-hrms (QR + stats)
                          Phone ─▶ /c/<token> (QR target, measures talk time)
```

## Why this replaced the tunnel

The Node app needed `cloudflared` to be reachable from a phone. Quick tunnels
get a new random hostname every restart, so every QR code died with them.
Workers give a stable `https://<name>.<subdomain>.workers.dev` URL (or a custom
domain) and D1 keeps the data.

## Deploy (once)

```powershell
cd worker
npm install

# 1. Log in (opens the browser)
npx wrangler login

# 2. Create the database and copy the printed database_id
npx wrangler d1 create hr-call
#    -> paste the id into wrangler.toml  [[d1_databases]] database_id

# 3. Ship it
npx wrangler deploy
```

The first admin is created automatically on the first request:

```
email:    admin@example.com
password: Admin@1234        <-- change it after logging in
```

## Optional secrets

```powershell
# Real click-to-call (otherwise demo mode: counts calls, rings nothing)
npx wrangler secret put TWILIO_ACCOUNT_SID
npx wrangler secret put TWILIO_AUTH_TOKEN
npx wrangler secret put TWILIO_FROM_NUMBER

# Microsoft Graph address book (otherwise demo contacts)
npx wrangler secret put GRAPH_TENANT_ID
npx wrangler secret put GRAPH_CLIENT_ID
npx wrangler secret put GRAPH_CLIENT_SECRET
```

After setting secrets, point Twilio's number webhook at
`https://<worker>/api/voice/status` (the app sets this per-call already).

## Endpoints (identical to the Node version)

| Method | Path | Purpose |
|---|---|---|
| GET | `/healthz` | uptime probe |
| POST | `/api/login` · `/api/logout` · GET `/api/me` | sessions (HttpOnly cookie) |
| POST | `/api/settings` | save the HR mobile number |
| GET/POST | `/api/contacts` | list / add (per owner) |
| GET/DELETE | `/api/contacts/:id` | detail + history / delete |
| POST | `/api/contacts/:id/call` | bridge: ring HR mobile then candidate |
| POST | `/api/sync-from-hrms` | create/reuse candidate, return QR + stats |
| GET | `/api/contact-stats/:token` | shared counts for the Pages app |
| POST | `/api/log-call` | phone-measured call (idempotent via `clientId`) |
| GET | `/c/:token` | QR target page |
| GET | `/qr/:token.svg` (`.png` alias) | QR image (SVG) |
| POST | `/api/public/:token/call` | count / bridge from the phone |
| POST | `/api/public/:token/call[/:id]/finish` | save measured talk time |
| GET/POST | `/api/voice/twiml` · `/api/voice/status` | Twilio webhooks |

## Differences from the Node version

- **Passwords**: PBKDF2-SHA256 (WebCrypto) instead of Node's scrypt —
  Workers has no scrypt. Existing scrypt hashes would need a reset, but D1
  starts empty and seeds a fresh admin.
- **QR image**: SVG instead of PNG. `/qr/:token.png` still returns an image
  (`image/svg+xml`) so old `<img>` tags keep working.
- **`client_id` column**: makes `POST /api/log-call` idempotent. The Pages app
  posts once when the call starts and again with the duration; without this
  the same call was counted twice.
- **`PUBLIC_BASE_URL` is optional**: defaults to the request origin, so QR
  links are correct on `workers.dev` and on a custom domain without editing.

## Local testing

`wrangler dev` needs `workerd.exe`, which some managed Windows machines block
via Application Control policy. If that happens here, use the offline suite —
it runs the real worker code against `node:sqlite`:

```powershell
node scripts/smoke.mjs     # 35 checks: auth, CRUD, sync, idempotency, QR, webhooks
```

`npx wrangler deploy --dry-run` also validates the bundle without running it.

## Migrating existing data (optional)

The Node app's `simple/data.sqlite` can be exported per table and replayed
into D1:

```powershell
npx wrangler d1 execute hr-call --remote --command "SELECT COUNT(*) FROM contacts"
```

Insert statements must be generated from the Node DB (ids preserved, tokens
unchanged) so QR links already handed out keep working.
