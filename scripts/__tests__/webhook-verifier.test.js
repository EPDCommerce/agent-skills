'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const crypto = require('node:crypto');
const fs = require('node:fs');
const path = require('node:path');

const SKILL_DIR = path.resolve(__dirname, '..', '..', 'integration', 'epd-webhooks');
const { verifyWebhook } = require(path.join(SKILL_DIR, 'scripts', 'verify_node.js'));

const SECRET = 'whsec_test1234567890abcdef1234567890abcdef1234567890abcdef1234567890';
const BODY = JSON.stringify({ id: 'evt_test', type: 'order.succeeded', data: { id: 'ord_123' } });

function sign(body, ts, secret = SECRET) {
  const key = secret.startsWith('whsec_') ? secret.slice('whsec_'.length) : secret;
  return crypto.createHmac('sha256', key).update(`${ts}.${body}`).digest('hex');
}

const now = () => Math.floor(Date.now() / 1000);

test('accepts a correctly signed payload, as a string or a Buffer', () => {
  const ts = now();
  const header = `t=${ts},v1=${sign(BODY, ts)}`;
  assert.deepEqual(verifyWebhook(BODY, header, SECRET), { valid: true });
  assert.deepEqual(verifyWebhook(Buffer.from(BODY), header, SECRET), { valid: true });
});

test('accepts uppercase hex', () => {
  const ts = now();
  assert.equal(verifyWebhook(BODY, `t=${ts},v1=${sign(BODY, ts).toUpperCase()}`, SECRET).valid, true);
});

test('rejects each failure with its own reason', () => {
  const ts = now();
  const sig = sign(BODY, ts);
  const cases = [
    [BODY + 'x', `t=${ts},v1=${sig}`, SECRET, 'signature_mismatch'],
    [BODY, `t=${ts},v1=${sig}`, 'whsec_other', 'signature_mismatch'],
    [BODY, `t=${ts - 1000},v1=${sign(BODY, ts - 1000)}`, SECRET, 'timestamp_outside_tolerance'],
    [BODY, `t=${ts + 1000},v1=${sign(BODY, ts + 1000)}`, SECRET, 'timestamp_outside_tolerance'],
    [BODY, 'not a signature', SECRET, 'malformed_signature_header'],
    [BODY, `v1=${sig}`, SECRET, 'malformed_signature_header'],
    [BODY, `t=${ts},v1=zz${sig.slice(2)}`, SECRET, 'malformed_signature_hex'],
    [BODY, `t=${ts},v1=${sig.slice(1)}`, SECRET, 'malformed_signature_hex'],
    [BODY, `t=${ts},v1=`, SECRET, 'malformed_signature_hex'],
    [BODY, `t=${ts},v1=${sig.slice(2)}`, SECRET, 'signature_mismatch'],
    [BODY, '', SECRET, 'missing_signature_header'],
    [BODY, `t=${ts},v1=${sig}`, '', 'missing_secret'],
  ];
  for (const [body, header, secret, reason] of cases) {
    assert.deepEqual(verifyWebhook(body, header, secret), { valid: false, reason }, `${header} / ${reason}`);
  }
});

test('a rejection is still a truthy object — callers must read .valid', () => {
  const result = verifyWebhook(BODY + 'x', `t=${now()},v1=${sign(BODY, now())}`, SECRET);
  assert.equal(result.valid, false);
  // This is the whole bug class: `if (!verifyWebhook(...))` never fires.
  assert.equal(!result, false);
});

test('the epd-webhooks examples test `valid`, never the result object', () => {
  // Normalise line endings: a Windows checkout with core.autocrlf has CRLF.
  const skill = fs.readFileSync(path.join(SKILL_DIR, 'SKILL.md'), 'utf8').replace(/\r\n/g, '\n');
  const fences = [...skill.matchAll(/```(js|python|php)\n([\s\S]*?)```/g)].map(([, lang, code]) => ({ lang, code }));
  const examples = fences.filter(({ code }) => /verify_?[wW]ebhook\(/.test(code));
  assert.equal(examples.length, 3, 'expected one framework example per verifier language');

  const truthiness = /if\s*\(\s*!\s*verify_?[wW]ebhook\(|if\s+not\s+verify_webhook\(/;
  const readsValid = { js: /\{\s*valid\b/, python: /\.valid\b/, php: /\['valid'\]/ };
  for (const { lang, code } of examples) {
    assert.doesNotMatch(code, truthiness, `${lang} example tests the result object for truthiness`);
    assert.match(code, readsValid[lang], `${lang} example does not read the valid field`);
  }
});
