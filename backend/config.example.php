<?php
/**
 * App Configuration
 * Copy to config.php and fill in real values. Never commit config.php.
 */
return [
    'db' => [
        'host'    => getenv('DB_HOST') ?: 'localhost',
        'port'    => getenv('DB_PORT') ?: '3306',
        'name'    => getenv('DB_NAME') ?: 'hr_calling_app',
        'user'    => getenv('DB_USER') ?: 'root',
        'pass'    => getenv('DB_PASS') ?: '',
        'charset' => 'utf8mb4',
    ],
    'session' => [
        'name'            => 'HR_SESSION',
        'lifetime'        => 7200,
        'cookie_secure'   => false,   // true on HTTPS
        'cookie_httponly' => true,
        'cookie_samesite' => 'Strict',
    ],
    'app' => [
        // Encryption key for storing CRM credentials in DB (32 bytes)
        'encryption_key'   => getenv('ENCRYPTION_KEY') ?: 'CHANGE_THIS_32_BYTE_SECRET_KEY!!',
        'allowed_origins'  => getenv('ALLOWED_ORIGINS') ?: 'http://localhost:5173',
        'rate_limit_calls' => 10,   // max call POSTs per recruiter per minute
        'environment'      => getenv('APP_ENV') ?: 'development',
    ],
];
