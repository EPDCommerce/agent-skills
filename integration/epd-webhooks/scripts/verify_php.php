<?php
/**
 * EPD webhook signature verifier — PHP, zero dependencies.
 *
 * Mirrors WebhookSigningService in the EPD backend:
 *   header:  EPD-Signature: t=<unix_seconds>,v1=<hex_sha256>
 *   signed:  HMAC-SHA256(secret, "{timestamp}.{raw_body}")
 *   replay:  reject if |now - t| > tolerance_seconds (default 300)
 */

declare(strict_types=1);

namespace Epd\Webhooks;

const SIGNATURE_VERSION = 'v1';
const DEFAULT_TOLERANCE_SECONDS = 300;
const SIGNING_SECRET_PREFIX = 'whsec_';

/**
 * Verify an EPD webhook signature.
 *
 * @param string $payload          Raw request body — exact bytes as received
 *                                 (use file_get_contents('php://input') or
 *                                 your framework's raw-body accessor, NOT a
 *                                 re-serialized array).
 * @param string $signatureHeader  Value of the EPD-Signature header.
 * @param string $secret           Endpoint signing secret (whsec_...).
 * @param int    $toleranceSeconds Replay window.
 *
 * @return array{valid:bool, reason?:string}
 */
function verify_webhook(
    string $payload,
    string $signatureHeader,
    string $secret,
    int $toleranceSeconds = DEFAULT_TOLERANCE_SECONDS
): array {
    if ($signatureHeader === '') {
        return ['valid' => false, 'reason' => 'missing_signature_header'];
    }
    if ($secret === '') {
        return ['valid' => false, 'reason' => 'missing_secret'];
    }

    $parsed = _parse_signature_header($signatureHeader);
    if ($parsed === null) {
        return ['valid' => false, 'reason' => 'malformed_signature_header'];
    }
    [$timestamp, $signatureHex] = $parsed;

    $now = time();
    if (abs($now - $timestamp) > $toleranceSeconds) {
        return ['valid' => false, 'reason' => 'timestamp_outside_tolerance'];
    }

    $signedPayload = $timestamp . '.' . $payload;
    // EPD strips the `whsec_` prefix before HMAC. Mirror that behavior so the
    // caller can pass the secret as-is from their secret store.
    $hmacKey = str_starts_with($secret, SIGNING_SECRET_PREFIX)
        ? substr($secret, strlen(SIGNING_SECRET_PREFIX))
        : $secret;
    $expected = hash_hmac('sha256', $signedPayload, $hmacKey);

    // hash_equals is constant-time and length-safe.
    if (!hash_equals($expected, $signatureHex)) {
        return ['valid' => false, 'reason' => 'signature_mismatch'];
    }
    return ['valid' => true];
}

/**
 * @return array{0:int,1:string}|null
 */
function _parse_signature_header(string $header): ?array
{
    $timestamp = null;
    $signature = null;
    foreach (explode(',', $header) as $part) {
        $eq = strpos($part, '=');
        if ($eq === false) {
            continue;
        }
        $k = trim(substr($part, 0, $eq));
        $v = trim(substr($part, $eq + 1));
        if ($k === 't' && ctype_digit($v)) {
            $n = (int) $v;
            if ($n > 0) {
                $timestamp = $n;
            }
        } elseif ($k === SIGNATURE_VERSION) {
            $signature = $v;
        }
    }
    if ($timestamp === null || $signature === null) {
        return null;
    }
    return [$timestamp, $signature];
}

// ----- Self-test (runs only when invoked directly) -----
if (PHP_SAPI === 'cli' && realpath($_SERVER['argv'][0] ?? '') === __FILE__) {
    $secret = 'whsec_test1234567890abcdef1234567890abcdef1234567890abcdef1234567890';
    $body = json_encode(['id' => 'evt_test', 'type' => 'order.succeeded', 'data' => ['id' => 'ord_123']]);
    $ts = time();
    $hmacKey = substr($secret, strlen(SIGNING_SECRET_PREFIX));
    $sig = hash_hmac('sha256', $ts . '.' . $body, $hmacKey);
    $header = "t={$ts},v1={$sig}";

    echo "valid signature: ", var_export(verify_webhook($body, $header, $secret), true), PHP_EOL;
    echo "tampered body:   ", var_export(verify_webhook($body . 'x', $header, $secret), true), PHP_EOL;
    echo "expired:         ", var_export(verify_webhook($body, "t=" . ($ts - 1000) . ",v1={$sig}", $secret), true), PHP_EOL;
    echo "malformed:       ", var_export(verify_webhook($body, 'not a signature', $secret), true), PHP_EOL;
}
