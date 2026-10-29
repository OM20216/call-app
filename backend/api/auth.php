<?php
require_once __DIR__ . '/../helpers/response.php';
require_once __DIR__ . '/../helpers/auth.php';
require_once __DIR__ . '/../helpers/db.php';

setCORSHeaders();
startSession();

if ($_SERVER['REQUEST_METHOD'] !== 'POST') {
  jsonResponse(['error' => 'Method not allowed.'], 405);
}

$data = json_decode(file_get_contents('php://input'), true) ?? [];
$email = trim($data['email'] ?? '');
$password = $data['password'] ?? '';

if ($email === '' || $password === '') {
  jsonResponse(['error' => 'Email and password required.'], 400);
}

try {
  $db = getDB();
  $stmt = $db->prepare('SELECT id,email,password_hash,full_name,role,is_active FROM hr_users WHERE email=:email LIMIT 1');
  $stmt->execute([':email' => $email]);
  $user = $stmt->fetch();
  if (!$user || (int)$user['is_active'] !== 1) {
    jsonResponse(['error' => 'Invalid credentials.'], 401);
  }
  if (!password_verify($password, $user['password_hash'])) {
    jsonResponse(['error' => 'Invalid credentials.'], 401);
  }
  $_SESSION['user_id'] = (int)$user['id'];
  jsonResponse(['success' => true, 'user' => [
    'id' => (int)$user['id'],
    'email' => $user['email'],
    'full_name' => $user['full_name'],
    'role' => $user['role'],
  ]]);
} catch (\Throwable $e) {
  jsonResponse(['error' => $e->getMessage()], 500);
}

