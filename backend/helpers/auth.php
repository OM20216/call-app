<?php
declare(strict_types=1);

function startSession(): void{
  if (session_status() === PHP_SESSION_ACTIVE) return;
  $c = require __DIR__ . '/../config.php';
  $s = $c['session'];
  session_name($s['name']);
  session_set_cookie_params([
    'lifetime' => $s['lifetime'],
    'path' => '/',
    'secure' => $s['cookie_secure'],
    'httponly' => $s['cookie_httponly'],
    'samesite' => $s['cookie_samesite'],
  ]);
  session_start();
}

function currentUser(): ?array{
  startSession();
  if (empty($_SESSION['user_id'])) return null;
  try {
    require_once __DIR__ . '/db.php';
    $stmt = getDB()->prepare('SELECT id,email,full_name,role FROM hr_users WHERE id=:id AND is_active=1 LIMIT 1');
    $stmt->execute([':id' => (int)$_SESSION['user_id']]);
    return $stmt->fetch() ?: null;
  } catch (\Throwable $e) {
    return null;
  }
}

function requireAuth(): array{
  $u = currentUser();
  if (!$u){ require_once __DIR__ . '/response.php'; jsonResponse(['error'=>'Authentication required.'],401); }
  return $u;
}

function requireAdmin(): array{
  $u = requireAuth();
  if ($u['role'] !== 'admin'){ require_once __DIR__ . '/response.php'; jsonResponse(['error'=>'Forbidden.'],403); }
  return $u;
}

function getCsrfToken(): string{
  startSession();
  if (empty($_SESSION['csrf_token'])) $_SESSION['csrf_token'] = bin2hex(random_bytes(32));
  return $_SESSION['csrf_token'];
}

function verifyCsrf(): void{
  startSession();
  require_once __DIR__ . '/response.php';
  if (!hash_equals($_SESSION['csrf_token'] ?? '', $_SERVER['HTTP_X_CSRF_TOKEN'] ?? '')){
    jsonResponse(['error'=>'Invalid CSRF token.'],403);
  }
}

