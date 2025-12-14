<?php
// save_data.php — accepts POST JSON { payload: {...} } and writes to foundry_map_data.json
// Enhanced with security measures: POST+JSON enforcement, payload validation, safe writes with flock
session_start([
    'cookie_httponly' => true,
    'cookie_samesite' => 'Lax'
]);

$config = require __DIR__ . '/config.php';
$dataFile = $config['data_file'];

header('Content-Type: application/json; charset=utf-8');

// Enforce POST method
if ($_SERVER['REQUEST_METHOD'] !== 'POST') {
    http_response_code(405);
    echo json_encode(['ok' => false, 'error' => 'method_not_allowed', 'message' => 'Only POST requests are accepted']);
    exit;
}

// Enforce JSON content type
$contentType = $_SERVER['CONTENT_TYPE'] ?? '';
if (stripos($contentType, 'application/json') === false) {
    http_response_code(415);
    echo json_encode(['ok' => false, 'error' => 'invalid_content_type', 'message' => 'Content-Type must be application/json']);
    exit;
}

// Check authentication
if (empty($_SESSION['admin'])) {
    http_response_code(401);
    echo json_encode(['ok' => false, 'error' => 'not_authenticated', 'message' => 'Admin authentication required']);
    exit;
}

// Read and validate raw input
$raw = file_get_contents('php://input');
if (!$raw) {
    http_response_code(400);
    echo json_encode(['ok' => false, 'error' => 'empty_body', 'message' => 'Request body is empty']);
    exit;
}

// Parse JSON
$body = json_decode($raw, true);
if ($body === null || !isset($body['payload'])) {
    http_response_code(400);
    echo json_encode(['ok' => false, 'error' => 'invalid_json', 'message' => 'Invalid JSON or missing payload field']);
    exit;
}

$payload = $body['payload'];

// Validate required payload structure
if (!isset($payload['buildings']) || !is_array($payload['buildings'])) {
    http_response_code(400);
    echo json_encode(['ok' => false, 'error' => 'missing_buildings', 'message' => 'Payload must include a buildings array']);
    exit;
}

if (!isset($payload['legion_data']) || !is_array($payload['legion_data'])) {
    http_response_code(400);
    echo json_encode(['ok' => false, 'error' => 'missing_legion_data', 'message' => 'Payload must include a legion_data array']);
    exit;
}

// Normalize floating point numbers (round to 2 decimal places)
foreach ($payload['buildings'] as &$building) {
    if (isset($building['gridX']) && is_numeric($building['gridX'])) {
        $building['gridX'] = round((float)$building['gridX'], 2);
    }
    if (isset($building['gridY']) && is_numeric($building['gridY'])) {
        $building['gridY'] = round((float)$building['gridY'], 2);
    }
    if (isset($building['img_scale']) && is_numeric($building['img_scale'])) {
        $building['img_scale'] = round((float)$building['img_scale'], 2);
    }
}
unset($building);

// Add metadata for change detection
if (!isset($payload['meta'])) {
    $payload['meta'] = [];
}
$payload['meta']['version'] = ($payload['meta']['version'] ?? 0) + 1;
$payload['meta']['updated_at'] = date('Y-m-d H:i:s');

// Encode to JSON
$encoded = json_encode($payload, JSON_PRETTY_PRINT | JSON_UNESCAPED_UNICODE);
if ($encoded === false) {
    http_response_code(500);
    echo json_encode(['ok' => false, 'error' => 'json_encode_failed', 'message' => 'Failed to encode data to JSON']);
    exit;
}

// Create history directory if it doesn't exist
$historyDir = __DIR__ . '/history';
if (!is_dir($historyDir)) {
    @mkdir($historyDir, 0755, true);
}

// Save timestamped copy to history (if directory exists)
if (is_dir($historyDir) && is_writable($historyDir)) {
    $timestamp = date('Y-m-d_H-i-s');
    $historyFile = $historyDir . '/foundry_map_data_' . $timestamp . '.json';
    @file_put_contents($historyFile, $encoded);
}

// Safe write with flock to prevent concurrent writes
$tmp = $dataFile . '.tmp.' . bin2hex(random_bytes(8));
$fp = fopen($tmp, 'w');
if ($fp === false) {
    http_response_code(500);
    echo json_encode(['ok' => false, 'error' => 'write_failed', 'message' => 'Failed to create temporary file']);
    exit;
}

// Acquire exclusive lock
if (!flock($fp, LOCK_EX)) {
    fclose($fp);
    @unlink($tmp);
    http_response_code(503);
    echo json_encode(['ok' => false, 'error' => 'lock_failed', 'message' => 'Could not acquire file lock, please try again']);
    exit;
}

// Write data
if (fwrite($fp, $encoded) === false) {
    flock($fp, LOCK_UN);
    fclose($fp);
    @unlink($tmp);
    http_response_code(500);
    echo json_encode(['ok' => false, 'error' => 'write_failed', 'message' => 'Failed to write data to file']);
    exit;
}

// Release lock and close
flock($fp, LOCK_UN);
fclose($fp);

// Atomic rename
if (!rename($tmp, $dataFile)) {
    @unlink($tmp);
    http_response_code(500);
    echo json_encode(['ok' => false, 'error' => 'rename_failed', 'message' => 'Failed to finalize save operation']);
    exit;
}

echo json_encode(['ok' => true, 'message' => 'Data saved successfully', 'version' => $payload['meta']['version']]);