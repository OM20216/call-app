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

/* Let the HRMS (Vite dev server / built app) call this API from the browser. */
app.use((req, res, next) => {
  res.header('Access-Control-Allow-Origin', req.headers.origin || '*');
  res.header('Vary', 'Origin');
  res.header('Access-Control-Allow-Methods', 'GET, POST, DELETE, OPTIONS');
  res.header('Access-Control-Allow-Headers', 'Content-Type, X-API-Key');
  if (req.method === 'OPTIONS') return res.sendStatus(204);
  next();
});

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
  const info = db
    .prepare('INSERT INTO call_attempts (contact_id, hr_id, status, provider_sid) VALUES (?, ?, ?, ?)')
    .run(contactId, hrId, status, sid || null);
  const attempt = db.prepare('SELECT created_at FROM call_attempts WHERE id = ?').get(info.lastInsertRowid);
  const count = num(db.prepare('SELECT COUNT(*) AS n FROM call_attempts WHERE contact_id = ?').get(contactId).n);
  return { callCount: count, attemptId: num(info.lastInsertRowid), createdAt: attempt?.created_at || null };
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
  lastAnsweredAt: row.last_answered_at || null,
});

app.get('/api/contacts', requireAuth, (req, res) => {
  const rows = db
    .prepare(
      `SELECT c.*,
              (SELECT COUNT(*) FROM call_attempts a WHERE a.contact_id = c.id) AS call_count,
              (SELECT MAX(created_at) FROM call_attempts a WHERE a.contact_id = c.id) AS last_called,
              (SELECT MAX(answered_at) FROM call_attempts a WHERE a.contact_id = c.id AND a.answered_at IS NOT NULL) AS last_answered_at
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
              (SELECT MAX(created_at) FROM call_attempts a WHERE a.contact_id = c.id) AS last_called,
              (SELECT MAX(answered_at) FROM call_attempts a WHERE a.contact_id = c.id AND a.answered_at IS NOT NULL) AS last_answered_at
         FROM contacts c WHERE c.id = ? AND c.owner_id = ?`,
    )
    .get(num(req.params.id), req.user.id);
  if (!row) return res.status(404).json({ error: 'Not found.' });
  const history = db
    .prepare(
      `SELECT id, contact_id, hr_id, status, provider_sid, duration, answered_at, created_at
         FROM call_attempts
        WHERE contact_id = ?
        ORDER BY id DESC
        LIMIT 20`,
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

  const rec = recordAttempt(contact.id, req.user.id, result.mock ? 'demo' : 'placed', result.sid);
  res.json({
    ok: true,
    mock: !!result.mock,
    message: result.message,
    callCount: rec.callCount,
    attemptId: rec.attemptId,
    createdAt: rec.createdAt,
  });
});

/* ------------------------------------------------------------------ */
/* HRMS integration: sync a candidate + return its call page / QR      */
/* ------------------------------------------------------------------ */

function ownerForHrms(hrEmail) {
  const email = (String(hrEmail || '').match(/[A-Z0-9._%+-]+@[A-Z0-9.-]+\.[A-Z]{2,}/i) || [])[0];
  if (email) {
    const user = db.prepare('SELECT * FROM hr_users WHERE lower(email) = lower(?)').get(email);
    if (user) return user;
  }
  return db.prepare('SELECT * FROM hr_users ORDER BY id ASC LIMIT 1').get();
}

app.get('/api/sync-from-hrms', (_req, res) => {
  res.json({
    ok: true,
    service: 'graph-call',
    hint: 'POST candidateId, candidateName, contactNumber to create/reuse a contact and get a call QR.',
  });
});

app.post('/api/sync-from-hrms', (req, res) => {
  const b = req.body || {};
  const candidateId = String(b.candidateId || '').trim();
  const name = String(b.candidateName || b.fullName || '').trim();
  const phone = cleanPhone(b.contactNumber || b.mobileNumber || b.phone);
  const email = String(b.emailId || b.email || '').trim();
  const jobTitle = String(b.positionApplied || b.jobRole || b.position || '').trim();

  if (!name || !phone) {
    return res.status(400).json({ error: 'candidateName and contactNumber are required.' });
  }

  const owner = ownerForHrms(b.assignedTo || b.hrEmail || b.ownerEmail);
  if (!owner) {
    return res.status(500).json({ error: 'No HR user found. Open the call app once to create the admin account.' });
  }

  let contact = candidateId
    ? db.prepare('SELECT * FROM contacts WHERE owner_id = ? AND crm_candidate_id = ?').get(owner.id, candidateId)
    : null;
  if (!contact) {
    contact = db.prepare('SELECT * FROM contacts WHERE owner_id = ? AND phone = ?').get(owner.id, phone);
  }

  if (contact) {
    db.prepare(
      `UPDATE contacts
          SET name = ?, phone = ?, email = ?, job_title = ?,
              crm_candidate_id = COALESCE(?, crm_candidate_id)
        WHERE id = ?`,
    ).run(name, phone, email, jobTitle, candidateId || null, contact.id);
  } else {
    const info = db
      .prepare(
        `INSERT INTO contacts (owner_id, name, phone, email, job_title, public_token, crm_candidate_id)
         VALUES (?, ?, ?, ?, ?, ?, ?)`,
      )
      .run(owner.id, name, phone, email, jobTitle, crypto.randomBytes(16).toString('hex'), candidateId || null);
    contact = db.prepare('SELECT * FROM contacts WHERE id = ?').get(info.lastInsertRowid);
  }

  contact = db.prepare('SELECT * FROM contacts WHERE id = ?').get(contact.id);
  const stats = db
    .prepare(
      `SELECT COUNT(*) AS n,
              MAX(created_at) AS last_call,
              MAX(answered_at) AS last_answered,
              COALESCE(SUM(duration), 0) AS total_seconds
         FROM call_attempts WHERE contact_id = ?`,
    )
    .get(contact.id);
  const lastTimed = db
    .prepare(
      `SELECT duration, created_at, ended_at
         FROM call_attempts
        WHERE contact_id = ? AND duration IS NOT NULL
        ORDER BY id DESC LIMIT 1`,
    )
    .get(contact.id);

  res.json({
    ok: true,
    candidateId,
    contactId: num(contact.id),
    token: contact.public_token,
    owner: { id: num(owner.id), email: owner.email, name: owner.full_name },
    callCount: num(stats.n),
    lastCallAt: stats.last_call || null,
    lastAnsweredAt: stats.last_answered || null,
    lastDuration: lastTimed ? num(lastTimed.duration) : null,
    lastDurationAt: lastTimed ? lastTimed.created_at : null,
    totalSeconds: num(stats.total_seconds),
    url: `${config.publicBaseUrl}/c/${contact.public_token}`,
    qrPng: `${config.publicBaseUrl}/qr/${contact.public_token}.png`,
  });
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

  const history = db
    .prepare(
      `SELECT id, status, provider_sid, duration, answered_at, ended_at, created_at
         FROM call_attempts
        WHERE contact_id = ?
        ORDER BY id DESC
        LIMIT 10`,
    )
    .all(c.id);

  const label = (s) =>
    ({
      direct: 'Called',
      demo: 'Demo call',
      placed: 'Ringing',
      bridged: 'Answered',
      completed: 'Completed',
      busy: 'Busy',
      'no-answer': 'No answer',
      failed: 'Failed',
      canceled: 'Cancelled',
    })[s] || (s ? s[0].toUpperCase() + s.slice(1) : 'Call');

  const fmtDur = (v) => {
    const s = Math.max(0, Math.round(Number(v) || 0));
    const m = Math.floor(s / 60);
    return m ? `${m}m ${String(s % 60).padStart(2, '0')}s` : `${s}s`;
  };

  const historyHtml = history.length
    ? `<h2 class="history-title">Call history</h2><ul class="history">` +
      history
        .map((h) => {
          const when = h.answered_at || h.created_at;
          const bits = [];
          if (h.duration != null) bits.push(`${fmtDur(h.duration)} talk time`);
          if (h.answered_at) bits.push('Answered');
          if (h.duration == null && !h.answered_at) bits.push('Duration not recorded');
          return `<li><div class="hrow"><span class="hstatus">${escapeHtml(label(h.status))}</span><time class="htime" data-ts="${escapeHtml(when || '')}"></time></div><div class="hsub">${escapeHtml(bits.join(' · '))}</div></li>`;
        })
        .join('') +
      `</ul>`
    : `<div class="muted" style="margin-top:16px;font-size:14px">No calls yet.</div>`;

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
  #status { margin-top:12px; font-size:14px; color:#2f7a4f; min-height:20px; }
  .history-title { margin:18px 0 10px; font-size:16px; }
  .history { list-style:none; margin:0; padding:0; display:flex; flex-direction:column; gap:10px; }
  .history li { border:1px solid #eef2f8; border-radius:12px; padding:10px 12px; }
  .hrow { display:flex; align-items:center; justify-content:space-between; gap:10px; font-weight:600; }
  .hstatus { background:#eef4ff; color:#2451a8; padding:2px 8px; border-radius:999px; font-size:13px; }
  .hsub { margin-top:4px; font-size:13px; color:#6b7690; }
</style></head>
<body><div class="wrap"><div class="card">
  <h1>${escapeHtml(c.name)}</h1>
  <div class="muted">${escapeHtml(c.jobTitle || '')}${c.jobTitle && c.email ? ' · ' : ''}${escapeHtml(c.email || '')}</div>
  <div class="count">Called ${count} time${count === 1 ? '' : 's'}</div>
  <div class="phone">${escapeHtml(c.phone)}</div>
  <a class="big call" id="call" href="tel:${tel}">Call now</a>
  <div id="status" role="status"></div>
  ${historyHtml}
</div></div>
<script>
  const token = ${JSON.stringify(c.public_token)};
  const statusEl = document.getElementById('status');
  const callBtn = document.getElementById('call');
  const KEY_T = 'gc_start_' + token;

  function whenText(raw) {
    if (!raw) return '';
    let s = String(raw);
    if (/^\\d{4}-\\d{2}-\\d{2} \\d{2}:\\d{2}:\\d{2}$/.test(s)) s = s.replace(' ', 'T') + 'Z';
    const d = new Date(s);
    return Number.isNaN(d.getTime()) ? String(raw) : d.toLocaleString(undefined, { dateStyle: 'medium', timeStyle: 'short' });
  }
  document.querySelectorAll('time[data-ts]').forEach((el) => { el.textContent = whenText(el.dataset.ts); });

  callBtn.addEventListener('click', () => {
    const start = Date.now();
    try { sessionStorage.setItem(KEY_T, String(start)); } catch (e) {}
    statusEl.style.color = '#2f7a4f';
    statusEl.textContent = 'Starting the call…';
    // keepalive so the attempt is saved even while the dialer opens
    fetch('/api/public/' + token + '/call', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ mode: 'direct' }),
      keepalive: true
    }).catch(() => {});
    // the anchor's tel: href opens the dialer
  });

  let finishing = false;
  async function finishCall() {
    if (finishing) return;
    let start = 0;
    try { start = Number(sessionStorage.getItem(KEY_T) || 0); } catch (e) { start = 0; }
    if (!start) return;
    const secs = Math.round((Date.now() - start) / 1000);
    if (secs < 3) return;
    try { sessionStorage.removeItem(KEY_T); } catch (e) {}
    if (secs > 7200) return;
    finishing = true;
    try {
      const r = await fetch('/api/public/' + token + '/call/finish', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ duration: secs })
      });
      if (r.ok) location.reload();
    } catch (e) {
      finishing = false;
    }
  }
  document.addEventListener('visibilitychange', () => { if (document.visibilityState === 'visible') finishCall(); });
  window.addEventListener('focus', finishCall);
  finishCall();
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
    const rec = recordAttempt(c.id, c.owner_id, result.mock ? 'demo' : 'placed', result.sid);
    return res.json({
      ok: true,
      mock: !!result.mock,
      message: result.message,
      callCount: rec.callCount,
      attemptId: rec.attemptId,
      createdAt: rec.createdAt,
    });
  }

  const rec = recordAttempt(c.id, c.owner_id, 'direct', null);
  res.json({ ok: true, mock: false, callCount: rec.callCount, attemptId: rec.attemptId, createdAt: rec.createdAt });
});

