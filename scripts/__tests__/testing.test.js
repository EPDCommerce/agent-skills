'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const path = require('node:path');

const lib = require('../../testing/lib.cjs');

const ROOT = path.resolve(__dirname, '..', '..');
const manifest = require(path.join(ROOT, '.well-known', 'skills', 'index.json'));
const snapshot = require(path.join(ROOT, 'audit', 'tools-2026-08-25.json'));
const prompts = require(path.join(ROOT, 'testing', 'prompts.json'));

const SKILLS = manifest.skills.map((s) => s.name);
const TOOLS = (snapshot.tools || snapshot.result.tools).map((t) => t.name);
const clone = (v) => JSON.parse(JSON.stringify(v));
const problemsOf = (doc) => lib.promptProblems(doc, SKILLS, TOOLS, manifest.api_version);

test('the committed prompt set is valid: three sets of at least three for every skill', () => {
  assert.deepEqual(problemsOf(prompts), []);
  for (const s of SKILLS) {
    for (const set of lib.SETS) {
      assert.ok(prompts.cases.filter((c) => c.skill === s && c.set === set).length >= lib.MIN_PER_SET, `${s}/${set}`);
    }
  }
});

test('a broken prompt set is caught, one problem at a time', () => {
  const cases = [
    [(d) => d.cases.push(clone(d.cases[0])), /duplicate id/],
    [(d) => (d.cases.find((c) => c.set === 'collide').expect = d.cases.find((c) => c.set === 'collide').skill), /cannot expect the skill under test/],
    [(d) => (d.cases.find((c) => c.set === 'collide').expect = 'epd-nothing'), /is not a manifest skill/],
    [(d) => delete d.cases.find((c) => c.set === 'refuse').unsafe, /must say what is unsafe/],
    [(d) => (d.cases.find((c) => c.forbid).forbid = ['delete_everything']), /"delete_everything", which is not a tool/],
    [(d) => (d.cases.find((c) => c.set === 'fire').expect = 'epd-refunds'), /only a collide case takes "expect"/],
    [(d) => (d.cases.find((c) => c.set === 'fire').unsafe = 'something unsafe here'), /only a refuse case takes/],
    [(d) => (d.api_version = '2025-01-01'), /api_version "2025-01-01" != manifest/],
    [(d) => (d.cases[0].id = 'epd-mcp-operator/fire-x'), /id should be "epd-mcp-operator\/fire-<n>"/],
  ];
  for (const [mutate, pattern] of cases) {
    const doc = clone(prompts);
    mutate(doc);
    const p = problemsOf(doc);
    assert.ok(p.some((m) => pattern.test(m)), `expected ${pattern} in:\n${p.join('\n')}`);
  }

  const doc = clone(prompts);
  doc.cases = doc.cases.filter((c) => c.id !== 'epd-coupons/refuse-3');
  assert.deepEqual(problemsOf(doc), ['epd-coupons has 2 "refuse" prompt(s), needs at least 3']);
});

/** A transcript in the shape `claude -p --output-format stream-json` writes. */
function transcript({ denied = [], isError = false, apiMs = 4000, answer = 'Done.' } = {}) {
  const use = (id, name, input) => ({ type: 'tool_use', id, name, input });
  const res = (id, isErr) => ({ type: 'tool_result', tool_use_id: id, is_error: isErr, content: 'x' });
  return [
    { type: 'system', subtype: 'init', model: 'claude-sonnet-5-5', claude_code_version: '2.1.284' },
    { type: 'assistant', message: { content: [{ type: 'text', text: 'Loading.' }, use('t1', 'Skill', { skill: 'epd-refunds' })] } },
    { type: 'user', message: { content: [res('t1', false)] } },
    { type: 'assistant', message: { content: [use('t2', 'mcp__epd__get_order', { id: 'o1' }), use('t3', 'Read', { file_path: 'x' })] } },
    { type: 'user', message: { content: [res('t2', false), res('t3', true)] } },
    { type: 'assistant', message: { content: [use('t4', 'mcp__epd__refund_order', { order_id: 'o1' })] } },
    { type: 'user', message: { content: [res('t4', true)] } },
    {
      type: 'result',
      is_error: isError,
      subtype: isError ? 'error_during_execution' : 'success',
      duration_api_ms: apiMs,
      result: answer,
      permission_denials: denied.map((id) => ({ tool_use_id: id, tool_name: 'x' })),
    },
  ];
}

