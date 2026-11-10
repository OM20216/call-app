/*
 * Offline smoke test for the Worker.
 *
 * `wrangler dev` needs workerd.exe, which some Windows machines block with
 * an Application Control policy. This harness swaps D1 for node:sqlite and
 * calls the worker's fetch() directly, so every route can be exercised.
 *
 *   node scripts/smoke.mjs
 */
import assert from 'node:assert/strict';
import { DatabaseSync } from 'node:sqlite';

import worker from '../src/index.js';

/* ---------------- D1 shim over node:sqlite ---------------- */

class Stmt {
  constructor(db, sql) {
    this.db = db;
    this.sql = sql;
    this.args = [];
  }
  bind(...args) {
    this.args = args.map((a) => {
      if (a === undefined) return null;
      if (typeof a === 'boolean') return a ? 1 : 0;
      return a;
    });
    return this;
  }
  async first(col) {
    const row = this.db.prepare(this.sql).get(...this.args);
    if (!row) return null;
    return col ? row[col] : { ...row };
  }
  async all() {
    const rows = this.db.prepare(this.sql).all(...this.args);
    return { success: true, results: rows.map((r) => ({ ...r })) };
  }
  async run() {
    const info = this.db.prepare(this.sql).run(...this.args);
    return {
      success: true,
      meta: { last_row_id: Number(info.lastInsertRowid), changes: Number(info.changes) },
    };
  }
}

class D1 {
  constructor(file = ':memory:') {
    this.db = new DatabaseSync(file);
  }
  prepare(sql) {
    return new Stmt(this.db, sql);
  }
  async exec(sql) {
    this.db.exec(sql);
    return { count: 0, duration: 0 };
  }
}

/* ---------------- env + fetch helpers ---------------- */

const origin = 'http://localhost:8787';
const env = {
  DB: new D1(),
  ASSETS: { fetch: async () => new Response('Not found', { status: 404 }) },
  PUBLIC_BASE_URL: origin,
};

let cookie = '';

async function call(path, { method = 'GET', body, headers = {} } = {}) {
  const request = new Request(origin + path, {
    method,
    headers: {
      ...(body !== undefined ? { 'Content-Type': 'application/json' } : {}),
      ...(cookie ? { Cookie: cookie } : {}),
      ...headers,
    },
    body: body !== undefined ? JSON.stringify(body) : undefined,
  });
  const res = await worker.fetch(request, env);
  const setCookie = res.headers.get('Set-Cookie');
  if (setCookie) cookie = setCookie.split(';')[0];
  const ct = res.headers.get('Content-Type') || '';
  const data = ct.includes('application/json') ? await res.clone().json() : await res.clone().text();
  return { status: res.status, data, headers: res.headers, res };
}

const pass = [];
function ok(name, cond, extra = '') {
  assert.ok(cond, `${name} ${extra}`);
  pass.push(name);
}

/* ---------------- the actual run ---------------- */

// 1. health + auth guard
{
  const r = await call('/healthz');
  ok('health', r.status === 200 && r.data.ok);
  const me = await call('/api/me');
  ok('anonymous /api/me', me.status === 200 && me.data.authenticated === false);
  const guarded = await call('/api/contacts');
  ok('contacts require auth', guarded.status === 401);
}

// 2. seeded admin login (boot creates it)
{
  const bad = await call('/api/login', { method: 'POST', body: { email: 'admin@example.com', password: 'nope' } });
  ok('wrong password rejected', bad.status === 401, `got ${bad.status}`);

  const good = await call('/api/login', {
    method: 'POST',
    body: { email: 'admin@example.com', password: 'Admin@1234' },
  });
  ok('seeded admin login', good.status === 200 && good.data.user.role === 'admin', JSON.stringify(good.data));
  ok('session cookie set', cookie.startsWith('sid='));
}

// 3. settings
{
  const r = await call('/api/settings', { method: 'POST', body: { mobile: '+91 90000 11111' } });
  ok('save mobile', r.status === 200 && r.data.user.mobile === '+919000011111', JSON.stringify(r.data));
}

// 4. contacts CRUD
let contactId = 0;
{
  const created = await call('/api/contacts', {
    method: 'POST',
    body: { name: 'Test Candidate', phone: '8154990204', jobTitle: 'Engineer' },
  });
  ok('create contact', created.status === 201 && created.data.id > 0, JSON.stringify(created.data));
  contactId = created.data.id;

  const dupe = await call('/api/contacts', {
    method: 'POST',
    body: { name: 'Same Number', phone: '8154990204' },
  });
  ok('duplicate phone rejected', dupe.status === 409, `got ${dupe.status}`);

  const list = await call('/api/contacts');
  ok('list contacts', list.data.contacts.length === 1 && list.data.contacts[0].callCount === 0);
}

