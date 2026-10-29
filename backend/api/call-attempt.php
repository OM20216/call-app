<?php
require_once __DIR__ . '/../helpers/response.php';
require_once __DIR__ . '/../helpers/auth.php';
require_once __DIR__ . '/../helpers/db.php';

setCORSHeaders();
startSession();
$user = requireAuth();
if ($_SERVER['REQUEST_METHOD'] !== 'POST') {
  jsonResponse(['error' => 'Method not allowed.'], 405);
}
verifyCsrf();

$data = json_decode(file_get_contents('php://input'), true) ?? [];
$id = trim($data['candidate_id'] ?? $_POST['candidate_id'] ?? '');
if ($id === '') {
  jsonResponse(['error' => 'Candidate ID required.'], 400);
}

$idempotencyKey = trim($data['idempotency_key'] ?? bin2hex(random_bytes(16)));

try {
   = getDB();
  try {
     = require __DIR__ . '/../config.php';
     = (int)(['app']['rate_limit_calls'] ?? 10);
     = ->prepare('SELECT COUNT(*) FROM call_attempts WHERE recruiter_id=:rid AND created_at >= (NOW() - INTERVAL 60 SECOND)');
    ->execute([':rid' => (int)['id']]);
    if ((int)->fetchColumn() >= ) {
      jsonResponse(['error' => 'Rate limit exceeded. Please try again later.'], 429);
    }
  } catch (\Throwable ) {}
    ->execute([':rid' => (int)['id']]);
    if ((int)->fetchColumn() >= ) {
      jsonResponse(['error' => 'Rate limit exceeded. Please try again later.'], 429);
    }
  } catch (\Throwable ) {}

  $stmt = $db->prepare('SELECT * FROM crm_connections WHERE is_active=1 LIMIT 1');
  $stmt->execute();
  $conn = $stmt->fetch();
  if (!$conn) {
    jsonResponse(['error' => 'No active CRM connection.'], 500);
  }
  $rec = $db->prepare('INSERT INTO call_attempts (crm_connection_id, crm_candidate_id, recruiter_id, idempotency_key, candidate_name) VALUES (:ccid, :cid, :rid, :key, :name)');
  try {
    $rec->execute([
      ':ccid' => (int)$conn['id'],
      ':cid'  => $id,
      ':rid'  => (int)$user['id'],
      ':key'  => $idempotencyKey,
      ':name' => null,
    ]);
  } catch (PDOException $e) {
    if ($e->getCode() === '23000') {
      jsonResponse(['error' => 'Duplicate request.'], 409);
    }
    throw $e;
  }
  $countStmt = $db->prepare('SELECT COUNT(*) FROM call_attempts WHERE crm_candidate_id=:cid AND crm_connection_id=:ccid');
  $countStmt->execute([':cid' => $id, ':ccid' => (int)$conn['id']]);
  $count = (int)$countStmt->fetchColumn();
  jsonResponse([
    'success' => true,
    'attempt_id' => (int)$db->lastInsertId(),
    'call_count' => $count,
    'idempotency_key' => $idempotencyKey,
  ], 201);
} catch (\Throwable $e) {
  jsonResponse(['error' => $e->getMessage()], 500);
}

