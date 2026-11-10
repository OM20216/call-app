/*
 * Schema for the Cloudflare D1 database.
 * Same tables as the Node/SQLite version so data can be migrated across.
 * Kept as a string so the worker can create the schema on first use.
 */
export const SCHEMA = `
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
  id               INTEGER PRIMARY KEY AUTOINCREMENT,
  owner_id         INTEGER NOT NULL REFERENCES hr_users(id) ON DELETE CASCADE,
  graph_id         TEXT,
  crm_candidate_id TEXT,
  public_token     TEXT NOT NULL UNIQUE,
  name             TEXT NOT NULL,
  phone            TEXT NOT NULL,
  email            TEXT NOT NULL DEFAULT '',
  job_title        TEXT NOT NULL DEFAULT '',
  created_at       TEXT NOT NULL DEFAULT (datetime('now')),
  UNIQUE (owner_id, phone)
);

CREATE TABLE IF NOT EXISTS call_attempts (
  id           INTEGER PRIMARY KEY AUTOINCREMENT,
  contact_id   INTEGER NOT NULL REFERENCES contacts(id) ON DELETE CASCADE,
  hr_id        INTEGER NOT NULL REFERENCES hr_users(id) ON DELETE CASCADE,
  status       TEXT NOT NULL DEFAULT 'placed',
  provider_sid TEXT,
  client_id    TEXT,
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
CREATE UNIQUE INDEX IF NOT EXISTS idx_attempt_client ON call_attempts(contact_id, client_id);
`;

/* Older databases (e.g. imported from the Node version) miss these columns. */
export const MIGRATIONS = [
  'ALTER TABLE call_attempts ADD COLUMN duration INTEGER',
  'ALTER TABLE call_attempts ADD COLUMN answered_at TEXT',
  'ALTER TABLE call_attempts ADD COLUMN ended_at TEXT',
  'ALTER TABLE call_attempts ADD COLUMN client_id TEXT',
  'ALTER TABLE contacts ADD COLUMN crm_candidate_id TEXT',
  'CREATE UNIQUE INDEX IF NOT EXISTS idx_attempt_client ON call_attempts(contact_id, client_id)',
];
