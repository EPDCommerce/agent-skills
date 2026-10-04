#!/usr/bin/env node
/**
 * Run the TESTING.md prompt sets against the EPD sandbox.
 *
 * Each case is one headless Claude Code session (`claude -p`) in a scratch
 * project that holds the twelve skills and nothing else of this repository,
 * connected to the EPD MCP server with a test key. The session may load skills
 * and read their files, and may call every read-only MCP tool. Every write is
 * denied by the permission mode, so a run changes nothing in the sandbox, and a
 * refusal case can still see an attempted write: a denial is recorded as one.
 *
 * Grading:
 *   fire     passes if the skill under test loaded.
 *   collide  passes if it did not; whether the expected skill loaded instead
 *            is recorded as `routed`.
 *   refuse   fails if the agent called a tool the case forbids, whatever the
 *            outcome; otherwise a second model judges the reply against the
 *            case's `unsafe` description.
 * A session that never reached the model is retried, then reported as a run
 * error rather than graded.
 *
 * Usage:
 *   node testing/run.mjs                      every case; writes testing/results/<date>.json
 *                                             (<date>.2.json for a second run that day)
 *   node testing/run.mjs --only epd-refunds --only epd-coupons/refuse-2
 *                                             a subset; prints, writes nothing to results/
 *   node testing/run.mjs --render             rewrite TESTING.md's results block from the newest results file
 *   options: --concurrency 4  --model sonnet  --judge haiku
 *
 * Needs the `claude` CLI on PATH (or CLAUDE_BIN), and EPD_TEST_KEY in the
 * environment or in .env. Refuses to start unless the key is a test key and
 * `ping` reports a sandbox.
 */

import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import crypto from 'node:crypto';
import { spawn } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import lib from './lib.cjs';

const HERE = path.dirname(fileURLToPath(import.meta.url));
const ROOT = path.resolve(HERE, '..');
const MCP_URL = 'https://api.epd.com/mcp';
const CASE_TIMEOUT_MS = 6 * 60 * 1000;
const JUDGE_TIMEOUT_MS = 2 * 60 * 1000;
const RETRY_WAIT_MS = [20_000, 60_000];
const CLAUDE = process.env.CLAUDE_BIN || 'claude';

const args = process.argv.slice(2);
const opt = (name, dflt) => {
  const i = args.indexOf(`--${name}`);
  return i >= 0 ? args[i + 1] : dflt;
};
const only = args.flatMap((a, i) => (args[i - 1] === '--only' ? [a] : []));
const CONCURRENCY = Number(opt('concurrency', 4));
const MODEL = opt('model', 'sonnet');
const JUDGE = opt('judge', 'haiku');

const readJson = (p) => JSON.parse(fs.readFileSync(p, 'utf8'));
const manifest = readJson(path.join(ROOT, '.well-known', 'skills', 'index.json'));
const RESULTS_DIR = path.join(HERE, 'results');
const TESTING_MD = path.join(ROOT, 'TESTING.md');

if (args.includes('--render')) {
  render();
  process.exit(0);
}

function render() {
  const latest = lib.latestResults(fs.existsSync(RESULTS_DIR) ? fs.readdirSync(RESULTS_DIR) : []);
  if (!latest) throw new Error('no results file in testing/results/');
  const block = lib.renderResults(readJson(path.join(RESULTS_DIR, latest)));
  const md = fs.readFileSync(TESTING_MD, 'utf8').replace(/\r\n/g, '\n');
  const current = lib.resultsBlock(md);
  if (!current) throw new Error('TESTING.md has no results markers');
  fs.writeFileSync(TESTING_MD, md.replace(current, block));
  console.log(`TESTING.md results block rewritten from testing/results/${latest}`);
}

// ── preflight ────────────────────────────────────────────────────────────────

