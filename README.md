# HR Click-to-Call

Click **Call** on your laptop → your phone rings → the candidate is bridged in.
Every attempt is stored with pickup time, hang-up time, talk duration and status.

- **Running app:** `simple/` (Node 22+ / Express / built-in `node:sqlite`)
- **Landing page:** `docs/` (published by GitHub Pages — this folder only, no app source)
- **Hosting:** see [`DEPLOY.md`](DEPLOY.md) (Render blueprint, Railway, Fly, or a fixed Cloudflare tunnel)

```powershell
cd simple
npm install
npm start            # http://localhost:3000  (demo mode without Twilio)
```

---

# Legacy implementation notes (PHP + React)

## What was done today

### 1. Backend (PHP)
Created API endpoints in `backend/api/`:
- `me.php` - Check authentication status and get current user
- `auth.php` / `login.php` - Login with email/password, session m#anagement
- `csrf.php` - Get CSRF token for POST requests
- `candidate.php` - Fetch candidate by ID via active CRM connection using GenericCrmAdapter; returns normalized candidate + call count
- `call-attempt.php` - Record call attempt (POST), CSRF protected, uses idempotency key, returns updated call count
- `call-attempts.php` - Get call attempt history for a candidate

Updated helpers:
- `response.php` - CORS handling, JSON responses
- `auth.php` - Session management, auth/CSRF helpers
- `config.php` - Updated allowed origins

### 2. Frontend (React + Vite)
Created React app in `frontend/` with:
- `Login.jsx` - Login page
- `QRScannerPage.jsx` - QR code scanner (html5-qrcode)
- `CandidateCall.jsx` - Candidate details, call count, call button (opens tel: after recording attempt)
- Routing with React Router
- Basic styling in `App.css`/`index.css`
- API integration with credentials + CSRF

Built successfully: `frontend/dist/` contains production build.

### 3. Key features
- Login with existing CRM auth (uses `hr_users` table)
- QR scanning to resolve candidate ID
- Candidate lookup via GenericCrmAdapter against active CRM connection
- Call attempts logged to `call_attempts` table
- Call count displayed from server
- Opens device dialer via `tel:` after successful attempt recording
- CSRF protection, CORS, session cookies

## How to run

### Backend (PHP server)
```bash
cd backend
php -S localhost:8000
```
Or configure web server to serve PHP files; API routes are under `/api/`.

### Frontend
Dev: `cd frontend && npm run dev` (proxies /api to localhost:8000)
Prod: serve `frontend/dist/` files.

## Notes
- App uses existing CRM schema (crm_connections, call_attempts, hr_users). No separate candidate DB introduced.
- Per requirement: "app only should work as a pathway for call only" - it records call attempts and opens dialer, no VoIP tracking.

