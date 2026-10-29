import crypto from 'node:crypto';
import db from './db.js';

const SESSION_DAYS = 7;

// Passwords are hashed with scrypt (built into Node, no native dependency).
export function hashPassword(password) {
  const salt = crypto.randomBytes(16).toString('hex');
  const hash = crypto.scryptSync(String(password), salt, 64).toString('hex');
  return `scrypt$${salt}$${hash}`;
}

export function verifyPassword(password, stored) {
  const [scheme, salt, hash] = String(stored).split('$');
  if (scheme !== 'scrypt' || !salt || !hash) return false;
  const expected = Buffer.from(hash, 'hex');
  const actual = crypto.scryptSync(String(password), salt, 64);
  return actual.length === expected.length && crypto.timingSafeEqual(actual, expected);
}

export function createSession(hrId) {
  const token = crypto.randomBytes(32).toString('hex');
  const expiresAt = new Date(Date.now() + SESSION_DAYS * 24 * 60 * 60 * 1000);
  db.prepare('INSERT INTO sessions (token, hr_id, expires_at) VALUES (?, ?, ?)').run(
    token,
    hrId,
    expiresAt.toISOString(),
  );
  return { token, expiresAt };
}

export function findSession(token) {
  if (!token) return null;
  const row = db
    .prepare(
      `SELECT u.id, u.email, u.full_name, u.mobile, u.role, s.expires_at
         FROM sessions s JOIN hr_users u ON u.id = s.hr_id
        WHERE s.token = ?`,
    )
    .get(token);
  if (!row) return null;
  if (new Date(row.expires_at).getTime() < Date.now()) {
    db.prepare('DELETE FROM sessions WHERE token = ?').run(token);
    return null;
  }
  return row;
}

export function destroySession(token) {
  if (token) db.prepare('DELETE FROM sessions WHERE token = ?').run(token);
}