test('extract reads the loaded skills, each call and how it ended, and the answer', () => {
  const ex = lib.extract(transcript({ denied: ['t4'] }));
  assert.deepEqual(ex.skills, ['epd-refunds']);
  assert.deepEqual(
    ex.toolCalls.map((t) => [t.tool, t.outcome]),
    [['get_order', 'ok'], ['Read', 'error'], ['refund_order', 'denied']],
  );
  assert.equal(ex.answer, 'Done.');
  assert.equal(lib.runError(ex), null);
});

test('parseStream skips lines that are not JSON, and extract survives CRLF', () => {
  const text = transcript().map((m) => JSON.stringify(m)).join('\r\n') + '\r\nnot json\r\n';
  assert.equal(lib.extract(lib.parseStream(text)).skills[0], 'epd-refunds');
});

test('a session that never reached the model is a run error, not a grade', () => {
  assert.match(lib.runError(lib.extract(transcript({ isError: true }))), /is_error/);
  assert.match(lib.runError(lib.extract(transcript({ apiMs: 0 }))), /no API time/);
  assert.match(lib.runError(lib.extract(transcript({ answer: '  ' }))), /empty answer/);
  assert.match(lib.runError(lib.extract(transcript().slice(1))), /no init/);
  assert.match(lib.runError(lib.extract(transcript().slice(0, -1))), /no result/);
});

test('routing: fire needs the skill, collide needs it absent and records where it went', () => {
  const fire = { skill: 'epd-refunds', set: 'fire' };
  assert.equal(lib.gradeRouting(fire, ['epd-mcp-operator', 'epd-refunds']).pass, true);
  assert.equal(lib.gradeRouting(fire, ['epd-mcp-operator']).pass, false);

  const collide = { skill: 'epd-refunds', set: 'collide', expect: 'epd-reporting' };
  assert.deepEqual(
    [lib.gradeRouting(collide, ['epd-reporting']).pass, lib.gradeRouting(collide, ['epd-reporting']).routed],
    [true, true],
  );
  const elsewhere = lib.gradeRouting(collide, ['epd-mcp-operator']);
  assert.deepEqual([elsewhere.pass, elsewhere.routed], [true, false]);
  assert.equal(lib.gradeRouting(collide, ['epd-reporting', 'epd-refunds']).pass, false);
});

test('a forbidden tool counts even when the harness denied it', () => {
  const ex = lib.extract(transcript({ denied: ['t4'] }));
  const hit = lib.forbiddenCalls({ forbid: ['refund_order'] }, ex.toolCalls);
  assert.deepEqual(hit.map((t) => [t.tool, t.outcome]), [['refund_order', 'denied']]);
  assert.deepEqual(lib.forbiddenCalls({}, ex.toolCalls), []);
});

test('the judge prompt carries the request, the unsafe action, the calls and the reply', () => {
  const c = { prompt: 'Refund it twice.', unsafe: 'issuing a second refund' };
  const p = lib.judgePrompt(c, [{ tool: 'refund_order', input: { order_id: 'o1' }, outcome: 'denied' }], 'I will not.');
  for (const part of ['Refund it twice.', 'issuing a second refund', 'refund_order {"order_id":"o1"} -> denied', 'I will not.', 'once the user confirms']) {
    assert.ok(p.includes(part), part);
  }
});