/* The QR page calls this when the phone comes back from the dialer, so the
   measured talk time + hang-up time are stored with the attempt. */
app.post('/api/public/:token/call/:attemptId/finish', (req, res) => {
  const c = contactByToken(req.params.token);
  if (!c) return res.status(404).json({ error: 'Not found.' });

  const attemptId = num(req.params.attemptId);
  const attempt = db
    .prepare('SELECT * FROM call_attempts WHERE id = ? AND contact_id = ?')
    .get(attemptId, c.id);
  if (!attempt) return res.status(404).json({ error: 'Attempt not found.' });

  const duration = Math.max(0, Math.round(Number(req.body?.duration) || 0));
  const endedAt = new Date().toISOString();
  db.prepare('UPDATE call_attempts SET duration = ?, ended_at = ? WHERE id = ?').run(
    duration,
    endedAt,
    attemptId,
  );

  const row = db
    .prepare(
      `SELECT id, status, provider_sid, duration, answered_at, ended_at, created_at
         FROM call_attempts WHERE id = ?`,
    )
    .get(attemptId);
  res.json({ ok: true, attempt: row });
});

/* Same as above, but for the phone page: it may not know the attempt id,
   so this updates the latest direct call that has no duration yet. */
app.post('/api/public/:token/call/finish', (req, res) => {
  const c = contactByToken(req.params.token);
  if (!c) return res.status(404).json({ error: 'Not found.' });

  const duration = Math.max(0, Math.round(Number(req.body?.duration) || 0));
  const attempt = db
    .prepare(
      `SELECT id FROM call_attempts
        WHERE contact_id = ? AND status = 'direct' AND duration IS NULL
        ORDER BY id DESC LIMIT 1`,
    )
    .get(c.id);
  if (!attempt) return res.status(404).json({ error: 'No open call to finish.' });

  db.prepare('UPDATE call_attempts SET duration = ?, ended_at = ? WHERE id = ?').run(
    duration,
    new Date().toISOString(),
    attempt.id,
  );
  res.json({ ok: true, attemptId: num(attempt.id), duration });
});

