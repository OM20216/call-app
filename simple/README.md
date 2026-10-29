# Graph Call (simple)

A deliberately small HR click-to-call tool.

- **Microsoft Graph** is used as the **address book only** (people + phone numbers).
- Every contact you add gets its own **QR code**.
- Clicking **Call** on the laptop **rings the HR's own mobile**, then connects them to the contact.
- Every call is counted, **per HR, per contact**.

> This is a new, stripped-down app. The old PHP/React version in the parent folder
> (`backend/`, `frontend/`, `database/`) is left untouched.

---

## Run it

```powershell
cd "C:\Users\admin\Desktop\call app\simple"
npm install
npm start
```

Then open <http://localhost:3000>.

First sign-in (created automatically on first run):

```
admin@example.com  /  Admin@1234
```

The first time you sign in, the app asks for your own mobile number. That is
the number it rings when you press Call (change it later by clicking it in the top bar).

It runs in **demo mode** out of the box: you get a sample address book and calls
are counted but no real phone rings. Add credentials below to go live.

---

## Configure Microsoft Graph (address book)

1. Azure Portal → **App registrations** → **New registration**. Note the
   **Directory (tenant) ID** and **Application (client) ID**.
2. **API permissions** → Add → Microsoft Graph → **Application permissions** →
   `User.Read.All` → **Grant admin consent**.
3. **Certificates & secrets** → New client secret → copy the value.
4. Create `simple/.env` (copy `.env.example`) and fill in:

```
GRAPH_TENANT_ID=...
GRAPH_CLIENT_ID=...
GRAPH_CLIENT_SECRET=...
```

Restart. **+ Add person** now searches your real directory.

## Configure the calling bridge (Twilio)

Microsoft Graph cannot ring a phone number, so click-to-call uses a small phone
bridge. [Twilio](https://console.twilio.com) is the default provider: the server
calls *your* mobile, and when you answer it dials the contact and joins you.

Add to `simple/.env`:

```
TWILIO_ACCOUNT_SID=...
TWILIO_AUTH_TOKEN=...
TWILIO_FROM_NUMBER=+1...          # a number you own in Twilio
PUBLIC_BASE_URL=https://your-host # must be reachable by Twilio (ngrok for local testing)
```

Restart. Pressing **Call** now really rings your mobile.

---

## How to use it

Everything is on one screen:

1. **Enter your mobile number** (asked once, at the top).
2. **+ Add person** → search the address book → **Add**.
3. Press **Call** next to a person. Your phone rings; answer it and you are connected. The count goes up by 1.
4. **More** shows that person's QR code, their call history, and "Remove from my list".

Scanning the QR with a phone opens a small page with one **Call now** button that
dials straight from the phone (also counted).

Counts are stored per contact; contacts are private to the HR who added them, so
each HR has their own list and their own counts.

## Files

```
simple/
  server.js           Express routes + the public QR page
  src/config.js       .env loader + mode switches
  src/db.js           SQLite schema (built into Node, no DB server)
  src/auth.js         scrypt passwords + sessions
  src/graph.js        Microsoft Graph address book (with demo fallback)
  src/telephony.js    Twilio click-to-call bridge (with demo fallback)
  public/             login + dashboard (plain HTML/CSS/JS, no build step)
  data.sqlite         created on first run
```

## Notes

- Passwords use scrypt; sessions are httpOnly cookies valid for 7 days.
- The `sid` cookie is not `Secure` because it is meant for `http://localhost`.
  Put it behind HTTPS in production and add `Secure` in `server.js`.
- The `/api/voice/twiml` webhook is public (Twilio must reach it) and only echoes
  back the `to` number it is given — no data is exposed.