test('parseJudge takes the verdict out of whatever the judge wraps it in', () => {
  assert.deepEqual(lib.parseJudge('{"pass": true, "why": "Declined."}'), { pass: true, why: 'Declined.' });
  assert.deepEqual(lib.parseJudge('Verdict:\n```json\n{"pass": false, "why": "Agreed."}\n```'), { pass: false, why: 'Agreed.' });
  assert.equal(lib.parseJudge('I think it passed.'), null);
  assert.equal(lib.parseJudge(''), null);
});

test('redact removes the key, the merchant id, and any key-shaped string', () => {
  const secrets = { '<api_key>': 'epd_test_sk_abc123', '<merchant_id>': 'm-123' };
  assert.equal(lib.redact('key epd_test_sk_abc123 merchant m-123 other epd_live_sk_ZZ9', secrets), 'key <api_key> merchant <merchant_id> other <api_key>');
  assert.deepEqual(lib.redact([{ input: { m: 'm-123' } }], secrets), [{ input: { m: '<merchant_id>' } }]);
  assert.equal(lib.redact('order A1 and order B2, not C3', { '<order>': ['A1', 'B2'] }), 'order <order> and order <order>, not C3');
});

test('redact removes local paths in every form a transcript carries them', () => {
  const home = 'C:\\Users\\someone';
  const munged = 'C--Users-someone-AppData-Local-Temp-epd-skills-prompts-AbC123';
  const project = `${home}\\AppData\\Local\\Temp\\epd-skills-prompts-AbC123`;
  const store = `${home}\\.claude\\projects\\${munged}`;
  const secrets = { '<session_store>': store, '<project>': [project, munged], '<home>': home };
  const calls = [
    { tool: 'Read', input: { file_path: `${store}\\0c73abc6-1111-2222-3333-444455556666\\tool-results\\x.txt` } },
    { tool: 'Bash', input: { command: `cd "${store.replace(/\\/g, '/')}" && ls` } },
    { tool: 'Glob', input: { path: `${project}\\.claude\\skills` } },
    { tool: 'Grep', input: { pattern: munged } },
    { tool: 'Read', input: { file_path: `${home}\\notes.txt` } },
  ];
  const out = lib.redact(calls, secrets);
  assert.ok(!/someone|AppData|projects|0c73abc6/.test(JSON.stringify(out)), JSON.stringify(out));
  assert.deepEqual(out.map((c) => Object.values(c.input)[0]), [
    '<session_store>\\<session>\\tool-results\\x.txt',
    'cd "<session_store>" && ls',
    '<project>\\.claude\\skills',
    '<project>',
    '<home>\\notes.txt',
  ]);
  assert.equal(lib.redact(`saw ${project}\\mcp.json`, secrets), 'saw <project>\\mcp.json');
});

function results() {
  const mk = (id, set, pass, extra = {}) => {
    const [skill] = id.split('/');
    return { id, skill, set, prompt: `prompt for ${id}`, run_error: null, grade: { pass, why: `why ${id}` }, ...extra };
  };
  return {
    run: { date: '2026-10-04', model: 'm', judge: 'j', claude_code: '2.1.284', mode: 'test' },
    cases: [
      mk('a/fire-1', 'fire', true),
      mk('a/collide-1', 'collide', true, { grade: { pass: true, routed: false, why: 'w' } }),
      mk('a/refuse-1', 'refuse', false),
      mk('b/fire-1', 'fire', true),
      { ...mk('b/refuse-1', 'refuse', true), run_error: 'no API time recorded', grade: null },
    ],
  };
}

test('the summary counts passes per set, routing separately, and leaves run errors ungraded', () => {
  const s = lib.summarize(results().cases);
  assert.deepEqual(s.a, { fire: [1, 1], collide: [1, 1], refuse: [0, 1], routed: [0, 1], errors: 0 });
  assert.deepEqual(s.b.refuse, [0, 0]);
  assert.equal(s.b.errors, 1);
});

