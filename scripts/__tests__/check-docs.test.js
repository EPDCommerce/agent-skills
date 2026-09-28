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
  RECIPE_SECTIONS,
  REQUIRED_SECTIONS,
  extractLinks,
  extractToolCalls,
  findBrokenLinks,
  loadOwners,
  loadToolSnapshot,
  MIN_TOOL_BLOCKS,
  headingAnchors,
  isExternal,
  recipeProblems,
  recipeSteps,
  slugify,
  stripFences,
  tierOfTool,
} = require(CHECK_DOCS);

const RECIPES_DIR = path.join(REPO_ROOT, 'recipes');

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

test('the tool-call extractor survives CRLF, which a Windows checkout produces', () => {
  const crlf = '```\r\ntool: ping\r\ninput: {}\r\n```\r\n';
  const lf = crlf.replace(/\r\n/g, '\n');
  assert.equal(extractToolCalls(crlf).length, 1, 'CRLF source found no tool blocks');
  assert.equal(extractToolCalls(lf).length, 1);
});

test('the tool-call extractor reads the tool name and its arguments', () => {
  const src = [
    '```',
    'tool: refund_order',
    'input:',
    '  order_id: <uuid>',
    '  amount: 1500',
    '  idempotency_key: <UUID v4>',
    '```',
  ].join('\n');
  assert.deepEqual(extractToolCalls(src), [
    { tool: 'refund_order', args: ['order_id', 'amount', 'idempotency_key'], line: 2 },
  ]);
});

test('every documented tool call names a real tool and real parameters', () => {
  const snapshot = loadToolSnapshot();
  assert.ok(snapshot, 'no tools-YYYY-MM-DD.json snapshot found');

  const roots = ['docs', 'workflows', 'integration', 'recipes'];
  const files = [];
  const walk = (dir) => {
    for (const e of fs.readdirSync(dir, { withFileTypes: true })) {
      const p = path.join(dir, e.name);
      if (e.isDirectory()) walk(p);
      else if (e.name.endsWith('.md')) files.push(p);
    }
  };
  for (const r of roots) walk(path.join(REPO_ROOT, r));

  let seen = 0;
  for (const f of files) {
    for (const { tool, args } of extractToolCalls(fs.readFileSync(f, 'utf8'))) {
      seen++;
      const def = snapshot.tools.find((t) => t.name === tool);
      assert.ok(def, `${path.basename(f)}: no such tool "${tool}"`);
      const declared = Object.keys(def.inputSchema?.properties || {});
      for (const a of args) {
        assert.ok(declared.includes(a), `${path.basename(f)}: ${tool} has no parameter "${a}"`);
      }
      for (const r of def.inputSchema?.required || []) {
        assert.ok(args.includes(r), `${path.basename(f)}: ${tool} missing required "${r}"`);
      }
    }
  }
  assert.ok(
    seen >= MIN_TOOL_BLOCKS,
    `only ${seen} tool blocks found — the extractor is matching nothing`,
  );
});

// ── Recipes ──────────────────────────────────────────────────────────────────

const SNAPSHOT = loadToolSnapshot();
const OWNERS = loadOwners(SNAPSHOT);
const FENCE = '`'.repeat(3);

/** A step, well formed unless a test says otherwise. */
function step(n, { tool = 'ping', args = [], checkpoint = 'The mode is stated.', branch = true } = {}) {
  const input = args.length ? ['input:', ...args.map((a) => `  ${a}`)] : ['input: {}'];
  return [
    `### ${n}. Step ${n}`,
    '',
    FENCE,
    `tool: ${tool}`,
    ...input,
    FENCE,
    '',
    checkpoint === null ? 'No checkpoint here.' : `**Checkpoint.** ${checkpoint}`,
    ...(branch ? ['', '**If it fails**', '', '| Condition | Do |', '|---|---|', '| Timeout | Read state back. |'] : []),
  ].join('\n');
}

const REFUND = { tool: 'refund_order', args: ['order_id: <step 1: order.id>', 'idempotency_key: <new UUID v4>'] };

/**
 * A recipe that passes every rule, so each test can break exactly one.
 * `verified` is unquoted on purpose: YAML reads it as a Date, and the
 * validator has to accept that.
 */
function recipe({ fm = {}, steps = [step(1)], drop = null, links = '' } = {}) {
  const front = {
    recipe: 'synthetic',
    recipe_version: '1.0.0',
    skills: ['epd-mcp-operator'],
    highest_tier: 'T0',
    unattended: 'runs',
    ...fm,
  };
  const yaml = [
    '---',
    ...Object.entries(front).map(([k, v]) =>
      Array.isArray(v) ? `${k}:\n${v.map((x) => `  - ${x}`).join('\n')}` : `${k}: ${v}`,
    ),
    `api_version: "${MANIFEST.api_version}"`,
    'verified: 2026-09-28',
    '---',
  ].join('\n');
  const body = RECIPE_SECTIONS.filter((s) => s !== drop)
    .map((s) => {
      if (s === 'Steps') return `## Steps\n\n${steps.join('\n\n')}`;
      if (s === 'Outcome') return `## Outcome\n\nSee [the operator](../docs/epd-mcp-operator.md).${links}`;
      return `## ${s}\n\nText.`;
    })
    .join('\n\n');
  return `${yaml}\n\n# Synthetic\n\n${body}\n`;
}

const problemsOf = (src, index = '[x](./synthetic.md)') =>
  recipeProblems({ name: 'synthetic', src, manifest: MANIFEST, snapshot: SNAPSHOT, owners: OWNERS, index });

