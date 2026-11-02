import { DatabaseSync } from 'node:sqlite';
import path from 'node:path';
import { rootDir } from './config.js';

// Built-in SQLite (Node 22+). No database server, no native compile step.
const db = new DatabaseSync(path.join(rootDir, 'data.sqlite'));

db.exec('PRAGMA foreign_keys = ON;');

// Add columns to call_attempts if this is an older database
try { db.exec('ALTER TABLE call_attempts ADD COLUMN duration INTEGER'); } catch (e) { /* already exists */ }
try { db.exec('ALTER TABLE call_attempts ADD COLUMN answered_at TEXT'); } catch (e) { /* already exists */ }
try { db.exec('ALTER TABLE call_attempts ADD COLUMN ended_at TEXT'); } catch (e) { /* already exists */ }
try { db.exec('ALTER TABLE contacts ADD COLUMN crm_candidate_id TEXT'); } catch (e) { /* already exists */ }

db.exec(`
CREATE TABLE IF NOT EXISTS hr_users (
  id            INTEGER PRIMARY KEY AUTOINCREMENT,
  email         TEXT NOT NULL UNIQUE,
  password_hash TEXT NOT NULL,
  full_name     TEXT NOT NULL,
  mobile        TEXT NOT NULL DEFAULT '',
  role          TEXT NOT NULL DEFAULT 'recruiter',
  created_at    TEXT NOT NULL DEFAULT (datetime('now'))
);

CREATE TABLE IF NOT EXISTS contacts (
  id           INTEGER PRIMARY KEY AUTOINCREMENT,
  owner_id     INTEGER NOT NULL REFERENCES hr_users(id) ON DELETE CASCADE,
  graph_id     TEXT,
  crm_candidate_id TEXT,
  public_token TEXT NOT NULL UNIQUE,
  name         TEXT NOT NULL,
  phone        TEXT NOT NULL,
  email        TEXT NOT NULL DEFAULT '',
  job_title    TEXT NOT NULL DEFAULT '',
  created_at   TEXT NOT NULL DEFAULT (datetime('now')),
  UNIQUE (owner_id, phone)
);

CREATE TABLE IF NOT EXISTS call_attempts (
  id           INTEGER PRIMARY KEY AUTOINCREMENT,
  contact_id   INTEGER NOT NULL REFERENCES contacts(id) ON DELETE CASCADE,
  hr_id        INTEGER NOT NULL REFERENCES hr_users(id) ON DELETE CASCADE,
  status       TEXT NOT NULL DEFAULT 'placed',
  provider_sid TEXT,
  duration     INTEGER,
  answered_at  TEXT,
  ended_at     TEXT,
  created_at   TEXT NOT NULL DEFAULT (datetime('now'))
);

CREATE TABLE IF NOT EXISTS sessions (
  token      TEXT PRIMARY KEY,
  hr_id      INTEGER NOT NULL REFERENCES hr_users(id) ON DELETE CASCADE,
  created_at TEXT NOT NULL DEFAULT (datetime('now')),
  expires_at TEXT NOT NULL
);

CREATE INDEX IF NOT EXISTS idx_contacts_owner   ON contacts(owner_id);
CREATE INDEX IF NOT EXISTS idx_attempts_contact ON call_attempts(contact_id);
CREATE INDEX IF NOT EXISTS idx_attempts_hr      ON call_attempts(hr_id);
`);

export default db;

export const num = (v) => (typeof v === 'bigint' ? Number(v) : Number(v ?? 0));
