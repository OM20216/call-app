import express from 'express';
import crypto from 'node:crypto';
import path from 'node:path';
import QRCode from 'qrcode';

import { config, rootDir, graphEnabled, twilioEnabled } from './src/config.js';
import db, { num } from './src/db.js';
import { hashPassword, verifyPassword, createSession, findSession, destroySession } from './src/auth.js';
import { loadPeople, searchPeople } from './src/graph.js';
import { placeBridgedCall, twimlFor } from './src/telephony.js';

const app = express();
app.use(express.json());
app.use(express.urlencoded({ extended: false }));

/* ------------------------------------------------------------------ */
/* helpers                                                             */
/* ------------------------------------------------------------------ */

function parseCookies(req) {
  const out = {};
  for (const part of String(req.headers.cookie || '').split(';')) {
    const i = part.indexOf('=');
    if (i > -1) out[part.slice(0, i).trim()] = decodeURIComponent(part.slice(i + 1).trim());
  }
  return out;
}

const publicUser = (u) => ({
  id: num(u.id),
  email: u.email,
  fullName: u.full_name,
  mobile: u.mobile || '',
  role: u.role,
});

app.use((req, _res, next) => {
  req.user = findSession(parseCookies(req).sid);
  next();
});

function requireAuth(req, res, next) {
  if (!req.user) return res.status(401).json({ error: 'Not signed in.' });
  next();
}

const cleanPhone = (v) => String(v || '').replace(/[^+\d]/g, '');

function contactByToken(token) {
  return db
    .prepare(
      `SELECT c.*,
              (SELECT COUNT(*) FROM call_attempts a WHERE a.contact_id = c.id) AS call_count
         FROM contacts c WHERE c.public_token = ?`,
    )
    .get(token);
}

function recordAttempt(contactId, hrId, status, sid) {
  db.prepare(
    'INSERT INTO call_attempts (contact_id, hr_id, status, provider_sid) VALUES (?, ?, ?, ?)',
  ).run(contactId, hrId, status, sid || null);
  return num(db.prepare('SELECT COUNT(*) AS n FROM call_attempts WHERE contact_id = ?').get(contactId).n);
}

const escapeHtml = (s) =>
  String(s ?? '').replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' })[c]);

/* ------------------------------------------------------------------ */
/* seed a first admin so there is a way in                             */
/* ------------------------------------------------------------------ */

function seed() {
  const n = num(db.prepare('SELECT COUNT(*) AS n FROM hr_users').get().n);
  if (n === 0) {
    db.prepare(
      'INSERT INTO hr_users (email, password_hash, full_name, role, mobile) VALUES (?, ?, ?, ?, ?)',
    ).run('admin@example.com', hashPassword('Admin@1234'), 'App Administrator', 'admin', '');
    console.log('Seeded first user ->  admin@example.com / Admin@1234');
    console.log('Sign in, open Settings, and add YOUR mobile number.');
  }
}
seed();

/* ------------------------------------------------------------------ */
/* auth routes                                                         */
/* ------------------------------------------------------------------ */

app.post('/api/login', (req, res) => {
  const email = String(req.body?.email || '').trim().toLowerCase();
  const password = String(req.body?.password || '');
  const user = db.prepare('SELECT * FROM hr_users WHERE email = ?').get(email);
  if (!user || !verifyPassword(password, user.password_hash)) {
    return res.status(401).json({ error: 'Wrong email or password.' });
  }
  const { token, expiresAt } = createSession(user.id);
  res.setHeader(
    'Set-Cookie',
    `sid=${token}; HttpOnly; Path=/; SameSite=Lax; Expires=${expiresAt.toUTCString()}`,
  );
  res.json({ user: publicUser(user) });
});

app.post('/api/logout', (req, res) => {
  destroySession(parseCookies(req).sid);
  res.setHeader('Set-Cookie', 'sid=; HttpOnly; Path=/; Max-Age=0');
  res.json({ ok: true });
});

app.get('/api/me', (req, res) => {
  if (!req.user) return res.json({ authenticated: false });
  res.json({ authenticated: true, user: publicUser(req.user) });
});

app.post('/api/settings', requireAuth, (req, res) => {
  const mobile = cleanPhone(req.body?.mobile);
  db.prepare('UPDATE hr_users SET mobile = ? WHERE id = ?').run(mobile, req.user.id);
  res.json({ ok: true, user: { ...publicUser(req.user), mobile } });
});

app.get('/api/status', requireAuth, (_req, res) => {
  res.json({
    graphMode: graphEnabled ? 'microsoft-graph' : 'demo',
    callingMode: twilioEnabled ? 'twilio' : 'demo',
    publicBaseUrl: config.publicBaseUrl,
  });
});

/* ------------------------------------------------------------------ */
/* address book (Microsoft Graph)                                      */
/* ------------------------------------------------------------------ */

