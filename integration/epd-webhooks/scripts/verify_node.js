// EPD webhook signature verifier — Node.js, zero dependencies.
// Mirrors WebhookSigningService in the EPD backend:
//   header:  EPD-Signature: t=<unix_seconds>,v1=<hex_sha256>
//   signed:  HMAC-SHA256(secret, `${timestamp}.${raw_body}`)
//   replay:  reject if |now - t| > tolerance_seconds (default 300)

'use strict';

const crypto = require('node:crypto');

const SIGNATURE_VERSION = 'v1';
const DEFAULT_TOLERANCE_SECONDS = 300;
const SIGNING_SECRET_PREFIX = 'whsec_';

/**
 * Verify an EPD webhook signature.
 *
 * @param {string|Buffer} payload  Raw request body — exact bytes as received.
 * @param {string} signatureHeader Value of the `EPD-Signature` header.
 * @param {string} secret          Endpoint signing secret (`whsec_...`).
 * @param {number} [toleranceSeconds=300] Replay window.
 * @returns {{ valid: true } | { valid: false, reason: string }}
 */
function verifyWebhook(payload, signatureHeader, secret, toleranceSeconds = DEFAULT_TOLERANCE_SECONDS) {
  if (!signatureHeader || typeof signatureHeader !== 'string') {
    return { valid: false, reason: 'missing_signature_header' };
  }
  if (!secret || typeof secret !== 'string') {
    return { valid: false, reason: 'missing_secret' };
  }

  const parsed = parseSignatureHeader(signatureHeader);
  if (!parsed) return { valid: false, reason: 'malformed_signature_header' };

  const { timestamp, signature } = parsed;
  const now = Math.floor(Date.now() / 1000);
  if (Math.abs(now - timestamp) > toleranceSeconds) {
    return { valid: false, reason: 'timestamp_outside_tolerance' };
  }

  const payloadStr = Buffer.isBuffer(payload) ? payload.toString('utf8') : payload;
  const signedPayload = `${timestamp}.${payloadStr}`;

  // EPD strips the `whsec_` prefix before HMAC. Mirror that behavior so the
  // caller can pass the secret as-is from their secret store.
  const hmacKey = secret.startsWith(SIGNING_SECRET_PREFIX)
    ? secret.slice(SIGNING_SECRET_PREFIX.length)
    : secret;

  const expected = crypto.createHmac('sha256', hmacKey).update(signedPayload, 'utf8').digest('hex');
  const expectedBuf = Buffer.from(expected, 'hex');
  let actualBuf;
  try {
    actualBuf = Buffer.from(signature, 'hex');
  } catch {
    return { valid: false, reason: 'malformed_signature_hex' };
  }

  if (expectedBuf.length !== actualBuf.length) {
    return { valid: false, reason: 'signature_mismatch' };
  }
  if (!crypto.timingSafeEqual(expectedBuf, actualBuf)) {
    return { valid: false, reason: 'signature_mismatch' };
  }
  return { valid: true };
}

function parseSignatureHeader(header) {
  let timestamp = null;
  let signature = null;
  for (const part of header.split(',')) {
    const eq = part.indexOf('=');
    if (eq < 0) continue;
    const k = part.slice(0, eq).trim();
    const v = part.slice(eq + 1).trim();
    if (k === 't') {
      const n = Number(v);
      if (Number.isInteger(n) && n > 0) timestamp = n;
    } else if (k === SIGNATURE_VERSION) {
      signature = v;
    }
  }
  if (timestamp == null || !signature) return null;
  return { timestamp, signature };
}

module.exports = { verifyWebhook };

// ----- Self-test (runs only when invoked directly) -----
if (require.main === module) {
  const secret = 'whsec_test1234567890abcdef1234567890abcdef1234567890abcdef1234567890';
  const body = JSON.stringify({ id: 'evt_test', type: 'order.succeeded', data: { id: 'ord_123' } });
  const ts = Math.floor(Date.now() / 1000);
  const hmacKey = secret.slice(SIGNING_SECRET_PREFIX.length);
  const sig = crypto.createHmac('sha256', hmacKey).update(`${ts}.${body}`).digest('hex');
  const header = `t=${ts},v1=${sig}`;

  console.log('valid signature:', verifyWebhook(body, header, secret));
  console.log('tampered body:  ', verifyWebhook(body + 'x', header, secret));
  console.log('expired:        ', verifyWebhook(body, `t=${ts - 1000},v1=${sig}`, secret));
  console.log('malformed:      ', verifyWebhook(body, 'not a signature', secret));
}