const has = (problems, re) => assert.ok(problems.some((p) => re.test(p)), `expected ${re} in:\n${problems.join('\n')}`);

test('every recipe on disk passes, and there are six', () => {
  const files = fs.readdirSync(RECIPES_DIR).filter((f) => f.endsWith('.md') && f !== 'README.md');
  assert.equal(files.length, 6, `expected the six SOW recipes, found: ${files.join(', ')}`);
  const index = fs.readFileSync(path.join(RECIPES_DIR, 'README.md'), 'utf8');
  for (const file of files) {
    const src = fs.readFileSync(path.join(RECIPES_DIR, file), 'utf8');
    const name = file.replace(/\.md$/, '');
    assert.deepEqual(
      recipeProblems({ name, src, manifest: MANIFEST, snapshot: SNAPSHOT, owners: OWNERS, index }),
      [],
      `recipes/${file}`,
    );
  }
});

test('ownership reads an owner for every tool out of COVERAGE.md', () => {
  assert.ok(OWNERS, 'loadOwners returned null — the COVERAGE.md table did not parse');
  assert.equal(OWNERS.size, SNAPSHOT.tools.length);
  assert.equal(OWNERS.get('refund_order'), 'epd-refunds');
  assert.equal(OWNERS.get('list_orders'), 'epd-transaction-triage');
  assert.equal(OWNERS.get('retry_failed_charge'), 'epd-subscriptions');
});

test('the recipe tier rule agrees with the generated tiers.md for every tool', () => {
  const tiers = fs.readFileSync(
    path.join(REPO_ROOT, 'workflows', 'epd-mcp-operator', 'references', 'tiers.md'),
    'utf8',
  );
  for (const def of SNAPSHOT.tools) {
    const row = new RegExp(`^\\| \`${def.name}\` \\|[^|]*\\|[^|]*\\| (T\\d)`, 'm').exec(tiers);
    assert.ok(row, `no row for ${def.name} in tiers.md`);
    assert.equal(tierOfTool(def), row[1], def.name);
  }
});

test('a well-formed recipe has no problems — the baseline the next tests break', () => {
  assert.deepEqual(problemsOf(recipe()), []);
  const refunding = recipe({
    fm: { skills: ['epd-mcp-operator', 'epd-refunds'], highest_tier: 'T3', unattended: 'refuses' },
    steps: [step(1), step(2, REFUND)],
    links: ' And [refunds](../docs/epd-refunds.md).',
  });
  assert.deepEqual(problemsOf(refunding), []);
});

test('understating the highest tier is caught, and so is the unattended claim that follows from it', () => {
  const problems = problemsOf(
    recipe({
      fm: { skills: ['epd-mcp-operator', 'epd-refunds'] },
      steps: [step(1), step(2, REFUND)],
      links: ' And [refunds](../docs/epd-refunds.md).',
    }),
  );
  has(problems, /highest_tier "T0" but its tool calls reach T3/);
  has(problems, /unattended "runs", but a chain reaching T3 refuses/);
});

test('a read-only recipe that says it refuses unattended is caught', () => {
  has(problemsOf(recipe({ fm: { unattended: 'refuses' } })), /reaching T0 runs/);
});

test('calling a tool whose owning skill is not in the chain is caught', () => {
  const src = recipe({ fm: { highest_tier: 'T3', unattended: 'refuses' }, steps: [step(1), step(2, REFUND)] });
  has(problemsOf(src), /calls refund_order, which epd-refunds owns/);
});

test('a literal UUID in a tool call is caught', () => {
  const src = recipe({ steps: [step(1, { tool: 'get_customer', args: ['id: 3fa85f64-5717-4562-b3fc-2c963f66afa6'] })] });
  has(problemsOf(src), /literal UUID/);
});

test('an identifier taken from a later step, or a step that does not exist, is caught', () => {
  has(problemsOf(recipe({ steps: [step(1, { checkpoint: 'Reads <step 2: x>.' }), step(2)] })), /from a later step/);
  has(problemsOf(recipe({ steps: [step(1, { checkpoint: 'Reads <step 7: x>.' })] })), /from a step that does not exist/);
});

test('a step with no checkpoint, or a call with no failure branch, is caught', () => {
  has(problemsOf(recipe({ steps: [step(1, { checkpoint: null })] })), /step 1 has no \*\*Checkpoint\*\*/);
  has(problemsOf(recipe({ steps: [step(1, { branch: false })] })), /step 1 calls something but has no \*\*If it fails\*\*/);
});

test('a missing section, a missing index entry, and an unlinked skill are each caught', () => {
  has(problemsOf(recipe({ drop: 'Where it can stop' })), /missing required section "## Where it can stop"/);
  has(problemsOf(recipe(), '[other](./other.md)'), /not linked from recipes\/README.md/);
  has(problemsOf(recipe({ fm: { skills: ['epd-mcp-operator', 'epd-reporting'] } })), /names skill "epd-reporting" but never links to it/);
});

test('steps are read in sequence, and headings inside a fence are not steps', () => {
  const steps = recipeSteps(
    `## Steps\n\n### 1. One\n\n${FENCE}md\n### 2. Not a step\n${FENCE}\n\n### 2. Two\n\n## After\n\n### 3. Not in Steps\n`,
  );
  assert.deepEqual(
    steps.map((s) => `${s.num}. ${s.title}`),
    ['1. One', '2. Two'],
  );
  has(problemsOf(recipe({ steps: [step(1), step(3)] })), /step "3\. Step 3" is out of sequence/);
});
