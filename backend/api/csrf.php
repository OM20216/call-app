<?php
require_once __DIR__ . '/../helpers/response.php';
require_once __DIR__ . '/../helpers/auth.php';

setCORSHeaders();
startSession();
requireAuth();
jsonResponse(['token' => getCsrfToken()]);

