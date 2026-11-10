/*
 * Passwords + sessions for Cloudflare Workers.
 * scrypt is not available in the Workers runtime, so we use PBKDF2-SHA256
 * through WebCrypto. Stored format:  pbkdf2$<iterations>$<saltHex>$<hashHex>
 */

const SESSION_DAYS = 7;
// Workers free plan allows ~10ms CPU per request; 30k PBKDF2 rounds stays
// comfortably inside that while remaining a sane password hash.
const ITERATIONS = 30000;

const enc = new TextEncoder();

function toHex(buf) {
  return Array.from(new Uint8Array(buf))
    .map((b) => b.toString(16).padStart(2, '0'))
    .join('');
}

function fromHex(hex) {
  const clean = String(hex).replace(/[^0-9a-f]/gi, '');
  const out = new Uint8Array(clean.length / 2);
  for (let i = 0; i < out.length; i++) out[i] = parseInt(clean.substr(i * 2, 2), 16);
  return out;
}

function randomHex(bytes) {
  return toHex(crypto.getRandomValues(new Uint8Array(bytes)));
}

async function pbkdf2(password, salt, iterations) {
  const key = await crypto.subtle.importKey(
    'raw',
    enc.encode(String(password)),
    'PBKDF2',
    false,
    ['deriveBits'],
  );
  const bits = await crypto.subtle.deriveBits(
    { name: 'PBKDF2', salt, iterations, hash: 'SHA-256' },
    key,
    256,
  );
  return toHex(bits);
}

export async function hashPassword(password) {
  const saltHex = randomHex(16);
  const hash = await pbkdf2(password, fromHex(saltHex), ITERATIONS);
  return `pbkdf2$${ITERATIONS}$${saltHex}$${hash}`;
}

export async function verifyPassword(password, stored) {
  const parts = String(stored || '').split('$');
  if (parts.length !== 4) return false;
  const [scheme, iter, saltHex, hashHex] = parts;
  if (scheme !== 'pbkdf2' || !iter || !saltHex || !hashHex) return false;
  const rounds = Number(iter);
  if (!Number.isFinite(rounds) || rounds < 1 || rounds > 1000000) return false;
  const actual = await pbkdf2(password, fromHex(saltHex), rounds);
  if (actual.length !== hashHex.length) return false;
  let diff = 0;
  for (let i = 0; i < actual.length; i++) {
    diff |= actual.charCodeAt(i) ^ hashHex.charCodeAt(i);
  }
  return diff === 0;
}

export async function createSession(env, hrId) {
  const token = randomHex(32);
  const expiresAt = new Date(Date.now() + SESSION_DAYS * 24 * 60 * 60 * 1000).toISOString();
  await env.DB.prepare('INSERT INTO sessions (token, hr_id, expires_at) VALUES (?, ?, ?)')
    .bind(token, hrId, expiresAt)
    .run();
  return { token, expiresAt };
}

export async function findSession(env, token) {
  if (!token) return null;
  const row = await env.DB
    .prepare(
      `SELECT u.id, u.email, u.full_name, u.mobile, u.role, s.expires_at
         FROM sessions s JOIN hr_users u ON u.id = s.hr_id
        WHERE s.token = ?`,
    )
    .bind(token)
    .first();
  if (!row) return null;
  if (new Date(row.expires_at).getTime() < Date.now()) {
    await env.DB.prepare('DELETE FROM sessions WHERE token = ?').bind(token).run();
    return null;
  }
  return row;
}

export async function destroySession(env, token) {
  if (token) await env.DB.prepare('DELETE FROM sessions WHERE token = ?').bind(token).run();
}