app.get('/api/address-book', requireAuth, async (req, res) => {
  try {
    const people = await loadPeople();
    const matches = searchPeople(people, req.query.q).slice(0, 50);
    const mine = new Set(
      db
        .prepare('SELECT graph_id FROM contacts WHERE owner_id = ? AND graph_id IS NOT NULL')
        .all(req.user.id)
        .map((r) => r.graph_id),
    );
    res.json({
      source: graphEnabled ? 'microsoft-graph' : 'demo',
      people: matches.map((p) => ({ ...p, added: mine.has(p.graphId) })),
    });
  } catch (e) {
    res.status(502).json({ error: e.message });
  }
});

/* ------------------------------------------------------------------ */
/* my contacts                                                         */
/* ------------------------------------------------------------------ */

const contactJson = (row) => ({
  id: num(row.id),
  name: row.name,
  phone: row.phone,
  email: row.email,
  jobTitle: row.job_title,
  token: row.public_token,
  callCount: num(row.call_count ?? 0),
  lastCalled: row.last_called || null,
});

app.get('/api/contacts', requireAuth, (req, res) => {
  const rows = db
    .prepare(
      `SELECT c.*,
              (SELECT COUNT(*) FROM call_attempts a WHERE a.contact_id = c.id) AS call_count,
              (SELECT MAX(created_at) FROM call_attempts a WHERE a.contact_id = c.id) AS last_called
         FROM contacts c
        WHERE c.owner_id = ?
        ORDER BY c.name COLLATE NOCASE`,
    )
    .all(req.user.id);
  res.json({ contacts: rows.map(contactJson) });
});

app.post('/api/contacts', requireAuth, (req, res) => {
  const name = String(req.body?.name || '').trim();
  const phone = cleanPhone(req.body?.phone);
  if (!name || !phone) return res.status(400).json({ error: 'Name and phone are required.' });
  try {
    const info = db
      .prepare(
        `INSERT INTO contacts (owner_id, graph_id, public_token, name, phone, email, job_title)
         VALUES (?, ?, ?, ?, ?, ?, ?)`,
      )
      .run(
        req.user.id,
        req.body?.graphId || null,
        crypto.randomBytes(16).toString('hex'),
        name,
        phone,
        String(req.body?.email || '').trim(),
        String(req.body?.jobTitle || '').trim(),
      );
    res.status(201).json({ id: num(info.lastInsertRowid) });
  } catch (e) {
    if (String(e.message).includes('UNIQUE')) {
      return res.status(409).json({ error: 'That number is already in your list.' });
    }
    res.status(500).json({ error: e.message });
  }
});

app.get('/api/contacts/:id', requireAuth, (req, res) => {
  const row = db
    .prepare(
      `SELECT c.*,
              (SELECT COUNT(*) FROM call_attempts a WHERE a.contact_id = c.id) AS call_count,
              (SELECT MAX(created_at) FROM call_attempts a WHERE a.contact_id = c.id) AS last_called
         FROM contacts c WHERE c.id = ? AND c.owner_id = ?`,
    )
    .get(num(req.params.id), req.user.id);
  if (!row) return res.status(404).json({ error: 'Not found.' });
  const history = db
    .prepare(
      'SELECT status, created_at FROM call_attempts WHERE contact_id = ? ORDER BY id DESC LIMIT 20',
    )
    .all(row.id);
  res.json({ contact: contactJson(row), history });
});

app.delete('/api/contacts/:id', requireAuth, (req, res) => {
  const info = db
    .prepare('DELETE FROM contacts WHERE id = ? AND owner_id = ?')
    .run(num(req.params.id), req.user.id);
  if (!info.changes) return res.status(404).json({ error: 'Not found.' });
  res.json({ ok: true });
});

/* Laptop flow: ring MY mobile, then connect me to the contact. */
app.post('/api/contacts/:id/call', requireAuth, async (req, res) => {
  const contact = db
    .prepare('SELECT * FROM contacts WHERE id = ? AND owner_id = ?')
    .get(num(req.params.id), req.user.id);
  if (!contact) return res.status(404).json({ error: 'Not found.' });

  const mobile = cleanPhone(req.body?.mobile || req.user.mobile);
  if (!mobile) {
    return res.status(400).json({ error: 'Add your mobile number in Settings first.' });
  }

  const result = await placeBridgedCall({ hrMobile: mobile, contactPhone: contact.phone });
  if (!result.ok) return res.status(502).json({ error: result.error });

  const callCount = recordAttempt(
    contact.id,
    req.user.id,
    result.mock ? 'demo' : 'bridged',
    result.sid,
  );
  res.json({ ok: true, mock: !!result.mock, message: result.message, callCount });
});

/* ------------------------------------------------------------------ */
/* public QR target  (/c/<token>  and  /qr/<token>.png)                */
/* ------------------------------------------------------------------ */

app.get('/qr/:token.png', (req, res) => {
  const contact = contactByToken(req.params.token);
  if (!contact) return res.status(404).end();
  const target = `${config.publicBaseUrl}/c/${contact.public_token}`;
  QRCode.toBuffer(target, { width: 320, margin: 1, errorCorrectionLevel: 'M' }, (err, buf) => {
    if (err) return res.status(500).end();
    res.type('png').send(buf);
  });
});

