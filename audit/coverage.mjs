#!/usr/bin/env node
/**
 * Mechanical coverage audit: the 67 live MCP tools against the 6 shipped skills.
 *
 * Usage:  node audit/coverage.mjs
 */

import fs from 'node:fs';
import path from 'node:path';

const ROOT = path.resolve(import.meta.dirname, '..');
const SNAPSHOT = path.join(ROOT, 'audit', 'tools-2026-08-25.json');

const GROUPS = [
  ['Account', 3], ['Customers', 5], ['Payment Methods', 3], ['Products', 7],
  ['Plans', 2], ['Orders', 5], ['Subscriptions', 5], ['Transactions', 2],
  ['Webhook Endpoints', 12], ['Webhook Versions', 3], ['Coupons', 9], ['Composite', 11],
];

const tools = JSON.parse(fs.readFileSync(SNAPSHOT, 'utf8')).tools;
const byName = new Map(tools.map((t) => [t.name, t]));

const groupOf = new Map();
{
  let i = 0;
  for (const [g, n] of GROUPS) for (const t of tools.slice(i, (i += n))) groupOf.set(t.name, g);
}

function tierOf(t) {
  const a = t.annotations;
  if (a.readOnlyHint) return 'T0 read';
  if (a.destructiveHint) return 'T3 destructive';
  if (a.openWorldHint) return 'T2 external';
  return 'T2 write';
}

// ── load skills ──────────────────
function walk(dir, acc = []) {
  for (const e of fs.readdirSync(dir, { withFileTypes: true })) {
    const p = path.join(dir, e.name);
    if (e.isDirectory()) walk(p, acc);
    else if (e.name.endsWith('.md')) acc.push(p);
  }
  return acc;
}

const files = [...walk(path.join(ROOT, 'integration')), ...walk(path.join(ROOT, 'workflows'))];

