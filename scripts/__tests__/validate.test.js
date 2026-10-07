'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const { spawnSync } = require('node:child_process');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');

const { findPinnedVersions, validateRepo } = require('../validate.js');

const REPO = path.resolve(__dirname, '..', '..');
const VALIDATE = path.join(REPO, 'scripts', 'validate.js');
const API = '2026-02-11';

test('validate.js passes against the live repo', () => {
  const result = spawnSync('node', [VALIDATE], { encoding: 'utf8' });
  assert.equal(
    result.status,
    0,
    `validate.js failed (exit ${result.status}):\nstdout:\n${result.stdout}\nstderr:\n${result.stderr}`,
  );
  assert.match(result.stdout, /ok\s+—\s+\d+\s+skill\(s\)\s+validated, \d+ pinned API version\(s\) agree/);
});

/**
 * A two-skill repository in a temp directory, using the real schemas. Returns
 * its root and a helper to write files into it. Each test breaks one thing.
 */
const roots = [];
test.after(() => {
  for (const r of roots) fs.rmSync(r, { recursive: true, force: true });
});

function fixture() {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'epd-validate-'));
  roots.push(root);
  const write = (rel, content) => {
    const p = path.join(root, rel);
    fs.mkdirSync(path.dirname(p), { recursive: true });
    fs.writeFileSync(p, typeof content === 'string' ? content : JSON.stringify(content, null, 2));
  };
  for (const f of ['schema.json', 'skill-frontmatter.schema.json']) {
    fs.cpSync(path.join(REPO, '.well-known', 'skills', f), path.join(root, '.well-known', 'skills', f));
  }
  const skillMd = (name, api = API) =>
    [
      '---',
      `name: ${name}`,
      'description: Use when testing the validator. Triggers when a fixture needs a skill. Skip when real.',
      'metadata:',
      '  version: 1.0.0',
      `  api_version: "${api}"`,
      '---',
      '',
      `# ${name}`,
      '',
    ].join('\n');
  const manifest = {
    name: 'epd-skills',
    version: '1.2.3',
    api_version: API,
    skills: [
      {
        name: 'int-one',
        kind: 'integration',
        description: 'An integration skill for the fixture.',
        files: ['integration/int-one/SKILL.md', 'integration/int-one/references/a.md'],
      },
      {
        name: 'wf-two',
        kind: 'workflow',
        description: 'A workflow skill for the fixture.',
        files: ['workflows/wf-two/SKILL.md'],
      },
    ],
  };
  write('.well-known/skills/index.json', manifest);
  write('package.json', { name: 'epd-skills', version: '1.2.3' });
  write('integration/int-one/SKILL.md', skillMd('int-one'));
  write('integration/int-one/references/a.md', `Send \`EPD-Version: ${API}\` on every request.\n`);
  write('workflows/wf-two/SKILL.md', skillMd('wf-two'));
  return { root, write, manifest, skillMd };
}

const run = (root) => validateRepo(root, { minPinned: 1 });

function assertOnly(result, pattern) {
  assert.equal(result.errors.length, 1, `expected one error, got:\n${result.errors.join('\n')}`);
  assert.match(result.errors[0], pattern);
}

test('a well-formed fixture has no errors — the baseline the next tests break', () => {
  const { root } = fixture();
  const r = run(root);
  assert.deepEqual(r.errors, []);
  assert.equal(r.skillCount, 2);
  assert.equal(r.pinned, 1);
});

test('a skill pinned to another API version is an error, not a warning', () => {
  const { root, write, skillMd } = fixture();
  write('workflows/wf-two/SKILL.md', skillMd('wf-two', '2025-01-01'));
  assertOnly(run(root), /wf-two\/SKILL\.md: metadata\.api_version "2025-01-01" != manifest "2026-02-11"/);
});

test('the manifest and package.json must agree on name and version', () => {
  const { root, write } = fixture();
  write('package.json', { name: 'epd-skills', version: '1.2.4' });
  assertOnly(run(root), /manifest version "1\.2\.3" != package\.json version "1\.2\.4"/);

  write('package.json', { name: 'something-else', version: '1.2.3' });
  assertOnly(run(root), /manifest name "epd-skills" != package\.json name "something-else"/);
});