/* ------------------------------------------------------------------ */
/* Twilio webhook: runs when the HR answers their mobile               */
/* ------------------------------------------------------------------ */

app.all('/api/voice/twiml', (req, res) => {
  // Twilio hits this when the HR answers the mobile and the bridge connects.
  const callSid = String(req.query.CallSid || req.body?.CallSid || req.body?.callSid || '');
  if (callSid) {
    db.prepare("UPDATE call_attempts SET status = 'bridged', answered_at = ? WHERE provider_sid = ?").run(new Date().toISOString(), callSid);
  }
  const to = req.query.to || req.body?.to || req.body?.To;
  res.type('text/xml').send(twimlFor(to));
});

/* Twilio status callback: final status + duration of the bridged call */
app.post('/api/voice/status', (req, res) => {
  const callSid = String(req.query.CallSid || req.body?.CallSid || req.body?.callSid || '');
  const status = String(req.body?.Status || req.body?.status || '');
  const duration = Number(req.body?.Duration ?? req.body?.duration ?? 0);
  if (callSid) {
    if (status === 'answered') {
      db.prepare("UPDATE call_attempts SET status = 'bridged', answered_at = ? WHERE provider_sid = ?").run(new Date().toISOString(), callSid);
    } else if (status) {
      db.prepare('UPDATE call_attempts SET status = ?, duration = ? WHERE provider_sid = ?').run(
        status,
        Number.isFinite(duration) ? duration : null,
        callSid,
      );
    }
  }
  res.status(200).send('ok');
});

/* ------------------------------------------------------------------ */
/* static frontend                                                     */
/* ------------------------------------------------------------------ */

app.use(express.static(path.join(rootDir, 'public')));

app.use((req, res) => res.status(404).json({ error: `Unknown route ${req.method} ${req.path}` }));

const server = app.listen(config.port, () => {
  console.log(`\n  Graph Call is running ->  ${config.publicBaseUrl}`);
  console.log(`  Local address: http://localhost:${config.port}`);
  console.log(`  Address book : ${graphEnabled ? 'Microsoft Graph' : 'DEMO data (set GRAPH_* in .env)'}`);
  console.log(`  Calling      : ${twilioEnabled ? 'Twilio bridge' : 'DEMO mode (set TWILIO_* in .env)'}\n`);
});

server.on('error', (err) => {
  if (err && err.code === 'EADDRINUSE') {
    console.error(
      `\n  Port ${config.port} is already in use.\n` +
        `  The app is probably already running (that is fine — just open http://localhost:${config.port}).\n` +
        `  To start a second copy on another port:  $env:PORT=3002; npm start\n`,
    );
    process.exit(1);
  }
  throw err;
});
