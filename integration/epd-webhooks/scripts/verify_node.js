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

  // Buffer.from(str, 'hex') never throws: it silently stops at the first
  // non-hex character. Check the shape explicitly so a malformed header gets
  // its own reason instead of looking like a mismatch.
  if (!/^[0-9a-fA-F]+$/.test(signature) || signature.length % 2 !== 0) {
    return { valid: false, reason: 'malformed_signature_hex' };
  }

  const expected = crypto.createHmac('sha256', hmacKey).update(signedPayload, 'utf8').digest('hex');
  const expectedBuf = Buffer.from(expected, 'hex');
  const actualBuf = Buffer.from(signature, 'hex');

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
  if (timestamp == null || signature == null) return null;
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

  // The result is an object, so it is always truthy. Callers must test
  // `.valid`, never the result itself. Every case below asserts on `.valid`.
  const cases = [
    ['valid signature', verifyWebhook(body, header, secret), true, undefined],
    ['uppercase hex', verifyWebhook(body, `t=${ts},v1=${sig.toUpperCase()}`, secret), true, undefined],
    ['tampered body', verifyWebhook(body + 'x', header, secret), false, 'signature_mismatch'],
    ['wrong secret', verifyWebhook(body, header, 'whsec_other'), false, 'signature_mismatch'],
    ['expired', verifyWebhook(body, `t=${ts - 1000},v1=${sig}`, secret), false, 'timestamp_outside_tolerance'],
    ['malformed header', verifyWebhook(body, 'not a signature', secret), false, 'malformed_signature_header'],
    ['non-hex signature', verifyWebhook(body, `t=${ts},v1=zz${sig.slice(2)}`, secret), false, 'malformed_signature_hex'],
    ['empty signature', verifyWebhook(body, `t=${ts},v1=`, secret), false, 'malformed_signature_hex'],
  ];
  let failed = 0;
  for (const [label, result, valid, reason] of cases) {
    const ok = result.valid === valid && result.reason === reason;
    if (!ok) failed++;
    console.log(`${ok ? 'ok  ' : 'FAIL'} ${label.padEnd(18)} ${JSON.stringify(result)}`);
  }
  process.exitCode = failed ? 1 : 0;
}
