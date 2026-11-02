-- ============================================================================
-- Graph Call app — SQLite schema reference
-- File: simple/data.sqlite
-- The app creates these automatically in simple/src/db.js.
-- ============================================================================

PRAGMA foreign_keys = ON;

-- One row per HR / recruiter who signs in.
CREATE TABLE IF NOT EXISTS hr_users (
  id            INTEGER PRIMARY KEY AUTOINCREMENT,
  email         TEXT    NOT NULL UNIQUE,
  password_hash TEXT    NOT NULL,
  full_name     TEXT    NOT NULL,
  mobile        TEXT    NOT NULL DEFAULT '',   -- the phone Twilio rings for the bridge
  role          TEXT    NOT NULL DEFAULT 'recruiter', -- 'admin' | 'recruiter'
  created_at    TEXT    NOT NULL DEFAULT (datetime('now'))
);

-- One row per candidate in one HR's private list.
CREATE TABLE IF NOT EXISTS contacts (
  id               INTEGER PRIMARY KEY AUTOINCREMENT,
  owner_id         INTEGER NOT NULL REFERENCES hr_users(id) ON DELETE CASCADE,
  graph_id         TEXT,                         -- Microsoft 365 / address-book id (optional)
  crm_candidate_id TEXT,                         -- HRMS / SharePoint candidateId (e.g. CND20261093861248)
  public_token     TEXT    NOT NULL UNIQUE,      -- the token used in the QR URL /c/<token>
  name             TEXT    NOT NULL,
  phone            TEXT    NOT NULL,             -- digits, may start with +
  email            TEXT    NOT NULL DEFAULT '',
  job_title        TEXT    NOT NULL DEFAULT '',
  created_at       TEXT    NOT NULL DEFAULT (datetime('now')),
  UNIQUE (owner_id, phone)                       -- no duplicate numbers per HR
);

-- One row per call attempt. Call count = COUNT(*) for a contact.
CREATE TABLE IF NOT EXISTS call_attempts (
  id           INTEGER PRIMARY KEY AUTOINCREMENT,
  contact_id   INTEGER NOT NULL REFERENCES contacts(id) ON DELETE CASCADE,
  hr_id        INTEGER NOT NULL REFERENCES hr_users(id) ON DELETE CASCADE,
  status       TEXT    NOT NULL DEFAULT 'placed',
  -- 'direct'    = tapped Call on the QR page (phone dialled)
  -- 'demo'      = dashboard Call while Twilio is not configured
  -- 'placed'    = Twilio bridge started
  -- 'bridged'   = HR answered, candidate is being connected
  -- 'completed' / 'busy' / 'no-answer' / 'failed' / 'canceled' = final Twilio status
  provider_sid TEXT,                             -- Twilio CallSid (null for direct QR calls)
  duration     INTEGER,                          -- seconds, set by Twilio status callback
  answered_at  TEXT,                             -- ISO timestamp when the call was picked up
  created_at   TEXT    NOT NULL DEFAULT (datetime('now'))
);

-- Login sessions (cookie 'sid').
CREATE TABLE IF NOT EXISTS sessions (
  token      TEXT PRIMARY KEY,
  hr_id      INTEGER NOT NULL REFERENCES hr_users(id) ON DELETE CASCADE,
  created_at TEXT NOT NULL DEFAULT (datetime('now')),
  expires_at TEXT NOT NULL
);

CREATE INDEX IF NOT EXISTS idx_contacts_owner   ON contacts(owner_id);
CREATE INDEX IF NOT EXISTS idx_attempts_contact ON call_attempts(contact_id);
CREATE INDEX IF NOT EXISTS idx_attempts_hr      ON call_attempts(hr_id);

-- ============================================================================
-- QUERIES THE APP USES
-- ============================================================================

-- 1) An HR's contact list with call count + last call + last pickup
SELECT c.*,
       (SELECT COUNT(*)   FROM call_attempts a WHERE a.contact_id = c.id) AS call_count,
       (SELECT MAX(created_at)  FROM call_attempts a WHERE a.contact_id = c.id) AS last_called,
       (SELECT MAX(answered_at) FROM call_attempts a WHERE a.contact_id = c.id AND a.answered_at IS NOT NULL) AS last_answered_at
  FROM contacts c
 WHERE c.owner_id = ?          -- logged-in HR id
 ORDER BY c.name COLLATE NOCASE;

-- 2) Full history for one candidate (newest first)
SELECT a.id, a.contact_id, a.hr_id, a.status, a.provider_sid,
       a.duration, a.answered_at, a.created_at,
       h.full_name AS hr_name
  FROM call_attempts a
  LEFT JOIN hr_users h ON h.id = a.hr_id
 WHERE a.contact_id = ?
 ORDER BY a.id DESC
 LIMIT 20;

-- 3) Record a QR "Call now" tap
INSERT INTO call_attempts (contact_id, hr_id, status, provider_sid)
VALUES (?, ?, 'direct', NULL);

-- 4) Record a Twilio bridge start
INSERT INTO call_attempts (contact_id, hr_id, status, provider_sid)
VALUES (?, ?, 'placed', ?);   -- ? = Twilio CallSid

-- 5) Twilio answer webhook: mark pickup time
UPDATE call_attempts
   SET status = 'bridged', answered_at = datetime('now')
 WHERE provider_sid = ?;

-- 6) Twilio final status callback: hang-up status + talk time
UPDATE call_attempts
   SET status = ?, duration = ?
 WHERE provider_sid = ?;

-- 7) Per-candidate totals for reporting
SELECT c.crm_candidate_id, c.name, c.phone,
       COUNT(a.id)                                   AS total_calls,
       SUM(CASE WHEN a.status = 'bridged' THEN 1 ELSE 0 END) AS answered,
       SUM(CASE WHEN a.status = 'bridged' THEN 0 ELSE 1 END) AS not_answered,
       COALESCE(SUM(a.duration), 0)                  AS total_seconds,
       MAX(a.created_at)                             AS last_call
  FROM contacts c
  LEFT JOIN call_attempts a ON a.contact_id = c.id
 GROUP BY c.id
 ORDER BY total_calls DESC;