test('a file in a skill directory that the manifest omits is caught', () => {
  const { root, write } = fixture();
  write('integration/int-one/scripts/helper.js', '// not listed\n');
  assertOnly(run(root), /integration\/int-one\/scripts\/helper\.js is in int-one's directory but not in its manifest files/);
});

test('a listed file outside the skill directory is caught', () => {
  const { root, write, manifest } = fixture();
  write('shared/b.md', 'shared\n');
  manifest.skills[1].files.push('shared/b.md');
  write('.well-known/skills/index.json', manifest);
  assertOnly(run(root), /"wf-two" lists shared\/b\.md, which is outside workflows\/wf-two\//);
});

test('a skill in the wrong kind directory, or a directory not named for it, is caught', () => {
  const { root, write, manifest } = fixture();
  manifest.skills[1].kind = 'integration';
  write('.well-known/skills/index.json', manifest);
  assertOnly(run(root), /"wf-two" \(kind integration\) should live at integration\/wf-two\//);

  const { root: root2, write: write2, manifest: m2, skillMd } = fixture();
  fs.rmSync(path.join(root2, 'workflows', 'wf-two'), { recursive: true });
  write2('workflows/wf-renamed/SKILL.md', skillMd('wf-two'));
  m2.skills[1].files = ['workflows/wf-renamed/SKILL.md'];
  write2('.well-known/skills/index.json', m2);
  assertOnly(run(root2), /"wf-two" \(kind workflow\) should live at workflows\/wf-two\/, not workflows\/wf-renamed\//);
});

test('a duplicate manifest entry is caught', () => {
  const { root, write, manifest } = fixture();
  manifest.skills.push({ ...manifest.skills[1] });
  write('.well-known/skills/index.json', manifest);
  assert.ok(run(root).errors.some((e) => /lists skill "wf-two" more than once/.test(e)));
});

test('the schema requires kind on a skill and api_version on the manifest', () => {
  const { root, write, manifest } = fixture();
  delete manifest.skills[0].kind;
  write('.well-known/skills/index.json', manifest);
  assertOnly(run(root), /manifest schema violations: .*must have required property 'kind'/);

  const { root: root2, write: write2, manifest: m2 } = fixture();
  delete m2.api_version;
  write2('.well-known/skills/index.json', m2);
  assertOnly(run(root2), /manifest schema violations: .*must have required property 'api_version'/);
});

test('a SKILL.md on disk that the manifest does not list is caught', () => {
  const { root, write, skillMd } = fixture();
  write('workflows/wf-three/SKILL.md', skillMd('wf-three'));
  assertOnly(run(root), /workflows\/wf-three\/SKILL\.md: SKILL\.md exists on disk but is not listed in the manifest/);
});

test('a pinned version that disagrees is caught with its file and line', () => {
  const { root, write } = fixture();
  write('docs/guide.md', `# Guide\n\ncurl -H "epd-version: 2025-06-01" ...\n`);
  assertOnly(run(root), /docs\/guide\.md:3: pins API version 2025-06-01, manifest says 2026-02-11/);
});

test('a webhook payload schema version is not an API version, and is left alone', () => {
  const { root, write } = fixture();
  write('docs/webhooks.md', '```json\n{ "api_version": "2026-02-10", "status": "enabled" }\n```\n');
  assert.deepEqual(run(root).errors, []);
});

test('what an agent said in a prompt-set run is a record, not a pinned version', () => {
  const { root, write } = fixture();
  const said = JSON.stringify({ answer: 'Send `EPD-Version: 2025-06-01` until you upgrade.' });
  write('testing/results/2026-10-05.json', said);
  write('testing/raw/2026-10-05/a__fire-1.jsonl', said);
  assert.deepEqual(run(root).errors, []);
  write('testing/prompts.json', said);
  assertOnly(run(root), /testing\/prompts\.json:1: pins API version 2025-06-01/);
});

test('finding no pinned versions at all fails rather than passing silently', () => {
  const { root } = fixture();
  const r = validateRepo(root, { minPinned: 5 });
  assertOnly(r, /only 1 pinned API version\(s\) found, expected at least 5/);
});

test('findPinnedVersions reads every form the repository uses', () => {
  const forms = [
    'EPD-Version: 2026-02-11',
    'curl -H "epd-version: 2026-02-11"',
    '"epd-version": "2026-02-11"',
    "'EPD-Version': '2026-02-11',",
    "const EPD_API_VERSION = '2026-02-11';",
    "const EPD_API_VERSION = process.env.EPD_API_VERSION ?? '2026-02-11';",
    'private const API_VERSION = \'2026-02-11\';',
  ];
  for (const f of forms) {
    const found = findPinnedVersions(f);
    assert.equal(found.length, 1, `expected one version in: ${f}`);
    assert.equal(found[0].version, '2026-02-11');
  }
  // Prose that names the header without a value, and lowercase api_version
  // fields, are not pins.
  for (const f of ['Without the `EPD-Version` header, the default applies.', '"api_version": "2026-02-10"', 'api_version: null']) {
    assert.deepEqual(findPinnedVersions(f), [], `expected no version in: ${f}`);
  }
});
