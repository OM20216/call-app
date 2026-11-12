import { SCHEMA_STATEMENTS, MIGRATIONS } from './schema.js';
import { hashPassword, verifyPassword, createSession, findSession, destroySession } from './auth.js';
import { loadPeople, searchPeople } from './graph.js';
import { placeBridgedCall, twimlFor, twilioConfig } from './telephony.js';
import { qrSvg } from './qr.js';
import { phonePage } from './phone.js';

/* ------------------------------------------------------------------ */
/* helpers                                                             */
/* ------------------------------------------------------------------ */

const num = (v) => Number(v ?? 0);
const cleanPhone = (v) => String(v || '').replace(/[^+\d]/g, '');

const escapeHtml = (s) =>
  String(s ?? '').replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' })[c]);

function corsHeaders(request) {
  const h = new Headers();
  h.set('Access-Control-Allow-Origin', request.headers.get('Origin') || '*');
  h.set('Vary', 'Origin');
  h.set('Access-Control-Allow-Methods', 'GET, POST, DELETE, OPTIONS');
  h.set('Access-Control-Allow-Headers', 'Content-Type, X-API-Key');
  h.set('Access-Control-Max-Age', '86400');
  return h;
}

function json(request, data, status = 200, extra = {}) {
  const headers = corsHeaders(request);
  headers.set('Content-Type', 'application/json; charset=utf-8');
  for (const [k, v] of Object.entries(extra)) headers.set(k, v);
  return new Response(JSON.stringify(data), { status, headers });
}

function html(request, body, status = 200) {
  const headers = corsHeaders(request);
  headers.set('Content-Type', 'text/html; charset=utf-8');
  headers.set('Cache-Control', 'no-store');
  return new Response(body, { status, headers });
}

