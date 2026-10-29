<?php
declare(strict_types=1);

function jsonResponse(array $data, int $status = 200): void{
  http_response_code($status);
  header('Content-Type: application/json; charset=utf-8');
  echo json_encode($data, JSON_UNESCAPED_UNICODE | JSON_UNESCAPED_SLASHES);
  exit;
}

function setCORSHeaders(): void{
  $cfg = require __DIR__ . '/../config.php';
  $origin = $_SERVER['HTTP_ORIGIN'] ?? '';
  $allow = $cfg['app']['allowed_origins'];
  $allowedOrigins = array_map('trim', explode(',', $allow));
  if ($allow === '*' || $origin === '' || in_array($origin, $allowedOrigins, true)) {
    if ($origin !== '') header('Access-Control-Allow-Origin: ' . $origin);
    else header('Access-Control-Allow-Origin: *');
    header('Access-Control-Allow-Credentials: true');
  }
  header('Access-Control-Allow-Methods: GET, POST, PUT, DELETE, OPTIONS');
  header('Access-Control-Allow-Headers: Content-Type, X-CSRF-Token, Authorization');
  if ($_SERVER['REQUEST_METHOD'] === 'OPTIONS'){http_response_code(204);exit;}
}

