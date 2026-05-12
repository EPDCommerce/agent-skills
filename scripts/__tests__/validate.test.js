'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const { spawnSync } = require('node:child_process');
const path = require('node:path');

const VALIDATE = path.resolve(__dirname, '..', 'validate.js');

test('validate.js passes against the live repo', () => {
  const result = spawnSync('node', [VALIDATE], { encoding: 'utf8' });
  assert.equal(
    result.status,
    0,
    `validate.js failed (exit ${result.status}):\nstdout:\n${result.stdout}\nstderr:\n${result.stderr}`,
  );
  assert.match(result.stdout, /ok\s+—\s+\d+\s+skill\(s\)\s+validated/);
});
