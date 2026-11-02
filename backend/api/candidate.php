<?php
require_once __DIR__ . '/../helpers/response.php';
require_once __DIR__ . '/../helpers/auth.php';
require_once __DIR__ . '/../connector/GenericCrmAdapter.php';
require_once __DIR__ . '/../helpers/db.php';

setCORSHeaders();
startSession();
requireAuth();

$id = trim($_GET['id'] ?? '');
if ($id === '') {
  jsonResponse(['error' => 'Candidate ID required.'], 400);
}

try {
  // Try to get active CRM connection and fetch candidate
  $cfg = require __DIR__ . '/../config.php';
  $db = getDB();
  $stmt = $db->prepare('SELECT * FROM crm_connections WHERE is_active=1 LIMIT 1');
  $stmt->execute();
  $conn = $stmt->fetch();
  if (!$conn) {
    jsonResponse(['error' => 'No active CRM connection configured.'], 500);
  }
  $configJson = json_decode($conn['config_json'], true);
  if (!is_array($configJson)) {
    jsonResponse(['error' => 'Invalid CRM configuration.'], 500);
  }
  $adapter = new GenericCrmAdapter($configJson);
  $candidate = $adapter->getCandidate($id);

  // Call count for this candidate (attempts logged by any recruiter via this app)
  $countStmt = $db->prepare('SELECT COUNT(*) FROM call_attempts WHERE crm_candidate_id=:cid AND crm_connection_id=:ccid');
  $countStmt->execute([':cid' => $id, ':ccid' => (int)$conn['id']]);
  $callCount = (int)$countStmt->fetchColumn();

  jsonResponse([
    'candidate' => [
      'crm_id' => $candidate['crm_id'],
      'name' => $candidate['name'],
      'phone' => $candidate['phone'],
      'email' => $candidate['email'],
      'position' => $candidate['position'],
    ],
    'call_count' => $callCount,
  ]);
} catch (\Throwable $e) {
  $code = $e->getCode();
  if ($code == 404) {
    jsonResponse(['error' => 'Candidate not found.'], 404);
  }
  jsonResponse(['error' => $e->getMessage()], 500);
}

