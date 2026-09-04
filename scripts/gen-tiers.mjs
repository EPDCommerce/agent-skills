#!/usr/bin/env node
/**
 * Generate workflows/epd-mcp-operator/references/tiers.md from the committed
 * tools/list snapshot.
 *
 * The safety tiers in SAFETY.md are derived from the annotation hints the MCP
 * server declares on every tool, not assigned by hand. Generating the per-tool
 * table keeps that claim true: the file cannot drift from the server, and after
 * an API release it is regenerated rather than re-audited.
 *
 * Reads the newest audit/tools-YYYY-MM-DD.json. Refresh that snapshot with:
 *
 *   curl -sS -X POST https://api.epd.com/mcp \
 *     -H "Authorization: Bearer $EPD_TEST_KEY" \
 *     -H "epd-version: 2026-02-11" \
 *     -H "Content-Type: application/json" \
 *     -H "Accept: application/json, text/event-stream" \
 *     -d '{"jsonrpc":"2.0","id":1,"method":"tools/list"}'
 *
 * Usage:  node scripts/gen-tiers.mjs
 */

import fs from 'node:fs';
import path from 'node:path';

const ROOT = path.resolve(import.meta.dirname, '..');
const OUT = path.join(ROOT, 'workflows', 'epd-mcp-operator', 'references', 'tiers.md');

// Group boundaries follow the server's own tools/list return order, which is
// contiguous by domain and matches the counts published in the MCP overview.
const GROUPS = [
  ['Account', 3], ['Customers', 5], ['Payment Methods', 3], ['Products', 7],
  ['Plans', 2], ['Orders', 5], ['Subscriptions', 5], ['Transactions', 2],
  ['Webhook Endpoints', 12], ['Webhook Versions', 3], ['Coupons', 9], ['Composite', 11],
];

function loadSnapshot() {
  const dir = path.join(ROOT, 'audit');
  if (!fs.existsSync(dir)) {
    throw new Error(
      'audit/ not found. The tools snapshot lives there; if this branch predates ' +
        'the Phase A merge, rebase onto main first.',
    );
  }
  const files = fs
    .readdirSync(dir)
    .filter((f) => /^tools-\d{4}-\d{2}-\d{2}\.json$/.test(f))
    .sort();
  if (!files.length) throw new Error('no audit/tools-YYYY-MM-DD.json snapshot found');
  const file = files[files.length - 1];
  const parsed = JSON.parse(fs.readFileSync(path.join(dir, file), 'utf8'));
  return { file, tools: parsed.tools, captured: parsed._snapshot?.captured_at ?? null };
}

/**
 * Tier is a pure function of the annotations. Order matters: readOnly wins over
 * everything, then destructive, then the external-call case, and any remaining
 * write is an ordinary confirm-first write.
 */
function tierOf(a) {
  if (a.readOnlyHint) return { id: 'T0', label: 'T0 read' };
  if (a.destructiveHint) return { id: 'T3', label: 'T3 destructive' };
  if (a.openWorldHint) return { id: 'T2', label: 'T2 external' };
  return { id: 'T2', label: 'T2 write' };
}

function hintsOf(a) {
  return (
    [
      a.readOnlyHint ? 'readOnly' : null,
      a.destructiveHint ? 'destructive' : null,
      a.idempotentHint ? 'idempotent' : null,
      a.openWorldHint ? 'openWorld' : null,
    ]
      .filter(Boolean)
      .join(', ') || '—'
  );
}

function idemOf(t) {
  if (!t.inputSchema?.properties?.idempotency_key) return 'none';
  return (t.inputSchema.required ?? []).includes('idempotency_key') ? 'required' : 'optional';
}

const { file, tools, captured } = loadSnapshot();

const groupOf = new Map();
{
  let i = 0;
  for (const [g, n] of GROUPS) for (const t of tools.slice(i, (i += n))) groupOf.set(t.name, g);
}

const rows = tools.map((t) => ({
  name: t.name,
  group: groupOf.get(t.name) ?? '—',
  hints: hintsOf(t.annotations),
  tier: tierOf(t.annotations),
  idem: idemOf(t),
  idempotent: t.annotations.idempotentHint === true,
}));

const count = (label) => rows.filter((r) => r.tier.label === label).length;
const writesNoIdem = rows.filter((r) => r.tier.id !== 'T0' && r.idem === 'none');

// Destructive tools divide cleanly by whether a retry can double-spend. The
// server encodes this: money movement makes the idempotency key required,
// deletes and cancels leave it optional because they are naturally idempotent.
const destructive = rows.filter((r) => r.tier.id === 'T3');
const dReq = destructive.filter((r) => r.idem === 'required');
const dOpt = destructive.filter((r) => r.idem === 'optional');