// Generated inventories are excluded from the coverage scan. references/tiers.md
// lists all 67 tools in a table because that is its job, and counting those rows
// as coverage would report every tool as documented while nothing had been
// written about how to use any of them. An inventory says which tier a tool is
// in; it does not teach the workflow. Marked by the "GENERATED FILE" banner, so
// any future generated reference is skipped automatically.
const generated = [];
const skills = files.flatMap((f) => {
  const rel = path.relative(ROOT, f).split(path.sep).join('/');
  const text = fs.readFileSync(f, 'utf8');
  if (/GENERATED FILE/.test(text.slice(0, 400))) {
    generated.push(rel);
    return [];
  }
  const lines = text.split(/\r?\n/);
  let open = false;
  const inFence = lines.map((l) => {
    if (/^\s*```/.test(l)) {
      open = !open;
      return true; // the fence line itself
    }
    return open;
  });
  return [{ file: rel, skill: rel.split('/').slice(0, 2).join('/'), lines, inFence }];
});

// ── pass 1: forward coverage ────────────────────
const coverage = tools.map((t) => {
  const re = new RegExp(`(?<![A-Za-z0-9_])${t.name}(?![A-Za-z0-9_])`);
  let code = 0, head = 0, table = 0, prose = 0;
  const owners = new Set();
  for (const s of skills) {
    s.lines.forEach((l, i) => {
      if (!re.test(l)) return;
      owners.add(s.skill);
      if (s.inFence[i]) code++;
      else if (/^\s*#{1,6}\s/.test(l)) head++;
      else if (/^\s*\|/.test(l)) table++;
      else prose++;
    });
  }
  const total = code + head + table + prose;
  const depth = total === 0 ? 'absent' : code ? 'documented' : head ? 'heading-only' : table ? 'table-only' : 'prose-only';
  return {
    name: t.name, group: groupOf.get(t.name), tier: tierOf(t),
    depth, total, code, head, table, prose, skills: [...owners],
  };
});

// ── pass 2: reverse check ───────
const VERB = /^(create|list|get|update|delete|refund|cancel|retry|add|remove|replay|test|preview|validate|generate|archive|unarchive|rotate|upgrade|downgrade|process|setup|compare|retrieve|reorder|void|capture|attach|detach)_/;
const ghosts = new Map();
for (const s of skills) {
  s.lines.forEach((l) => {
    for (const m of l.matchAll(/`([a-z][a-z0-9_]{3,})`/g)) {
      const n = m[1];
      if (!n.includes('_') || byName.has(n) || !VERB.test(n)) continue;
      if (!ghosts.has(n)) ghosts.set(n, new Set());
      ghosts.get(n).add(s.file);
    }
  });
}

// ── pass 3: argument validation ───────────────────────────────────────────────

const argIssues = [];
const examples = [];
for (const s of skills) {
  for (let i = 0; i < s.lines.length; i++) {
    const m = s.lines[i].match(/^\s*tool:\s*([a-z][a-z0-9_]*)\s*$/);
    if (!m || !s.inFence[i]) continue;
    const name = m[1];
    const ex = { skill: s.skill, file: s.file, line: i + 1, tool: name, keys: [] };

    let j = i + 1;
    while (j < s.lines.length && !/^\s*input:\s*$/.test(s.lines[j])) {
      if (/^\s*```/.test(s.lines[j]) || /^\s*tool:/.test(s.lines[j])) break;
      j++;
    }
    if (j < s.lines.length && /^\s*input:\s*$/.test(s.lines[j])) {
      const base = s.lines[j].match(/^(\s*)/)[1].length;
      let indent = null;
      for (let k = j + 1; k < s.lines.length; k++) {
        const line = s.lines[k];
        if (/^\s*```/.test(line)) break;
        if (!line.trim() || /^\s*#/.test(line.trim())) continue;
        const ind = line.match(/^(\s*)/)[1].length;
        if (ind <= base) break;
        if (indent === null) indent = ind;
        if (ind !== indent) continue; // nested — belongs to a parent key
        const km = line.match(/^\s*([A-Za-z_][A-Za-z0-9_]*)\s*:/);
        if (km) ex.keys.push(km[1]);
      }
    }
    examples.push(ex);

    const t = byName.get(name);
    if (!t) {
      argIssues.push({ ...ex, kind: 'UNKNOWN TOOL', detail: name });
      continue;
    }
    const props = Object.keys(t.inputSchema.properties ?? {});
    const required = t.inputSchema.required ?? [];
    const unknown = ex.keys.filter((k) => !props.includes(k));
    const missing = required.filter((r) => !ex.keys.includes(r));
    if (unknown.length) argIssues.push({ ...ex, kind: 'UNKNOWN ARG', detail: unknown.join(', ') });
    if (missing.length) argIssues.push({ ...ex, kind: 'MISSING REQUIRED', detail: missing.join(', ') });
  }
}

// ── report ────────────────────────────────
const pad = (s, n) => String(s).padEnd(n);
const count = (d) => coverage.filter((c) => c.depth === d).length;

if (generated.length) {
  console.log(`excluded ${generated.length} generated inventory file(s): ${generated.join(', ')}\n`);
}

console.log('=== 1. FORWARD COVERAGE ===\n');
for (const d of ['documented', 'heading-only', 'table-only', 'prose-only', 'absent']) {
  console.log(pad(d, 16) + String(count(d)).padStart(3));
}
console.log(pad('TOTAL', 16) + String(coverage.length).padStart(3));

console.log('\n=== 2. COVERAGE BY GROUP ===\n');
console.log(pad('GROUP', 20) + pad('TOOLS', 7) + pad('DOCUMENTED', 12) + pad('WEAK', 7) + 'ABSENT');
console.log('-'.repeat(52));
for (const [g] of GROUPS) {
  const rows = coverage.filter((c) => c.group === g);
  const doc = rows.filter((c) => c.depth === 'documented').length;
  const abs = rows.filter((c) => c.depth === 'absent').length;
  console.log(pad(g, 20) + pad(rows.length, 7) + pad(doc, 12) + pad(rows.length - doc - abs, 7) + abs);
}

console.log('\n=== 3. COVERAGE BY TIER (write tools matter most) ===\n');
for (const tier of ['T0 read', 'T2 write', 'T2 external', 'T3 destructive']) {
  const rows = coverage.filter((c) => c.tier === tier);
  const doc = rows.filter((c) => c.depth === 'documented').length;
  console.log(pad(tier, 18) + pad(`${doc}/${rows.length} documented`, 22) +
    'absent: ' + rows.filter((c) => c.depth === 'absent').map((c) => c.name).join(', '));
}

console.log('\n=== 4. WHAT EACH SKILL CLAIMS ===\n');
const perSkill = {};
for (const c of coverage) for (const s of c.skills) (perSkill[s] ??= []).push(c);
for (const [s, rows] of Object.entries(perSkill).sort()) {
  const doc = rows.filter((c) => c.depth === 'documented').length;
  console.log(`${pad(s, 34)} ${rows.length} tools referenced, ${doc} documented`);
}

console.log('\n=== 5. REVERSE CHECK: names in skills, not on server ===\n');
if (!ghosts.size) console.log('  none');
for (const [n, fs_] of [...ghosts].sort()) console.log('  ' + pad(n, 26) + [...fs_].join(', '));

console.log(`\n=== 6. ARGUMENT VALIDATION (${examples.length} tool: blocks parsed) ===\n`);
if (!argIssues.length) console.log('  no issues — every documented argument exists and every required field is present');
for (const a of argIssues) {
  console.log(`  ${pad(a.kind, 18)} ${pad(a.tool, 30)} ${a.detail}`);
  console.log(`  ${' '.repeat(18)} ${a.file}:${a.line}`);
}

fs.writeFileSync(
  path.join(ROOT, 'audit', 'coverage.json'),
  JSON.stringify({ captured_at: new Date().toISOString(), coverage, examples, argIssues, ghosts: Object.fromEntries([...ghosts].map(([k, v]) => [k, [...v]])) }, null, 2) + '\n',
);
console.log('\nwrote audit/coverage.json');