app.get('/c/:token', (req, res) => {
  const c = contactByToken(req.params.token);
  if (!c) return res.status(404).send('<h1>Contact not found</h1>');

  const tel = c.phone.replace(/[^+\d]/g, '');
  const count = num(c.call_count);

  res.type('html').send(`<!doctype html>
<html lang="en"><head>
<meta charset="utf-8"><meta name="viewport" content="width=device-width, initial-scale=1">
<title>${escapeHtml(c.name)}</title>
<style>
  :root { color-scheme: light; }
  body { margin:0; font:16px/1.5 system-ui,Segoe UI,Roboto,sans-serif; background:#f4f6fb; color:#1b2437; }
  .wrap { max-width:460px; margin:0 auto; padding:24px 18px 40px; }
  .card { background:#fff; border:1px solid #e3e8f2; border-radius:16px; padding:22px; box-shadow:0 8px 24px rgba(20,35,70,.06); }
  h1 { margin:0 0 2px; font-size:22px; }
  .muted { color:#6b7690; font-size:14px; }
  .count { display:inline-block; margin-top:10px; background:#e8f5ee; color:#176b3a; font-weight:600; font-size:14px; padding:4px 12px; border-radius:999px; }
  .phone { font-size:20px; font-weight:600; margin:16px 0 4px; }
  a.big { display:block; text-align:center; text-decoration:none; font-weight:700; font-size:18px; padding:16px; border-radius:12px; margin-top:14px; }
  a.call { background:#1f8a4c; color:#fff; }
  #status { margin-top:12px; font-size:14px; color:#2f7a4f; }
</style></head>
<body><div class="wrap"><div class="card">
  <h1>${escapeHtml(c.name)}</h1>
  <div class="muted">${escapeHtml(c.jobTitle || '')}${c.jobTitle && c.email ? ' · ' : ''}${escapeHtml(c.email || '')}</div>
  <div class="count">Called ${count} time${count === 1 ? '' : 's'}</div>
  <div class="phone">${escapeHtml(c.phone)}</div>
  <a class="big call" id="call" href="tel:${tel}">Call now</a>
  <div id="status" role="status"></div>
</div></div>
<script>
  const token = ${JSON.stringify(c.public_token)};
  const statusEl = document.getElementById('status');
  async function record(mode) {
    try {
      const r = await fetch('/api/public/' + token + '/call', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ mode })
      });
      const d = await r.json();
      if (!r.ok) { statusEl.style.color = '#b4243a'; statusEl.textContent = d.error || 'Could not start the call.'; return; }
      statusEl.style.color = '#2f7a4f';
      statusEl.textContent = 'Calling… (total calls: ' + d.callCount + ')';
    } catch (e) { statusEl.style.color = '#b4243a'; statusEl.textContent = 'Network error.'; }
  }
  document.getElementById('call').addEventListener('click', () => record('direct'));
</script>
</body></html>`);
});

/* Called from the QR page: "direct" just counts, "bridge" rings the HR mobile. */
app.post('/api/public/:token/call', async (req, res) => {
  const c = contactByToken(req.params.token);
  if (!c) return res.status(404).json({ error: 'Not found.' });

  const mode = req.body?.mode === 'bridge' ? 'bridge' : 'direct';
  const owner = db.prepare('SELECT * FROM hr_users WHERE id = ?').get(c.owner_id);

  if (mode === 'bridge') {
    const mobile = cleanPhone(owner?.mobile);
    if (!mobile) {
      return res.status(400).json({ error: 'The HR has not set their mobile number yet (Settings tab).' });
    }
    const result = await placeBridgedCall({ hrMobile: mobile, contactPhone: c.phone });
    if (!result.ok) return res.status(502).json({ error: result.error });
    const callCount = recordAttempt(c.id, c.owner_id, result.mock ? 'demo' : 'bridged', result.sid);
    return res.json({ ok: true, mock: !!result.mock, message: result.message, callCount });
  }

  const callCount = recordAttempt(c.id, c.owner_id, 'direct', null);
  res.json({ ok: true, mock: false, callCount });
});

/* ------------------------------------------------------------------ */
/* Twilio webhook: runs when the HR answers their mobile               */
/* ------------------------------------------------------------------ */

app.all('/api/voice/twiml', (req, res) => {
  const to = req.query.to || req.body?.to || req.body?.To;
  res.type('text/xml').send(twimlFor(to));
});

/* ------------------------------------------------------------------ */
/* static frontend                                                     */
/* ------------------------------------------------------------------ */

app.use(express.static(path.join(rootDir, 'public')));

app.use((req, res) => res.status(404).json({ error: `Unknown route ${req.method} ${req.path}` }));

app.listen(config.port, () => {
  console.log(`\n  Graph Call is running ->  ${config.publicBaseUrl}`);
  console.log(`  Address book : ${graphEnabled ? 'Microsoft Graph' : 'DEMO data (set GRAPH_* in .env)'}`);
  console.log(`  Calling      : ${twilioEnabled ? 'Twilio bridge' : 'DEMO mode (set TWILIO_* in .env)'}\n`);
});