const out = [];
const p = (s = '') => out.push(s);

p('# Safety tiers — every tool, with the annotations behind them');
p();
p('<!-- GENERATED FILE — do not edit by hand.');
p(`     Produced by scripts/gen-tiers.mjs from audit/${file}.`);
p('     Regenerate after any API release:  node scripts/gen-tiers.mjs -->');
p();
p('Tiers are not assigned by hand. Every EPD MCP tool declares four annotation');
p('hints, and the tier is a pure function of them:');
p();
p('| Annotation | Tier | What the agent must do |');
p('|---|---|---|');
p('| `readOnlyHint` | **T0** | Nothing. Read freely, no confirmation. |');
p('| `destructiveHint` | **T3** | Print the plan, echo amount, currency, object id and key mode, wait for an explicit yes. |');
p('| `openWorldHint` | **T2** | Calls an external URL. Confirm first; not idempotent. |');
p('| none of the above | **T2** | An ordinary write. Print the plan and confirm. |');
p();
p('`SAFETY.md` defines what each tier requires. This file only says which tool');
p('sits in which tier, and shows the raw hints so the mapping can be checked');
p('rather than taken on trust.');
p();
p('### `idempotentHint` does not set the tier');
p();
p('The fourth annotation is orthogonal to the other three. It does not decide how');
p('much confirmation a call needs — it decides whether repeating the call is safe,');
p('which is a different question and only matters after something has already gone');
p('wrong.');
p();
const nonIdem = rows.filter((r) => !r.idempotent);
p(`${rows.length - nonIdem.length} of the ${rows.length} tools declare it. The exceptions are:`);
p();
for (const r of nonIdem) p(`- \`${r.name}\` — ${r.tier.label}, and has no \`idempotency_key\` parameter either`);
p();
p('Those two send traffic to an external URL, so a repeat is a real second');
p('delivery rather than a deduplicated no-op. Treat the absence of the hint as the');
p('signal that a retry is a fresh side effect.');
p();
p('## Counts');
p();
p('| Tier | Tools |');
p('|---|---|');
for (const label of ['T0 read', 'T2 write', 'T2 external', 'T3 destructive']) {
  p(`| ${label} | ${count(label)} |`);
}
p(`| **Total** | **${rows.length}** |`);
p();

p('## Destructive tools, split by retry risk');
p();
p('Not every T3 is dangerous in the same way, and the schema says which is which.');
p('Of the destructive tools, the ones that **require** an idempotency key are');
p('exactly the ones that move money; the ones where it is **optional** are');
p('deletes, cancels and archives, which are naturally idempotent — deleting twice');
p('leaves the same state, charging twice does not.');
p();
p('Both still need T3 confirmation. The difference is what happens after a');
p('timeout with no response: for the money-movers, retry with the same key and');
p('let the server deduplicate. For the rest, read current state back first.');
p();
p(`**Money movement — key required (${dReq.length}):**`);
p();
for (const r of dReq) p(`- \`${r.name}\``);
p();
p(`**State removal — key optional (${dOpt.length}):**`);
p();
for (const r of dOpt) p(`- \`${r.name}\``);
p();

p('## Writes with no `idempotency_key` parameter');
p();
p('The rule is an idempotency key on every write. These tools have no such');
p('parameter at all, so the rule cannot be applied and a retry is genuinely');
p('unsafe. Confirm before the first attempt and do not blind-retry on timeout —');
p('read current state back instead.');
p();
for (const r of writesNoIdem) p(`- \`${r.name}\` — ${r.tier.label}`);
p();

p('## Every tool');
p();
p('| Tool | Group | Annotations (from server) | Tier | `idempotency_key` |');
p('|---|---|---|---|---|');
for (const r of rows) {
  p(`| \`${r.name}\` | ${r.group} | ${r.hints} | ${r.tier.label} | ${r.idem} |`);
}
p();

fs.writeFileSync(OUT, out.join('\n'));

console.log(`wrote ${path.relative(ROOT, OUT)}`);
console.log(`  source: audit/${file}${captured ? ` (captured ${captured})` : ''}`);
console.log(`  ${rows.length} tools — T0 ${count('T0 read')}, T2 write ${count('T2 write')}, T2 external ${count('T2 external')}, T3 ${count('T3 destructive')}`);
console.log(`  writes with no idempotency_key: ${writesNoIdem.length} (${writesNoIdem.map((r) => r.name).join(', ')})`);
