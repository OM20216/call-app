-- ============================================================
-- HR Calling App — Database Schema v3
-- Universal CRM Connector (any CRM, any API)
-- ============================================================

SET FOREIGN_KEY_CHECKS = 0;

-- ------------------------------------------------------------
-- 1. App Users (local recruiter accounts)
-- ------------------------------------------------------------
CREATE TABLE IF NOT EXISTS hr_users (
    id            BIGINT UNSIGNED AUTO_INCREMENT PRIMARY KEY,
    email         VARCHAR(255) NOT NULL UNIQUE,
    password_hash VARCHAR(255) NOT NULL,
    full_name     VARCHAR(255) NOT NULL,
    role          ENUM('recruiter','admin') NOT NULL DEFAULT 'recruiter',
    is_active     TINYINT(1) NOT NULL DEFAULT 1,
    created_at    TIMESTAMP NOT NULL DEFAULT CURRENT_TIMESTAMP,
    updated_at    TIMESTAMP NOT NULL DEFAULT CURRENT_TIMESTAMP ON UPDATE CURRENT_TIMESTAMP,
    INDEX idx_email (email)
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci;

-- ------------------------------------------------------------
-- 2. CRM Connections
--    Each row = one configured CRM. Works with ANY system.
--
--    config_json stores the full connection blueprint:
--    {
--      "auth": {
--        "type": "bearer" | "api_key" | "basic" | "custom_header",
--        "token": "...",           -- for bearer / api_key
--        "username": "...",        -- for basic
--        "password": "...",        -- for basic
--        "header_name": "...",     -- for custom_header
--        "header_value": "..."     -- for custom_header
--      },
--      "endpoints": {
--        "get_candidate": "/candidates/{id}",
--        "search":        "/candidates/search?q={query}",
--        "base_url":      "https://yourcrm.example.com/api"
--      },
--      "field_map": {
--        "id":       "candidate_id",   -- CRM field that holds the ID
--        "name":     "full_name",      -- CRM field that holds name
--        "phone":    "mobile",         -- CRM field that holds phone
--        "email":    "email_address",  -- optional
--        "position": "job_title"       -- optional
--      }
--    }
-- ------------------------------------------------------------
CREATE TABLE IF NOT EXISTS crm_connections (
    id           BIGINT UNSIGNED AUTO_INCREMENT PRIMARY KEY,
    label        VARCHAR(255) NOT NULL          COMMENT 'User-chosen name, e.g. "Our Company CRM"',
    base_url     VARCHAR(512) NOT NULL          COMMENT 'API base URL, e.g. https://crm.example.com/api',
    config_json  TEXT         NOT NULL          COMMENT 'Full JSON config: auth, endpoints, field_map',
    is_active    TINYINT(1)   NOT NULL DEFAULT 0 COMMENT 'Only ONE can be 1 at a time',
    status       ENUM('connected','disconnected','error') NOT NULL DEFAULT 'disconnected',
    last_error   TEXT                           COMMENT 'Last test error message',
    last_tested  TIMESTAMP    NULL,
    created_by   BIGINT UNSIGNED NOT NULL,
    created_at   TIMESTAMP NOT NULL DEFAULT CURRENT_TIMESTAMP,
    updated_at   TIMESTAMP NOT NULL DEFAULT CURRENT_TIMESTAMP ON UPDATE CURRENT_TIMESTAMP,
    FOREIGN KEY (created_by) REFERENCES hr_users(id) ON DELETE CASCADE,
    INDEX idx_active (is_active)
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci;

-- ------------------------------------------------------------
-- 3. Call Attempts
--    Stored in this app's own DB — source of truth for counts.
--    crm_candidate_id = the ID as it exists in the external CRM.
-- ------------------------------------------------------------
CREATE TABLE IF NOT EXISTS call_attempts (
    id                BIGINT UNSIGNED AUTO_INCREMENT PRIMARY KEY,
    crm_connection_id BIGINT UNSIGNED NOT NULL,
    crm_candidate_id  VARCHAR(255)    NOT NULL,
    candidate_name    VARCHAR(255)    NULL       COMMENT 'Snapshot for display only',
    recruiter_id      BIGINT UNSIGNED NOT NULL,
    idempotency_key   VARCHAR(128)    NULL,
    created_at        TIMESTAMP NOT NULL DEFAULT CURRENT_TIMESTAMP,
    UNIQUE KEY uq_idempotency (idempotency_key),
    FOREIGN KEY (crm_connection_id) REFERENCES crm_connections(id) ON DELETE CASCADE,
    FOREIGN KEY (recruiter_id)      REFERENCES hr_users(id)        ON DELETE CASCADE,
    INDEX idx_candidate (crm_connection_id, crm_candidate_id, created_at),
    INDEX idx_recruiter (recruiter_id, created_at)
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci;

SET FOREIGN_KEY_CHECKS = 1;

-- ============================================================
-- Seed: one admin user  (password: Admin@1234)
-- Run this ONLY for initial setup; remove before production.
-- ============================================================
INSERT IGNORE INTO hr_users (email, password_hash, full_name, role)
VALUES (
    'admin@example.com',
    '$2y$12$92IXUNpkjO0rOQ5byMi.Ye4oKoEa3Ro9llC/.og/at2.uheWG/igi',
    'App Administrator',
    'admin'
);
