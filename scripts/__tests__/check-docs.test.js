'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const { spawnSync } = require('node:child_process');
const fs = require('node:fs');
const path = require('node:path');
const matter = require('gray-matter');

const REPO_ROOT = path.resolve(__dirname, '..', '..');
const CHECK_DOCS = path.join(REPO_ROOT, 'scripts', 'check-docs.js');
const DOCS_DIR = path.join(REPO_ROOT, 'docs');
const MANIFEST = JSON.parse(
  fs.readFileSync(path.join(REPO_ROOT, '.well-known', 'skills', 'index.json'), 'utf8'),
);

const {
  REQUIRED_SECTIONS,
  extractLinks,
  findBrokenLinks,
  headingAnchors,
  isExternal,
  slugify,
  stripFences,
} = require(CHECK_DOCS);

test('check-docs.js passes against the live repo', () => {
  const result = spawnSync('node', [CHECK_DOCS], { encoding: 'utf8' });
  assert.equal(
    result.status,
    0,
    `check-docs.js failed (exit ${result.status}):\nstdout:\n${result.stdout}\nstderr:\n${result.stderr}`,
  );
  assert.match(result.stdout, /ok\s+—\s+\d+\s+guide\(s\)\s+validated/);
});

test('every manifest skill has a guide, and every guide a skill', () => {
  const onDisk = fs
    .readdirSync(DOCS_DIR)
    .filter((f) => f.endsWith('.md') && f !== 'README.md')
    .map((f) => f.replace(/\.md$/, ''))
    .sort();
  const inManifest = MANIFEST.skills.map((s) => s.name).sort();
  assert.deepEqual(onDisk, inManifest);
});

test('the link checker rejects a target that does not exist', () => {
  // Resolved as if it lived in docs/, where the real guides live.
  const pretendFile = path.join(DOCS_DIR, 'epd-refunds.md');
  const broken = findBrokenLinks(
    pretendFile,
    'See [the skill](../workflows/epd-refunds/SKILL.md) and [nothing](./no-such-guide.md).',
  );
  assert.deepEqual(
    broken.map((b) => b.target),
    ['./no-such-guide.md'],
    'the real skill link should pass and the invented one should fail',
  );
});

test('the link checker ignores external links and fenced code', () => {
  const pretendFile = path.join(DOCS_DIR, 'epd-refunds.md');
  const src = [
    '# What it does',
    '[http](https://example.com/missing.md)',
    '[mail](mailto:nobody@example.com)',
    '[anchor](#what-it-does)',
    '[file plus anchor](../SAFETY.md#the-four-tiers)',
    '```md',
    '[inside a fence](./definitely-not-here.md)',
    '```',
  ].join('\n');
  assert.deepEqual(findBrokenLinks(pretendFile, src), []);
});

test('the link checker rejects an anchor with no matching heading', () => {
  const pretendFile = path.join(DOCS_DIR, 'epd-refunds.md');
  const broken = findBrokenLinks(
    pretendFile,
    '# A heading\n[good](#a-heading) [bad](#not-a-heading) [cross-file](../SAFETY.md#no-such-section)',
  );
  assert.deepEqual(
    broken.map((b) => `${b.target}:${b.reason}`),
    ['#not-a-heading:anchor', '../SAFETY.md#no-such-section:anchor'],
  );
});

test('slugify matches the GitHub forms used in SAFETY.md', () => {
  assert.equal(slugify('The four tiers'), 'the-four-tiers');
  assert.equal(slugify('T0 — reads'), 't0--reads');
  assert.equal(
    slugify('8. Raw card data never touches the MCP surface'),
    '8-raw-card-data-never-touches-the-mcp-surface',
  );
  assert.equal(slugify('9. Surface `request_id` on every failure'), '9-surface-request_id-on-every-failure');
});

test('SAFETY.md contents and redline anchors all resolve', () => {
  const safety = path.join(REPO_ROOT, 'SAFETY.md');
  const src = fs.readFileSync(safety, 'utf8');
  assert.deepEqual(findBrokenLinks(safety, src), []);
  // The redline section is the reviewable surface; it must still be there.
  assert.match(src, /^## How to redline this file$/m);
  assert.ok(headingAnchors(src).has('standing-authorizations'));
});

test('stripFences blanks fenced lines without shifting line numbers', () => {
  const src = 'a\n```\nb\n```\nc';
  assert.equal(stripFences(src).split('\n').length, src.split('\n').length);
  assert.deepEqual(extractLinks('x\n```\n[y](./z.md)\n```'), []);
});

test('isExternal covers the schemes that appear in the repo', () => {
  for (const t of ['https://x', 'http://x', 'mailto:a@b', '//cdn']) {
    assert.equal(isExternal(t), true, t);
  }
  // Anchors are NOT external — they are resolved against the target's headings.
  for (const t of ['./a.md', '../b/c.md', 'd.md', '#anchor', 'a.md#anchor']) {
    assert.equal(isExternal(t), false, t);
  }
});

test('every guide carries all six template sections', () => {
  for (const skill of MANIFEST.skills) {
    const src = fs.readFileSync(path.join(DOCS_DIR, `${skill.name}.md`), 'utf8');
    const { content } = matter(src);
    for (const section of REQUIRED_SECTIONS) {
      assert.ok(
        content.includes(`## ${section}`),
        `docs/${skill.name}.md is missing "## ${section}"`,
      );
    }
  }
});

test('every guide has a worked transcript with a confirmation or a refusal', () => {
  for (const skill of MANIFEST.skills) {
    const src = fs.readFileSync(path.join(DOCS_DIR, `${skill.name}.md`), 'utf8');
    const transcript = src.split('## A worked transcript')[1] || '';
    assert.ok(
      transcript.trim().length > 500,
      `docs/${skill.name}.md has no substantive worked transcript`,
    );
  }
});
