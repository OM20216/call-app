<?php
require_once __DIR__ . '/../helpers/response.php';
require_once __DIR__ . '/../helpers/auth.php';
require_once __DIR__ . '/../helpers/db.php';

setCORSHeaders();
startSession();
requireAuth();

$id = trim($_GET['id'] ?? '');
if ($id === '') {
  jsonResponse(['error' => 'Candidate ID required.'], 400);
}
try {
  $db = getDB();
  $stmt = $db->prepare('SELECT * FROM crm_connections WHERE is_active=1 LIMIT 1');
  $stmt->execute();
  $conn = $stmt->fetch();
  if (!$conn) {
    jsonResponse(['error' => 'No active CRM connection.'], 500);
  }
  $hist = $db->prepare('SELECT id, crm_connection_id, crm_candidate_id, candidate_name, recruiter_id, idempotency_key, created_at FROM call_attempts WHERE crm_candidate_id=:cid AND crm_connection_id=:ccid ORDER BY created_at DESC LIMIT 50');
  $hist->execute([':cid' => $id, ':ccid' => (int)$conn['id']]);
  jsonResponse(['attempts' => $hist->fetchAll()]);
} catch (\Throwable $e) {
  jsonResponse(['error' => $e->getMessage()], 500);
}