// 5. click-to-call (demo mode)
{
  const r = await call(`/api/contacts/${contactId}/call`, { method: 'POST', body: {} });
  ok('demo bridged call', r.status === 200 && r.data.mock === true && r.data.callCount === 1, JSON.stringify(r.data));

  const detail = await call(`/api/contacts/${contactId}`);
  ok('history has attempt', detail.data.history.length === 1 && detail.data.contact.callCount === 1);

  const st = await call('/api/status');
  ok('status endpoint', st.data.callingMode === 'demo' && st.data.runtime === 'cloudflare-workers');
}

// 6. HRMS sync (create + reuse)
let token = '';
{
  const synced = await call('/api/sync-from-hrms', {
    method: 'POST',
    body: { candidateId: 'CND-TEST-1', candidateName: 'HRMS Candidate', contactNumber: '9998887770' },
  });
  ok('sync creates contact', synced.status === 200 && synced.data.token, JSON.stringify(synced.data));
  ok('sync returns absolute QR url', synced.data.url === `${origin}/c/${synced.data.token}`);
  token = synced.data.token;

  const again = await call('/api/sync-from-hrms', {
    method: 'POST',
    body: { candidateId: 'CND-TEST-1', candidateName: 'HRMS Candidate Renamed', contactNumber: '9998887770' },
  });
  ok('sync reuses by candidateId', again.data.contactId === synced.data.contactId && again.data.token === token);
}

// 7. idempotent log-call: click then duration update = one attempt
{
  const first = await call('/api/log-call', {
    method: 'POST',
    body: { token, clientId: 'call-abc', status: 'direct', timestamp: '2026-01-01T10:00:00.000Z' },
  });
  ok('log-call insert', first.status === 200 && first.data.callCount === 1, JSON.stringify(first.data));

  const second = await call('/api/log-call', {
    method: 'POST',
    body: { token, clientId: 'call-abc', status: 'direct', duration: 42, timestamp: '2026-01-01T10:00:00.000Z' },
  });
  ok('log-call update is idempotent', second.data.callCount === 1 && second.data.totalSeconds === 42, JSON.stringify(second.data));

  const third = await call('/api/log-call', {
    method: 'POST',
    body: { token, clientId: 'call-def', status: 'direct', duration: 8 },
  });
  ok('new clientId adds a call', third.data.callCount === 2 && third.data.totalSeconds === 50, JSON.stringify(third.data));

  const stats = await call(`/api/contact-stats/${token}`);
  ok('shared stats', stats.data.callCount === 2 && stats.data.totalSeconds === 50, JSON.stringify(stats.data));
  ok('shared stats recent list', Array.isArray(stats.data.recent) && stats.data.recent.length === 2);
}

// 8. phone page + QR
{
  const page = await call(`/c/${token}`);
  ok('phone page renders', page.status === 200 && page.data.includes('Call now') && page.data.includes('Called 2 times'));

  const bad = await call('/c/does-not-exist');
  ok('unknown token 404', bad.status === 404);

  const svg = await call(`/qr/${token}.svg`);
  ok('qr svg', svg.status === 200 && String(svg.headers.get('Content-Type')).includes('image/svg+xml'));
  ok('qr svg has path data', svg.data.includes('<path'));

  const png = await call(`/qr/${token}.png`);
  ok('qr png alias still images', png.status === 200);
}

// 9. public call + finish (the QR-page flow)
{
  const placed = await call(`/api/public/${token}/call`, { method: 'POST', body: { mode: 'direct' } });
  ok('public direct call', placed.status === 200 && placed.data.callCount === 3, JSON.stringify(placed.data));

  const finished = await call(`/api/public/${token}/call/${placed.data.attemptId}/finish`, {
    method: 'POST',
    body: { duration: 17 },
  });
  ok('finish by attempt id', finished.data.attempt.duration === 17);

  const placed2 = await call(`/api/public/${token}/call`, { method: 'POST', body: { mode: 'direct' } });
  const finished2 = await call(`/api/public/${token}/call/finish`, { method: 'POST', body: { duration: 5 } });
  ok('finish latest open call', finished2.status === 200 && finished2.data.attemptId === placed2.data.attemptId);
}

// 10. Twilio webhooks
{
  const twiml = await call('/api/voice/twiml?to=%2B15550100');
  ok('twiml xml', twiml.status === 200 && twiml.data.includes('<Dial'));

  const res = await worker.fetch(
    new Request(origin + '/api/voice/status', {
      method: 'POST',
      headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
      body: new URLSearchParams({ CallSid: 'CA-test', CallStatus: 'completed', CallDuration: '31' }),
    }),
    env,
  );
  ok('twilio status webhook', res.status === 200);
}

// 11. delete + logout
{
  const del = await call(`/api/contacts/${contactId}`, { method: 'DELETE' });
  ok('delete contact', del.status === 200 && del.data.ok);

  const del2 = await call(`/api/contacts/${contactId}`, { method: 'DELETE' });
  ok('delete missing 404', del2.status === 404);

  const out = await call('/api/logout', { method: 'POST' });
  ok('logout', out.status === 200);
  const me = await call('/api/me');
  ok('logged out', me.data.authenticated === false);
}

console.log(`\n${pass.length} checks passed`);
for (const name of pass) console.log('  ok  ' + name);
