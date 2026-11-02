<?php
require_once __DIR__ . '/../helpers/response.php';
require_once __DIR__ . '/../helpers/auth.php';
require_once __DIR__ . '/../helpers/db.php';
require_once __DIR__ . '/../connector/GenericCrmAdapter.php';

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
  $db = getDB();
  $cfg = require __DIR__ . '/../config.php';
  $rateLimit = (int)($cfg['app']['rate_limit_calls'] ?? 10);

  // Rate limit: max call attempts per recruiter per minute
  $stmt = $db->prepare('SELECT COUNT(*) FROM call_attempts WHERE recruiter_id=:rid AND created_at >= (NOW() - INTERVAL 60 SECOND)');
  $stmt->execute([':rid' => (int)$user['id']]);
  if ((int)$stmt->fetchColumn() >= $rateLimit) {
    jsonResponse(['error' => 'Rate limit exceeded. Please try again later.'], 429);
  }

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
      ':name' => trim($data['candidate_name'] ?? '') ?: null,
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

  // Best-effort: write the call outcome back to the connected CRM (HRMS)
  try {
    $adapter = new GenericCrmAdapter(json_decode($conn['config_json'], true));
    $crmCandidate = $adapter->getCandidate($id);
    $adapter->logCallOutcome($id, [
      'candidateId' => $crmCandidate['crm_id'],
      'candidateName' => $crmCandidate['name'],
      'contactNumber' => $crmCandidate['phone'],
      'emailId' => $crmCandidate['email'],
      'position' => $crmCandidate['position'],
      'callStatus' => 'placed',
      'remarks' => null,
      'currentStage' => 'Call',
      'currentStatus' => 'New',
      'nextCallDate' => null,
      'callAttempts' => $count,
      'assignedTo' => null,
      'timestamp' => date('c'),
    ]);
  } catch (\Throwable $e) {
    // CRM write-back is best-effort; never fail the attempt recording because of it
  }

  jsonResponse([
    'success' => true,
    'attempt_id' => (int)$db->lastInsertId(),
    'call_count' => $count,
    'idempotency_key' => $idempotencyKey,
  ], 201);
} catch (\Throwable $e) {
  jsonResponse(['error' => $e->getMessage()], 500);
}