function loadKey() {
  if (process.env.EPD_TEST_KEY) return process.env.EPD_TEST_KEY;
  const envFile = path.join(ROOT, '.env');
  if (!fs.existsSync(envFile)) return null;
  const line = fs
    .readFileSync(envFile, 'utf8')
    .split(/\r?\n/)
    .find((l) => /^\s*EPD_TEST_KEY\s*=/.test(l));
  return line ? line.split('=').slice(1).join('=').trim().replace(/^["']|["']$/g, '') : null;
}

const KEY = loadKey();
if (!KEY || !KEY.startsWith('epd_test_sk_')) {
  console.error('Refusing to run: EPD_TEST_KEY is missing or is not a test key (epd_test_sk_…).');
  process.exit(1);
}

async function ping() {
  const res = await fetch(MCP_URL, {
    method: 'POST',
    headers: {
      authorization: `Bearer ${KEY}`,
      'epd-version': manifest.api_version,
      'content-type': 'application/json',
      accept: 'application/json, text/event-stream',
    },
    body: JSON.stringify({ jsonrpc: '2.0', id: 1, method: 'tools/call', params: { name: 'ping', arguments: {} } }),
  });
  const body = await res.text();
  const raw = body.split(/\r?\n/).filter((l) => l.startsWith('data: ')).map((l) => l.slice(6)).join('') || body;
  return JSON.parse(JSON.parse(raw).result.content[0].text);
}

const account = await ping();
if (account.environment !== 'test' || account.is_sandbox !== true) {
  console.error(`Refusing to run: ping reports environment ${account.environment}, is_sandbox ${account.is_sandbox}.`);
  process.exit(1);
}
const SECRETS = { '<api_key>': KEY, '<merchant_id>': account.merchant_id };

// ── the scratch project ──────────────────────────────────────────────────────

const snapshotName = fs.readdirSync(path.join(ROOT, 'audit')).filter((f) => /^tools-\d{4}-\d{2}-\d{2}\.json$/.test(f)).sort().pop();
const snapshot = readJson(path.join(ROOT, 'audit', snapshotName));
const tools = snapshot.tools || snapshot.result.tools;
const READ_ONLY = tools.filter((t) => t.annotations && t.annotations.readOnlyHint).map((t) => lib.MCP_PREFIX + t.name);

const PROJECT = fs.mkdtempSync(path.join(os.tmpdir(), 'epd-skills-prompts-'));
const JUDGE_DIR = fs.mkdtempSync(path.join(os.tmpdir(), 'epd-skills-judge-'));
const skillVersions = {};
for (const s of manifest.skills) {
  const skillMd = s.files.find((f) => f.endsWith('SKILL.md'));
  fs.cpSync(path.join(ROOT, path.dirname(skillMd)), path.join(PROJECT, '.claude', 'skills', s.name), { recursive: true });
  skillVersions[s.name] = /^\s+version:\s*(\S+)/m.exec(fs.readFileSync(path.join(ROOT, skillMd), 'utf8'))[1];
}
const MCP_CONFIG = path.join(PROJECT, 'mcp.json');
fs.writeFileSync(
  MCP_CONFIG,
  JSON.stringify(
    {
      mcpServers: {
        epd: {
          type: 'http',
          url: MCP_URL,
          headers: { Authorization: 'Bearer ${EPD_TEST_KEY}', 'epd-version': manifest.api_version },
        },
      },
    },
    null,
    2,
  ),
);

// ── running one session ──────────────────────────────────────────────────────

function claude(argv, cwd, timeoutMs) {
  return new Promise((resolve) => {
    const child = spawn(CLAUDE, argv, {
      cwd,
      env: { ...process.env, EPD_TEST_KEY: KEY },
      stdio: ['ignore', 'pipe', 'pipe'],
      windowsHide: true,
    });
    let stdout = '';
    let stderr = '';
    child.stdout.on('data', (d) => (stdout += d));
    child.stderr.on('data', (d) => (stderr += d));
    const timer = setTimeout(() => child.kill(), timeoutMs);
    child.on('error', (e) => {
      clearTimeout(timer);
      resolve({ stdout, stderr: stderr + String(e), code: -1 });
    });
    child.on('close', (code) => {
      clearTimeout(timer);
      resolve({ stdout, stderr, code });
    });
  });
}

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

async function session(c, rawFile) {
  const argv = [
    '-p', c.prompt,
    '--output-format', 'stream-json', '--verbose',
    '--model', MODEL,
    '--setting-sources', 'project',
    '--strict-mcp-config', '--mcp-config', MCP_CONFIG,
    '--permission-mode', 'dontAsk',
    '--tools', 'Skill,Read,Glob,Grep',
    '--allowedTools', ['Skill', 'Read', 'Glob', 'Grep', ...READ_ONLY].join(','),
    '--no-session-persistence',
  ];
  let attempt = 0;
  for (;;) {
    attempt++;
    const r = await claude(argv, PROJECT, CASE_TIMEOUT_MS);
    fs.writeFileSync(rawFile, r.stdout);
    const ex = lib.extract(lib.parseStream(r.stdout));
    const err = lib.runError(ex);
    if (!err || attempt > RETRY_WAIT_MS.length) return { ex, err: err && `${err}${r.stderr ? `; ${r.stderr.trim().slice(0, 200)}` : ''}`, attempt };
    await sleep(RETRY_WAIT_MS[attempt - 1]);
  }
}

async function judge(c, ex) {
  const prompt = lib.judgePrompt(c, ex.toolCalls, lib.redact(ex.answer, SECRETS));
  const argv = [
    '-p', prompt,
    '--output-format', 'json',
    '--model', JUDGE,
    '--setting-sources', 'project',
    '--strict-mcp-config',
    '--tools', '',
    '--no-session-persistence',
  ];
  for (let attempt = 1; attempt <= 3; attempt++) {
    const r = await claude(argv, JUDGE_DIR, JUDGE_TIMEOUT_MS);
    let out = null;
    try {
      out = JSON.parse(r.stdout);
    } catch {
      // fall through to retry
    }
    const verdict = out && !out.is_error ? lib.parseJudge(out.result) : null;
    if (verdict) return { ...verdict, model: Object.keys(out.modelUsage || {})[0] || JUDGE };
    await sleep(RETRY_WAIT_MS[0]);
  }
  return null;
}

async function runCase(c, rawDir) {
  const rawFile = path.join(rawDir, `${c.id.replace('/', '__')}.jsonl`);
  const { ex, err, attempt } = await session(c, rawFile);
  const r = ex.result || {};
  const record = {
    id: c.id,
    skill: c.skill,
    set: c.set,
    prompt: c.prompt,
    ...(c.expect ? { expect: c.expect } : {}),
    ...(c.unsafe ? { unsafe: c.unsafe } : {}),
    ...(c.forbid ? { forbid: c.forbid } : {}),
    skills: ex.skills,
    tool_calls: lib.redact(ex.toolCalls, SECRETS),
    answer: lib.redact(ex.answer, SECRETS),
    turns: r.num_turns ?? null,
    cost_usd: r.total_cost_usd ?? null,
    duration_ms: r.duration_ms ?? null,
    attempts: attempt,
    model: (ex.init && ex.init.model) || null,
    claude_code: (ex.init && ex.init.claude_code_version) || null,
    run_error: err || null,
    grade: null,
  };
  if (err) return record;

  if (c.set !== 'refuse') {
    record.grade = { ...lib.gradeRouting(c, ex.skills), by: 'routing' };
    return record;
  }
  const forbidden = lib.forbiddenCalls(c, ex.toolCalls);
  if (forbidden.length) {
    const list = forbidden.map((t) => `${t.tool} (${t.outcome})`).join(', ');
    record.grade = { pass: false, why: `called a forbidden tool: ${list}`, by: 'forbid' };
    return record;
  }
  const verdict = await judge(c, ex);
  if (!verdict) {
    record.run_error = 'the judge gave no readable verdict in three attempts';
    return record;
  }
  record.judge_model = verdict.model;
  record.grade = { pass: verdict.pass, why: verdict.why, by: 'judge' };
  return record;
}

// ── the run ──────────────────────────────────────────────────────────────────

const prompts = readJson(path.join(HERE, 'prompts.json'));
const problems = lib.promptProblems(prompts, manifest.skills.map((s) => s.name), tools.map((t) => t.name), manifest.api_version);
if (problems.length) {
  console.error(`testing/prompts.json is invalid:\n  ${problems.join('\n  ')}`);
  process.exit(1);
}
const cases = only.length
  ? prompts.cases.filter((c) => only.some((o) => c.id === o || c.skill === o))
  : prompts.cases;
if (!cases.length) {
  console.error(`--only matched no case: ${only.join(', ')}`);
  process.exit(1);
}

const date = new Date().toISOString().slice(0, 10);
const rawDir = path.join(HERE, 'raw', only.length ? `${date}-partial` : date);
fs.mkdirSync(rawDir, { recursive: true });
console.log(
  `${cases.length} case(s) · agent ${MODEL} · judge ${JUDGE} · ${CONCURRENCY} at a time · ` +
    `sandbox ${account.environment}/${account.is_sandbox} · ${READ_ONLY.length} read-only tools allowed\n` +
    `raw transcripts in ${path.relative(ROOT, rawDir)}`,
);

const records = new Array(cases.length);
let next = 0;
async function worker() {
  while (next < cases.length) {
    const i = next++;
    const rec = await runCase(cases[i], rawDir);
    records[i] = rec;
    const tag = rec.run_error ? 'ERROR' : rec.grade.pass ? 'PASS ' : 'FAIL ';
    console.log(`${tag} ${rec.id.padEnd(34)} ${rec.run_error || rec.grade.why}`);
  }
}
await Promise.all(Array.from({ length: Math.min(CONCURRENCY, cases.length) }, worker));

const first = records.find((r) => r.model) || {};
const judged = records.find((r) => r.judge_model) || {};
const results = {
  run: {
    date,
    model: first.model || MODEL,
    judge: judged.judge_model || JUDGE,
    claude_code: first.claude_code || 'unknown',
    mode: account.environment,
    api_version: manifest.api_version,
    snapshot: snapshotName,
    prompts_sha256: crypto.createHash('sha256').update(fs.readFileSync(path.join(HERE, 'prompts.json'))).digest('hex'),
    skills: skillVersions,
    cases: records.length,
    cost_usd: Number(records.reduce((n, r) => n + (r.cost_usd || 0), 0).toFixed(4)),
  },
  summary: lib.summarize(records),
  cases: records,
};

const graded = records.filter((r) => !r.run_error);
const passed = graded.filter((r) => r.grade.pass).length;
console.log(`\n${passed}/${graded.length} graded cases passed; ${records.length - graded.length} run error(s); agent cost $${results.run.cost_usd}`);

if (only.length) {
  const out = path.join(rawDir, `results-${Date.now()}.json`);
  fs.writeFileSync(out, JSON.stringify(results, null, 2) + '\n');
  console.log(`partial run — written to ${path.relative(ROOT, out)}, not to testing/results/`);
} else {
  fs.mkdirSync(RESULTS_DIR, { recursive: true });
  const out = path.join(RESULTS_DIR, lib.nextResultsName(date, fs.readdirSync(RESULTS_DIR)));
  fs.writeFileSync(out, JSON.stringify(results, null, 2) + '\n');
  console.log(`written to ${path.relative(ROOT, out)}; run with --render to update TESTING.md`);
}

fs.rmSync(PROJECT, { recursive: true, force: true });
fs.rmSync(JUDGE_DIR, { recursive: true, force: true });
