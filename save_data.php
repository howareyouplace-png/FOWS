<?php
// save_data.php — accepts POST JSON { payload: {...} } and writes to foundry_map_data.json
session_start();
$config = require __DIR__ . '/config.php';
$dataFile = $config['data_file'];

header('Content-Type: application/json; charset=utf-8');

if (empty($_SESSION['admin'])) {
    echo json_encode(['ok' => false, 'error' => 'not_authenticated']);
    exit;
}

$raw = file_get_contents('php://input');
if (!$raw) {
    echo json_encode(['ok' => false, 'error' => 'empty_body']);
    exit;
}

$body = json_decode($raw, true);
if ($body === null || !isset($body['payload'])) {
    echo json_encode(['ok' => false, 'error' => 'invalid_json']);
    exit;
}

$payload = $body['payload'];

// Basic sanity: ensure buildings and legion_data exist
if (!isset($payload['buildings']) || !isset($payload['legion_data'])) {
    // still allow but warn in response
}

$encoded = json_encode($payload, JSON_PRETTY_PRINT | JSON_UNESCAPED_UNICODE);
if ($encoded === false) {
    echo json_encode(['ok' => false, 'error' => 'json_encode_failed']);
    exit;
}

// safe write (temp file then rename)
$tmp = $dataFile . '.tmp';
if (file_put_contents($tmp, $encoded) === false) {
    echo json_encode(['ok' => false, 'error' => 'write_failed']);
    exit;
}
if (!rename($tmp, $dataFile)) {
    echo json_encode(['ok' => false, 'error' => 'rename_failed']);
    exit;
}

echo json_encode(['ok' => true]);