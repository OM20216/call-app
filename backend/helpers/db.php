<?php
declare(strict_types=1);

// ── DB ──────────────────────────────────────────────────────
function getDB(): PDO
{
    static $pdo = null;
    if ($pdo) return $pdo;
    $c   = require __DIR__ . '/../config.php';
    $dsn = "mysql:host={$c['db']['host']};port={$c['db']['port']};dbname={$c['db']['name']};charset={$c['db']['charset']}";
    try {
        $pdo = new PDO($dsn, $c['db']['user'], $c['db']['pass'], [
            PDO::ATTR_ERRMODE            => PDO::ERRMODE_EXCEPTION,
            PDO::ATTR_DEFAULT_FETCH_MODE => PDO::FETCH_ASSOC,
            PDO::ATTR_EMULATE_PREPARES   => false,
        ]);
    } catch (PDOException $e) {
        error_log('DB error: ' . $e->getMessage());
        http_response_code(503);
        echo json_encode(['error' => 'Database unavailable.']);
        exit;
    }
    return $pdo;
}

// ── Config JSON encryption/decryption ────────────────────────
// Stores CRM credentials encrypted with AES-256-CBC so sensitive
// API keys / tokens are never stored as plain text in the DB.

function encryptConfig(array $data): string
{
    $cfg  = require __DIR__ . '/../config.php';
    $key  = hash('sha256', $cfg['app']['encryption_key'], true);
    $iv   = random_bytes(16);
    $enc  = openssl_encrypt(json_encode($data), 'AES-256-CBC', $key, 0, $iv);
    return base64_encode($iv . $enc);
}

function decryptConfig(string $stored): array
{
    $cfg     = require __DIR__ . '/../config.php';
    $key     = hash('sha256', $cfg['app']['encryption_key'], true);
    $decoded = base64_decode($stored);
    $iv      = substr($decoded, 0, 16);
    $enc     = substr($decoded, 16);
    $plain   = openssl_decrypt($enc, 'AES-256-CBC', $key, 0, $iv);
    return json_decode($plain, true) ?: [];
}
