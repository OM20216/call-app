<?php
require_once __DIR__ . '/../helpers/response.php';
require_once __DIR__ . '/../helpers/auth.php';

setCORSHeaders();
startSession();

$user = currentUser();
if (!$user) {
  jsonResponse(['authenticated' => false]);
}
jsonResponse(['authenticated' => true, 'user' => [
  'id' => (int)$user['id'],
  'email' => $user['email'],
  'full_name' => $user['full_name'],
  'role' => $user['role'],
]]);