function parseCookies(request) {
  const out = {};
  for (const part of String(request.headers.get('Cookie') || '').split(';')) {
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

async function readBody(request) {
  const ct = request.headers.get('Content-Type') || '';
  if (ct.includes('application/json')) return (await request.json().catch(() => ({}))) || {};
  if (ct.includes('application/x-www-form-urlencoded') || ct.includes('multipart/form-data')) {
    const text = await request.text();
    return Object.fromEntries(new URLSearchParams(text));
  }
  return {};
}

/* ------------------------------------------------------------------ */
/* database bootstrap (schema + first admin)                           */
/* ------------------------------------------------------------------ */

let bootPromise = null;

async function boot(env) {
  if (bootPromise) return bootPromise;
  bootPromise = (async () => {
    // Fresh database? Create everything. Otherwise it is a migrated/older
    // database and only the ALTERs are worth attempting.
    const existing = await env.DB
      .prepare("SELECT name FROM sqlite_master WHERE type = 'table' AND name = 'hr_users'")
      .first();

    if (!existing) {
      for (const stmt of SCHEMA_STATEMENTS) {
        await env.DB.prepare(stmt).run();
      }
    } else {
      for (const stmt of MIGRATIONS) {
        try {
          await env.DB.prepare(stmt).run();
        } catch (e) {
          /* column/index already exists */
        }
      }
    }

    const row = await env.DB.prepare('SELECT COUNT(*) AS n FROM hr_users').first();
    if (!row || num(row.n) === 0) {
      await env.DB.prepare(
        'INSERT INTO hr_users (email, password_hash, full_name, role, mobile) VALUES (?, ?, ?, ?, ?)',
      )
        .bind('admin@example.com', await hashPassword('Admin@1234'), 'App Administrator', 'admin', '')
        .run();
    }
  })().catch((err) => {
    bootPromise = null;
    throw err;
  });
  return bootPromise;
}

/* ------------------------------------------------------------------ */
/* query helpers                                                       */
/* ------------------------------------------------------------------ */

const first = (env, sql, ...args) => env.DB.prepare(sql).bind(...args).first();
const all = async (env, sql, ...args) => (await env.DB.prepare(sql).bind(...args).all()).results || [];
const run = (env, sql, ...args) => env.DB.prepare(sql).bind(...args).run();

async function contactByToken(env, token) {
  return first(
    env,
    `SELECT c.*,
            (SELECT COUNT(*) FROM call_attempts a WHERE a.contact_id = c.id) AS call_count
       FROM contacts c WHERE c.public_token = ?`,
    token,
  );
}

async function recordAttempt(env, contactId, hrId, status, sid, clientId = null) {
  const info = await run(
    env,
    'INSERT INTO call_attempts (contact_id, hr_id, status, provider_sid, client_id) VALUES (?, ?, ?, ?, ?)',
    contactId,
    hrId,
    status,
    sid || null,
    clientId,
  );
  const attemptId = num(info.meta.last_row_id);
  const attempt = await first(env, 'SELECT created_at FROM call_attempts WHERE id = ?', attemptId);
  const count = await first(env, 'SELECT COUNT(*) AS n FROM call_attempts WHERE contact_id = ?', contactId);
  return { callCount: num(count.n), attemptId, createdAt: attempt ? attempt.created_at : null };
}

async function statsFor(env, contactId) {
  const stats = await first(
    env,
    `SELECT COUNT(*) AS n,
            MAX(created_at) AS last_call,
            MAX(answered_at) AS last_answered,
            COALESCE(SUM(duration), 0) AS total_seconds
       FROM call_attempts WHERE contact_id = ?`,
    contactId,
  );
  const lastTimed = await first(
    env,
    `SELECT duration, created_at, ended_at
       FROM call_attempts
      WHERE contact_id = ? AND duration IS NOT NULL
      ORDER BY id DESC LIMIT 1`,
    contactId,
  );
  return { stats, lastTimed };
}

async function ownerForHrms(env, hrEmail) {
  const match = String(hrEmail || '').match(/[A-Z0-9._%+-]+@[A-Z0-9.-]+\.[A-Z]{2,}/i);
  if (match) {
    const user = await first(env, 'SELECT * FROM hr_users WHERE lower(email) = lower(?)', match[0]);
    if (user) return user;
  }
  return first(env, 'SELECT * FROM hr_users ORDER BY id ASC LIMIT 1');
}

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

const CONTACT_SELECT = `SELECT c.*,
        (SELECT COUNT(*) FROM call_attempts a WHERE a.contact_id = c.id) AS call_count,
        (SELECT MAX(created_at) FROM call_attempts a WHERE a.contact_id = c.id) AS last_called,
        (SELECT MAX(answered_at) FROM call_attempts a WHERE a.contact_id = c.id AND a.answered_at IS NOT NULL) AS last_answered_at
   FROM contacts c`;

/* ------------------------------------------------------------------ */
/* worker entry                                                        */
/* ------------------------------------------------------------------ */

export default {
  async fetch(request, env) {
    const url = new URL(request.url);
    const path = url.pathname;
    const method = request.method.toUpperCase();

    if (method === 'OPTIONS') {
      return new Response(null, { status: 204, headers: corsHeaders(request) });
    }

    try {
      await boot(env);

      const base = (env.PUBLIC_BASE_URL || url.origin).replace(/\/+$/, '');

      /* ---------------- health ---------------- */
      if (path === '/healthz') {
        return json(request, { ok: true, service: 'graph-call-d1', runtime: 'cloudflare-workers' });
      }

      /* ---------------- auth ---------------- */
      if (path === '/api/login' && method === 'POST') {
        const b = await readBody(request);
        const email = String(b.email || '').trim().toLowerCase();
        const password = String(b.password || '');
        const user = await first(env, 'SELECT * FROM hr_users WHERE email = ?', email);
        if (!user || !(await verifyPassword(password, user.password_hash))) {
          return json(request, { error: 'Wrong email or password.' }, 401);
        }
        const { token, expiresAt } = await createSession(env, user.id);
        return json(request, { user: publicUser(user) }, 200, {
          'Set-Cookie': `sid=${token}; HttpOnly; Path=/; SameSite=Lax; Expires=${new Date(expiresAt).toUTCString()}`,
        });
      }

      if (path === '/api/logout' && method === 'POST') {
        await destroySession(env, parseCookies(request).sid);
        return json(request, { ok: true }, 200, { 'Set-Cookie': 'sid=; HttpOnly; Path=/; Max-Age=0' });
      }

      const user = await findSession(env, parseCookies(request).sid);

      if (path === '/api/me') {
        if (!user) return json(request, { authenticated: false });
        return json(request, { authenticated: true, user: publicUser(user) });
      }

      if (path === '/api/status') {
        if (!user) return json(request, { error: 'Not signed in.' }, 401);
        const callingMode = twilioConfig(env).enabled ? 'twilio' : 'direct';
        return json(request, {
          graphMode: env.GRAPH_CLIENT_ID && env.GRAPH_CLIENT_SECRET ? 'microsoft-graph' : 'demo',
          callingMode,
          directDial: callingMode === 'direct',
          publicBaseUrl: base,
          runtime: 'cloudflare-workers',
        });
      }

      if (path === '/api/settings' && method === 'POST') {
        if (!user) return json(request, { error: 'Not signed in.' }, 401);
        const b = await readBody(request);
        const mobile = cleanPhone(b.mobile);
        await run(env, 'UPDATE hr_users SET mobile = ? WHERE id = ?', mobile, user.id);
        return json(request, { ok: true, user: { ...publicUser(user), mobile } });
      }

      /* ---------------- address book ---------------- */
      if (path === '/api/address-book' && method === 'GET') {
        if (!user) return json(request, { error: 'Not signed in.' }, 401);
        try {
          const people = await loadPeople(env);
          const matches = searchPeople(people, url.searchParams.get('q')).slice(0, 50);
          const mineRows = await all(
            env,
            'SELECT graph_id FROM contacts WHERE owner_id = ? AND graph_id IS NOT NULL',
            user.id,
          );
          const mine = new Set(mineRows.map((r) => r.graph_id));
          return json(request, {
            source: env.GRAPH_CLIENT_ID && env.GRAPH_CLIENT_SECRET ? 'microsoft-graph' : 'demo',
            people: matches.map((p) => ({ ...p, added: mine.has(p.graphId) })),
          });
        } catch (e) {
          return json(request, { error: e.message }, 502);
        }
      }

      /* ---------------- my contacts ---------------- */
      if (path === '/api/contacts' && method === 'GET') {
        if (!user) return json(request, { error: 'Not signed in.' }, 401);
        const rows = await all(
          env,
          `${CONTACT_SELECT} WHERE c.owner_id = ? ORDER BY c.name COLLATE NOCASE`,
          user.id,
        );
        return json(request, { contacts: rows.map(contactJson) });
      }

      if (path === '/api/contacts' && method === 'POST') {
        if (!user) return json(request, { error: 'Not signed in.' }, 401);
        const b = await readBody(request);
        const name = String(b.name || '').trim();
        const phone = cleanPhone(b.phone);
        if (!name || !phone) return json(request, { error: 'Name and phone are required.' }, 400);
        try {
          const info = await run(
            env,
            `INSERT INTO contacts (owner_id, graph_id, public_token, name, phone, email, job_title)
             VALUES (?, ?, ?, ?, ?, ?, ?)`,
            user.id,
            b.graphId || null,
            crypto.randomUUID().replace(/-/g, ''),
            name,
            phone,
            String(b.email || '').trim(),
            String(b.jobTitle || '').trim(),
          );
          return json(request, { id: num(info.meta.last_row_id) }, 201);
        } catch (e) {
          if (String(e.message).includes('UNIQUE')) {
            return json(request, { error: 'That number is already in your list.' }, 409);
          }
          return json(request, { error: e.message }, 500);
        }
      }

      let m = path.match(/^\/api\/contacts\/(\d+)$/);
      if (m && method === 'GET') {
        if (!user) return json(request, { error: 'Not signed in.' }, 401);
        const row = await first(env, `${CONTACT_SELECT} WHERE c.id = ? AND c.owner_id = ?`, num(m[1]), user.id);
        if (!row) return json(request, { error: 'Not found.' }, 404);
        const history = await all(
          env,
          `SELECT id, contact_id, hr_id, status, provider_sid, duration, answered_at, ended_at, created_at
             FROM call_attempts
            WHERE contact_id = ?
            ORDER BY id DESC
            LIMIT 20`,
          row.id,
        );
        return json(request, { contact: contactJson(row), history });
      }

      if (m && method === 'DELETE') {
        if (!user) return json(request, { error: 'Not signed in.' }, 401);
        const info = await run(env, 'DELETE FROM contacts WHERE id = ? AND owner_id = ?', num(m[1]), user.id);
        if (!info.meta || !info.meta.changes) return json(request, { error: 'Not found.' }, 404);
        return json(request, { ok: true });
      }

      m = path.match(/^\/api\/contacts\/(\d+)\/call$/);
      if (m && method === 'POST') {
        if (!user) return json(request, { error: 'Not signed in.' }, 401);
        const contact = await first(env, 'SELECT * FROM contacts WHERE id = ? AND owner_id = ?', num(m[1]), user.id);
        if (!contact) return json(request, { error: 'Not found.' }, 404);

        const b = await readBody(request);

        // No telephony provider configured: the call is placed from the HR's
        // own phone (QR page -> tel: link), so just record the direct attempt.
        if (!twilioConfig(env).enabled) {
          const rec = await recordAttempt(env, contact.id, user.id, 'direct', null);
          return json(request, {
            ok: true,
            mode: 'direct',
            mock: false,
            callCount: rec.callCount,
            attemptId: rec.attemptId,
            createdAt: rec.createdAt,
            url: `${base}/c/${contact.public_token}`,
          });
        }

        const mobile = cleanPhone(b.mobile || user.mobile);
        if (!mobile) return json(request, { error: 'Add your mobile number in Settings first.' }, 400);

        const result = await placeBridgedCall(env, base, { hrMobile: mobile, contactPhone: contact.phone });
        if (!result.ok) return json(request, { error: result.error }, 502);

        const rec = await recordAttempt(env, contact.id, user.id, 'placed', result.sid);
        return json(request, {
          ok: true,
          mode: 'twilio',
          mock: false,
          message: result.message,
          callCount: rec.callCount,
          attemptId: rec.attemptId,
          createdAt: rec.createdAt,
        });
      }

      /* ---------------- HRMS sync ---------------- */
      if (path === '/api/sync-from-hrms' && method === 'GET') {
        return json(request, {
          ok: true,
          service: 'graph-call-d1',
          hint: 'POST candidateId, candidateName, contactNumber to create/reuse a contact and get a call QR.',
        });
      }

      if (path === '/api/sync-from-hrms' && method === 'POST') {
        const b = await readBody(request);
        const candidateId = String(b.candidateId || '').trim();
        const name = String(b.candidateName || b.fullName || '').trim();
        const phone = cleanPhone(b.contactNumber || b.mobileNumber || b.phone);
        const email = String(b.emailId || b.email || '').trim();
        const jobTitle = String(b.positionApplied || b.jobRole || b.position || '').trim();

        if (!name || !phone) {
          return json(request, { error: 'candidateName and contactNumber are required.' }, 400);
        }

        const owner = await ownerForHrms(env, b.assignedTo || b.hrEmail || b.ownerEmail);
        if (!owner) {
          return json(request, { error: 'No HR user found. Open the call app once to create the admin account.' }, 500);
        }

        let contact = candidateId
          ? await first(
              env,
              'SELECT * FROM contacts WHERE owner_id = ? AND crm_candidate_id = ?',
              owner.id,
              candidateId,
            )
          : null;
        if (!contact) {
          contact = await first(
            env,
            'SELECT * FROM contacts WHERE owner_id = ? AND phone = ?',
            owner.id,
            phone,
          );
        }

        if (contact) {
          await run(
            env,
            `UPDATE contacts
                SET name = ?, phone = ?, email = ?, job_title = ?,
                    crm_candidate_id = COALESCE(?, crm_candidate_id)
              WHERE id = ?`,
            name,
            phone,
            email,
            jobTitle,
            candidateId || null,
            contact.id,
          );
          contact = await first(env, 'SELECT * FROM contacts WHERE id = ?', contact.id);
        } else {
          const info = await run(
            env,
            `INSERT INTO contacts (owner_id, name, phone, email, job_title, public_token, crm_candidate_id)
             VALUES (?, ?, ?, ?, ?, ?, ?)`,
            owner.id,
            name,
            phone,
            email,
            jobTitle,
            crypto.randomUUID().replace(/-/g, ''),
            candidateId || null,
          );
          contact = await first(env, 'SELECT * FROM contacts WHERE id = ?', num(info.meta.last_row_id));
        }

        const { stats, lastTimed } = await statsFor(env, contact.id);
        return json(request, {
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
          url: `${base}/c/${contact.public_token}`,
          qrSvg: `${base}/qr/${contact.public_token}.svg`,
          qrPng: `${base}/qr/${contact.public_token}.png`,
        });
      }

      /* ---------------- shared stats for Pages ---------------- */
      m = path.match(/^\/api\/contact-stats\/([A-Za-z0-9_-]+)$/);
      if (m && method === 'GET') {
        const c = await contactByToken(env, m[1]);
        if (!c) return json(request, { error: 'Not found.' }, 404);
        const { stats, lastTimed } = await statsFor(env, c.id);
        const recent = await all(
          env,
          `SELECT id, status, duration, answered_at, created_at
             FROM call_attempts WHERE contact_id = ?
            ORDER BY id DESC LIMIT 5`,
          c.id,
        );
        return json(request, {
          ok: true,
          token: c.public_token,
          callCount: num(stats.n),
          lastCallAt: stats.last_call || null,
          lastAnsweredAt: stats.last_answered || null,
          lastDuration: lastTimed ? num(lastTimed.duration) : null,
          totalSeconds: num(stats.total_seconds),
          recent: recent.map((r) => ({
            id: num(r.id),
            status: r.status,
            duration: r.duration != null ? num(r.duration) : null,
            answeredAt: r.answered_at || null,
            createdAt: r.created_at,
          })),
        });
      }

      /* ---------------- phone-measured call log (idempotent) ---------------- */
      if (path === '/api/log-call' && method === 'POST') {
        const b = await readBody(request);
        const token = String(b.token || '').trim();
        if (!token) return json(request, { error: 'token is required.' }, 400);
        const c = await contactByToken(env, token);
        if (!c) return json(request, { error: 'Not found.' }, 404);

        const duration =
          b.duration != null ? Math.max(0, Math.min(7200, Math.round(Number(b.duration) || 0))) : null;
        const ts = b.timestamp ? new Date(b.timestamp) : new Date();
        const createdIso = Number.isNaN(ts.getTime()) ? new Date().toISOString() : ts.toISOString();
        const answeredIso =
          duration != null && String(b.answeredAt || '').trim() ? new Date(b.answeredAt).toISOString() : null;
        const endedIso = duration != null ? new Date().toISOString() : null;
        const status = String(b.status || 'direct');
        const clientId = String(b.clientId || b.client_id || '').trim() || null;

        let attemptId = null;

        if (clientId) {
          const existing = await first(
            env,
            'SELECT id FROM call_attempts WHERE contact_id = ? AND client_id = ?',
            c.id,
            clientId,
          );
          if (existing) {
            attemptId = num(existing.id);
            await run(
              env,
              `UPDATE call_attempts
                  SET duration = COALESCE(?, duration),
                      answered_at = COALESCE(?, answered_at),
                      ended_at = COALESCE(?, ended_at),
                      status = COALESCE(?, status)
                WHERE id = ?`,
              duration,
              answeredIso,
              endedIso,
              status,
              attemptId,
            );
          }
        }

        if (!attemptId) {
          try {
            const info = await run(
              env,
              `INSERT INTO call_attempts (contact_id, hr_id, status, provider_sid, client_id, duration, answered_at, ended_at, created_at)
               VALUES (?, ?, ?, ?, ?, ?, ?, ?, datetime(?))`,
              c.id,
              c.owner_id,
              status,
              b.providerSid || null,
              clientId,
              duration,
              answeredIso,
              endedIso,
              createdIso.replace('T', ' ').replace('Z', ''),
            );
            attemptId = num(info.meta.last_row_id);
          } catch (e) {
            // Client retried at the same moment the first insert landed.
            if (!String(e.message).includes('UNIQUE') || !clientId) throw e;
            const existing = await first(
              env,
              'SELECT id FROM call_attempts WHERE contact_id = ? AND client_id = ?',
              c.id,
              clientId,
            );
            attemptId = existing ? num(existing.id) : null;
          }
        }

        const { stats } = await statsFor(env, c.id);
        return json(request, {
          ok: true,
          id: attemptId,
          callCount: num(stats.n),
          lastCallAt: stats.last_call || null,
          totalSeconds: num(stats.total_seconds),
        });
      }

      /* ---------------- public QR endpoints ---------------- */
      m = path.match(/^\/api\/public\/([A-Za-z0-9_-]+)\/call$/);
      if (m && method === 'POST') {
        const c = await contactByToken(env, m[1]);
        if (!c) return json(request, { error: 'Not found.' }, 404);

        const b = await readBody(request);
        const mode = b.mode === 'bridge' ? 'bridge' : 'direct';
        const owner = await first(env, 'SELECT * FROM hr_users WHERE id = ?', c.owner_id);

        // A bridge needs a provider. Without one we fall back to direct dial:
        // the phone page's tel: link already placed the call on the SIM.
        if (mode === 'bridge' && twilioConfig(env).enabled) {
          const mobile = cleanPhone(owner && owner.mobile);
          if (!mobile) {
            return json(
              request,
              { error: 'The HR has not set their mobile number yet (Settings tab).' },
              400,
            );
          }
          const result = await placeBridgedCall(env, base, { hrMobile: mobile, contactPhone: c.phone });
          if (!result.ok) return json(request, { error: result.error }, 502);
          const rec = await recordAttempt(env, c.id, c.owner_id, 'placed', result.sid);
          return json(request, {
            ok: true,
            mode: 'twilio',
            mock: false,
            message: result.message,
            callCount: rec.callCount,
            attemptId: rec.attemptId,
            createdAt: rec.createdAt,
          });
        }

        const rec = await recordAttempt(env, c.id, c.owner_id, 'direct', null);
        return json(request, {
          ok: true,
          mode: 'direct',
          mock: false,
          callCount: rec.callCount,
          attemptId: rec.attemptId,
          createdAt: rec.createdAt,
        });
      }

      m = path.match(/^\/api\/public\/([A-Za-z0-9_-]+)\/call\/(\d+)\/finish$/);
      if (m && method === 'POST') {
        const c = await contactByToken(env, m[1]);
        if (!c) return json(request, { error: 'Not found.' }, 404);

        const attemptId = num(m[2]);
        const attempt = await first(
          env,
          'SELECT * FROM call_attempts WHERE id = ? AND contact_id = ?',
          attemptId,
          c.id,
        );
        if (!attempt) return json(request, { error: 'Attempt not found.' }, 404);

        const b = await readBody(request);
        const duration = Math.max(0, Math.round(Number(b.duration) || 0));
        const status = String(b.status || '').trim() || null;
        // Direct-dial has no provider telling us when the candidate answered.
        // We know the talk time, so derive pickup time as (now - duration).
        const answeredIso =
          duration > 0 && status !== 'no-answer'
            ? new Date(Date.now() - duration * 1000).toISOString()
            : null;
        await run(
          env,
          `UPDATE call_attempts
              SET duration = ?, ended_at = ?, status = COALESCE(?, status),
                  answered_at = COALESCE(?, answered_at)
            WHERE id = ?`,
          duration,
          new Date().toISOString(),
          status,
          answeredIso,
          attemptId,
        );
        const row = await first(
          env,
          `SELECT id, status, provider_sid, duration, answered_at, ended_at, created_at
             FROM call_attempts WHERE id = ?`,
          attemptId,
        );
        return json(request, { ok: true, attempt: row });
      }

      m = path.match(/^\/api\/public\/([A-Za-z0-9_-]+)\/call\/finish$/);
      if (m && method === 'POST') {
        const c = await contactByToken(env, m[1]);
        if (!c) return json(request, { error: 'Not found.' }, 404);

        const b = await readBody(request);
        const duration = Math.max(0, Math.round(Number(b.duration) || 0));
        const status = String(b.status || '').trim() || null;
        const attempt = await first(
          env,
          `SELECT id FROM call_attempts
            WHERE contact_id = ? AND status = 'direct' AND duration IS NULL
            ORDER BY id DESC LIMIT 1`,
          c.id,
        );
        if (!attempt) return json(request, { error: 'No open call to finish.' }, 404);

        // Same derivation as the per-attempt route: pickup time is unknown
        // for direct dial, so estimate it from the measured talk time.
        const answeredIso =
          duration > 0 && status !== 'no-answer'
            ? new Date(Date.now() - duration * 1000).toISOString()
            : null;
        await run(
          env,
          `UPDATE call_attempts
              SET duration = ?, ended_at = ?, status = COALESCE(?, status),
                  answered_at = COALESCE(?, answered_at)
            WHERE id = ?`,
          duration,
          new Date().toISOString(),
          status,
          answeredIso,
          attempt.id,
        );
        return json(request, {
          ok: true,
          attemptId: num(attempt.id),
          duration,
          status: status || 'direct',
          answeredAt: answeredIso,
        });
      }

      /* ---------------- QR image ---------------- */
      m = path.match(/^\/qr\/([A-Za-z0-9_-]+)\.(svg|png)$/);
      if (m && method === 'GET') {
        const c = await contactByToken(env, m[1]);
        if (!c) return new Response('Not found', { status: 404 });
        const target = `${base}/c/${c.public_token}`;
        const svg = qrSvg(target, 360);
        return new Response(svg, {
          headers: {
            'Content-Type': 'image/svg+xml; charset=utf-8',
            'Cache-Control': 'no-store',
            'Content-Disposition': `inline; filename="call-${c.public_token}.svg"`,
          },
        });
      }

      /* ---------------- phone page ---------------- */
      m = path.match(/^\/c\/([A-Za-z0-9_-]+)\/?$/);
      if (m && method === 'GET') {
        const c = await contactByToken(env, m[1]);
        if (!c) return html(request, '<h1>Contact not found</h1>', 404);
        const history = await all(
          env,
          `SELECT id, status, provider_sid, duration, answered_at, ended_at, created_at
             FROM call_attempts WHERE contact_id = ?
            ORDER BY id DESC LIMIT 10`,
          c.id,
        );
        return html(request, phonePage({ contact: c, history, callCount: c.call_count }));
      }

      /* ---------------- Twilio webhooks ---------------- */
      if (path === '/api/voice/twiml') {
        const b = await readBody(request);
        const callSid = String(url.searchParams.get('CallSid') || b.CallSid || b.callSid || '');
        if (callSid) {
          await run(
            env,
            "UPDATE call_attempts SET status = 'bridged', answered_at = ? WHERE provider_sid = ?",
            new Date().toISOString(),
            callSid,
          );
        }
        const to = url.searchParams.get('to') || b.to || b.To;
        return new Response(twimlFor(env, to), {
          headers: { 'Content-Type': 'text/xml; charset=utf-8' },
        });
      }

      if (path === '/api/voice/status') {
        const b = await readBody(request);
        const callSid = String(url.searchParams.get('CallSid') || b.CallSid || b.callSid || '');
        const status = String(b.CallStatus || b.Status || b.status || '');
        const durationRaw = b.CallDuration ?? b.Duration ?? b.duration;
        const duration = durationRaw != null ? Number(durationRaw) : null;
        if (callSid) {
          if (status === 'answered' || status === 'in-progress') {
            await run(
              env,
              "UPDATE call_attempts SET status = 'bridged', answered_at = ? WHERE provider_sid = ?",
              new Date().toISOString(),
              callSid,
            );
          } else if (status) {
            await run(
              env,
              'UPDATE call_attempts SET status = ?, duration = ? WHERE provider_sid = ?',
              status,
              Number.isFinite(duration) ? duration : null,
              callSid,
            );
          }
        }
        return new Response('ok', { status: 200 });
      }

      /* ---------------- static UI ---------------- */
      if (env.ASSETS && (method === 'GET' || method === 'HEAD')) {
        const asset = await env.ASSETS.fetch(request);
        if (asset.status !== 404) return asset;
      }

      return json(request, { error: `Unknown route ${method} ${path}` }, 404);
    } catch (err) {
      return json(request, { error: err && err.message ? err.message : 'Server error' }, 500);
    }
  },
};