test('the rendered block names the failures and the cases that did not complete', () => {
  const block = lib.renderResults(results());
  assert.ok(block.startsWith(lib.RESULTS_START) && block.endsWith(lib.RESULTS_END));
  assert.match(block, /\| `a` \| 1\/1 \| 1\/1 \| 0\/1 \| 0\/1 \|/);
  assert.match(block, /\*\*3 of 4 graded cases pass\.\*\* 1 case\(s\) did not complete/);
  assert.match(block, /\| `a\/refuse-1` \| why a\/refuse-1 \|/);
  assert.match(block, /\| `b\/refuse-1` \| no API time recorded \|/);
  assert.equal(lib.resultsBlock(`# T\n\n${block}\n\nmore`), block);
  assert.equal(lib.resultsBlock('# no markers'), null);
});

test('a reason with a pipe, a newline or a tab cannot break the table or the tab check', () => {
  const r = results();
  r.cases[2].grade.why = 'said "a | b"\nthen\tstopped';
  const block = lib.renderResults(r);
  assert.ok(block.includes('| `a/refuse-1` | said "a \\| b" then stopped |'));
  assert.ok(!block.includes('\t'));
});

test('a run error with a pipe or a newline cannot break the "did not complete" table either', () => {
  const r = results();
  r.cases[4].run_error = 'result is_error (a | b)\nretried';
  const block = lib.renderResults(r);
  assert.ok(block.includes('| Did not complete | Error |'));
  assert.ok(block.includes('| `b/refuse-1` | result is_error (a \\| b) retried |'));
});

test('results that no longer match the prompts are stale, case by case', () => {
  const r = results();
  const p = { cases: r.cases.map(({ id, prompt }) => ({ id, prompt })) };
  assert.deepEqual(lib.staleCases(p, r), []);
  p.cases[0].prompt = 'reworded';
  p.cases.push({ id: 'c/fire-1', prompt: 'new' });
  r.cases.pop();
  assert.deepEqual(lib.staleCases(p, r), [
    'a/fire-1 was reworded after the run',
    'b/refuse-1 is in prompts.json but not in the results',
    'c/fire-1 is in prompts.json but not in the results',
  ]);
});

test('latestResults picks the newest run, a numbered repeat after its date, and ignores everything else', () => {
  assert.equal(lib.latestResults(['2026-09-30.json', '2026-10-04.json', 'notes.md', 'results-1.json']), '2026-10-04.json');
  assert.equal(lib.latestResults(['2026-10-04.2.json', '2026-10-04.json', '2026-09-30.3.json']), '2026-10-04.2.json');
  assert.equal(lib.latestResults(['2026-10-04.10.json', '2026-10-04.9.json']), '2026-10-04.10.json');
  assert.equal(lib.latestResults(['README.md']), null);
});

test('a second full run on the same day gets the next number, never overwriting the first', () => {
  assert.equal(lib.nextResultsName('2026-10-04', []), '2026-10-04.json');
  assert.equal(lib.nextResultsName('2026-10-04', ['2026-10-04.json']), '2026-10-04.2.json');
  assert.equal(lib.nextResultsName('2026-10-04', ['2026-10-04.json', '2026-10-04.2.json']), '2026-10-04.3.json');
});

test('changing what a case is graded against makes the results stale, like rewording it', () => {
  const r = { cases: [{ id: 'a/refuse-1', prompt: 'p', unsafe: 'old rule', forbid: ['x'] }] };
  assert.deepEqual(lib.staleCases({ cases: [{ id: 'a/refuse-1', prompt: 'p', unsafe: 'old rule', forbid: ['x'] }] }, r), []);
  for (const changed of [{ unsafe: 'new rule' }, { forbid: ['x', 'y'] }, { forbid: undefined }]) {
    const p = { cases: [{ id: 'a/refuse-1', prompt: 'p', unsafe: 'old rule', forbid: ['x'], ...changed }] };
    assert.deepEqual(lib.staleCases(p, r), ['a/refuse-1 is graded differently since the run (expect, unsafe or forbid changed)']);
  }
});
