#!/usr/bin/env node
/**
 * Phase A skill map — generates audit/COVERAGE.md.
 *
 *
 * Usage:  node audit/matrix.mjs
 */

import fs from 'node:fs';
import path from 'node:path';

const ROOT = path.resolve(import.meta.dirname, '..');
const tools = JSON.parse(fs.readFileSync(path.join(ROOT, 'audit', 'tools-2026-08-25.json'), 'utf8')).tools;
const cov = JSON.parse(fs.readFileSync(path.join(ROOT, 'audit', 'coverage.json'), 'utf8'));
const covByName = new Map(cov.coverage.map((c) => [c.name, c]));

// ── proposed ownership ────────────────────────────────────────────────────────
// 12 skills: the 6 that ship today plus the 6 from the SOW. Every tool gets
// exactly one owner, so no two skills can both claim to be the place a reader looks — that is what keeps trigger descriptions from colliding.
const OWNER = {
  'epd-mcp-operator': ['ping', 'get_account', 'upgrade_account_api_version'],
  'epd-onboard-customer': [
    'create_customer', 'list_customers', 'get_customer', 'update_customer', 'delete_customer',
    'list_payment_methods', 'add_payment_method', 'delete_payment_method',
    'create_customer_and_charge', 'create_customer_and_subscribe',
  ],
  'epd-catalog': [
    'create_product', 'list_products', 'get_product', 'update_product', 'delete_product',
    'delete_product_image', 'reorder_product_images', 'list_plans', 'get_plan',
    'create_order', 'process_order',
  ],
  'epd-transaction-triage': ['list_orders', 'get_order', 'retry_order', 'list_transactions', 'get_transaction'],
  'epd-refunds': ['refund_order', 'refund_transaction', 'refund_and_cancel'],
  'epd-subscriptions': [
    'create_subscription', 'list_subscriptions', 'get_subscription', 'update_subscription',
    'cancel_subscription', 'cancel_subscription_and_report', 'list_past_due_subscriptions',
    'retry_failed_charge',
  ],
  'epd-webhook-ops': [
    'create_webhook_endpoint', 'list_webhook_endpoints', 'get_webhook_endpoint',
    'update_webhook_endpoint', 'delete_webhook_endpoint', 'rotate_webhook_secret',
    'test_webhook_endpoint', 'upgrade_webhook_version', 'downgrade_webhook_version',
    'replay_webhook_event', 'list_webhook_events', 'list_webhook_delivery_logs',
    'list_webhook_versions', 'preview_webhook_payload', 'compare_webhook_versions',
    'setup_webhook_monitoring',
  ],
  'epd-coupons': [
    'create_coupon', 'list_coupons', 'retrieve_coupon', 'update_coupon', 'archive_coupon',
    'unarchive_coupon', 'generate_coupon_codes', 'list_coupon_codes', 'validate_coupon',
  ],
  'epd-reporting': ['get_customer_financial_summary', 'get_revenue_summary'],
};

const ownerOf = new Map();
for (const [skill, list] of Object.entries(OWNER)) for (const t of list) ownerOf.set(t, skill);

// Read tools that carry real interpretation earn a transcript despite being T0.
const READ_NEEDS_EXAMPLE = new Set([
  'get_revenue_summary', 'get_customer_financial_summary', 'list_past_due_subscriptions',
  'validate_coupon', 'compare_webhook_versions', 'preview_webhook_payload',
  'list_webhook_delivery_logs', 'list_transactions', 'get_transaction',
]);

const MENTION_ONLY = {
  ping: 'Liveness check with no workflow around it. One line in epd-mcp-operator as the connection test; a dedicated section would be padding.',
};

const NOTES = {
  add_payment_method: 'BLOCKED ON CLIENT — MCP takes card_token (^cct_[0-9a-f]{48}$) only; billing_id is REST-only. Awaiting sandbox token path.',
  create_customer_and_charge: 'BLOCKED ON CLIENT — same card_token question. Current example in epd-onboard-customer fails schema validation.',
  create_customer_and_subscribe: 'BLOCKED ON CLIENT — same card_token question. Current example fails schema validation.',
  upgrade_account_api_version: 'Destructive and account-wide. Sandbox account currently has api_version=null (floating on latest), so the Aug 31 release lands automatically.',
  rotate_webhook_secret: 'Needs the overlap-window procedure written before the rotate call, not after.',
  archive_coupon: 'Archive vs delete distinction must be explicit — unarchive_coupon exists, so archive is reversible and should not be described as deletion.',
  retry_order: 'Absent from the published docs entirely. Destructive + retries money movement, so it needs the soft/hard decline split from epd-transaction-triage.',
  test_webhook_endpoint: 'openWorldHint — calls an external URL. No idempotency_key parameter exists.',
  replay_webhook_event: 'openWorldHint — calls an external URL. No idempotency_key parameter exists.',
  reorder_product_images: 'Write tool with no idempotency_key parameter — the "idempotency_key on every write" rule needs a stated exception here.',
  upgrade_webhook_version: 'Write tool with no idempotency_key parameter. Run preview_webhook_payload and compare_webhook_versions first.',
  downgrade_webhook_version: 'Write tool with no idempotency_key parameter.',
};

const GROUPS = [
  ['Account', 3], ['Customers', 5], ['Payment Methods', 3], ['Products', 7],
  ['Plans', 2], ['Orders', 5], ['Subscriptions', 5], ['Transactions', 2],
  ['Webhook Endpoints', 12], ['Webhook Versions', 3], ['Coupons', 9], ['Composite', 11],
];
const groupOf = new Map();
{
  let i = 0;
  for (const [g, n] of GROUPS) for (const t of tools.slice(i, (i += n))) groupOf.set(t.name, g);
}

function tier(t) {
  const a = t.annotations;
  if (a.readOnlyHint) return { id: 'T0', label: 'T0 read' };
  if (a.destructiveHint) return { id: 'T3', label: 'T3 destructive' };
  if (a.openWorldHint) return { id: 'T2', label: 'T2 external' };
  return { id: 'T2', label: 'T2 write' };
}

function treatment(t) {
  if (MENTION_ONLY[t.name]) return 'MENTION';
  const ti = tier(t).id;
  if (ti === 'T3' || ti === 'T2') return 'EXAMPLE';
  return READ_NEEDS_EXAMPLE.has(t.name) ? 'EXAMPLE' : 'REFERENCE';
}

const rows = tools.map((t) => {
  const c = covByName.get(t.name);
  const idem = t.inputSchema.properties?.idempotency_key
    ? (t.inputSchema.required ?? []).includes('idempotency_key') ? 'required' : 'optional'
    : '—';
  // Raw annotations, shown verbatim so a reviewer can check the tier mapping
  // rather than take it on trust.
  const a = t.annotations;
  const hints = [
    a.readOnlyHint ? 'readOnly' : null,
    a.destructiveHint ? 'destructive' : null,
    a.idempotentHint ? 'idempotent' : null,
    a.openWorldHint ? 'openWorld' : null,
  ].filter(Boolean).join(', ');

  return {
    name: t.name,
    group: groupOf.get(t.name),
    hints,
    tier: tier(t),
    idem,
    today: c.depth,
    todaySkills: c.skills,
    owner: ownerOf.get(t.name) ?? '(unassigned)',
    treatment: treatment(t),
    note: NOTES[t.name] ?? MENTION_ONLY[t.name] ?? '',
  };
});

// ── emit ──────────────────────────────────────────────────────────────────────
const esc = (s) => String(s).replace(/\|/g, '\\|');
const out = [];
const p = (s = '') => out.push(s);

const nDoc = rows.filter((r) => r.today === 'documented').length;
const nAbsent = rows.filter((r) => r.today === 'absent').length;
const nEx = rows.filter((r) => r.treatment === 'EXAMPLE').length;
const nRef = rows.filter((r) => r.treatment === 'REFERENCE').length;
const nMen = rows.filter((r) => r.treatment === 'MENTION').length;
const blocked = rows.filter((r) => r.note.startsWith('BLOCKED'));

p('# Coverage audit and skill map');
p();
p(`Generated from \`audit/tools-2026-08-25.json\` (live \`tools/list\`, sandbox key, \`epd-version: 2026-02-11\`).`);
p('Regenerate with `node audit/matrix.mjs`.');
p();
p('## Summary');
p();
p('| | |');
p('|---|---|');
p(`| Tools on the server | **${rows.length}** (docs publish 63) |`);
p(`| Documented today | ${nDoc} |`);
p(`| Not mentioned anywhere today | ${nAbsent} |`);
p(`| Proposed: worked example | ${nEx} |`);
p(`| Proposed: reference row only | ${nRef} |`);
p(`| Proposed: one-line mention | ${nMen} |`);
p(`| Blocked on client answer | ${blocked.length} |`);
p();
p('**Treatment** is the scope control. A `get_*` that takes an id and returns the object');
p('needs a table row, not a transcript; a destructive tool needs a transcript showing the');
p('confirmation. Uniform coverage across all 67 would be padding.');
p();

p('## Coverage by group');
p();
p('| Group | Tools | Documented today | Absent today | Proposed owner(s) |');
p('|---|---|---|---|---|');
for (const [g] of GROUPS) {
  const gr = rows.filter((r) => r.group === g);
  const owners = [...new Set(gr.map((r) => r.owner))].join(', ');
  p(`| ${g} | ${gr.length} | ${gr.filter((r) => r.today === 'documented').length} | ${gr.filter((r) => r.today === 'absent').length} | ${owners} |`);
}
p();

p('## Coverage by safety tier');
p();
p('Tiers are derived from the server\'s own annotations, not assigned by hand.');
p();
p('| Tier | Tools | Documented today | Absent today |');
p('|---|---|---|---|');
for (const label of ['T0 read', 'T2 write', 'T2 external', 'T3 destructive']) {
  const tr = rows.filter((r) => r.tier.label === label);
  p(`| ${label} | ${tr.length} | ${tr.filter((r) => r.today === 'documented').length} | ${tr.filter((r) => r.today === 'absent').length} |`);
}
p();

p('## Proposed skill map');
p();
p('| Skill | Tools owned | New or existing |');
p('|---|---|---|');
const EXISTING = new Set(['epd-onboard-customer', 'epd-subscriptions', 'epd-refunds']);
for (const [skill, list] of Object.entries(OWNER)) {
  p(`| \`${skill}\` | ${list.length} | ${EXISTING.has(skill) ? 'existing, revised' : 'new'} |`);
}
p();
p('`epd-best-practices`, `epd-quickstart` and `epd-webhooks` stay REST/integration-facing and own no MCP tools.');
p('The MCP counterparts are `epd-mcp-operator` and `epd-webhook-ops`.');
p();

if (blocked.length) {
  p('## Blocked on client answer');
  p();
  for (const r of blocked) p(`- \`${r.name}\` — ${r.note.replace(/^BLOCKED ON CLIENT — /, '')}`);
  p();
}

p('## Tool-by-tool matrix');
p();
p('| Tool | Group | Annotations (from server) | Tier | `idempotency_key` | Today | Proposed owner | Treatment | Notes |');
p('|---|---|---|---|---|---|---|---|---|');
for (const r of rows) {
  const today = r.today === 'absent' ? '—' : `${r.today}${r.todaySkills.length ? ` (${r.todaySkills.map((s) => s.split('/')[1]).join(', ')})` : ''}`;
  p(`| \`${r.name}\` | ${r.group} | ${r.hints} | ${r.tier.label} | ${r.idem} | ${esc(today)} | \`${r.owner}\` | ${r.treatment} | ${esc(r.note)} |`);
}
p();

p('## Deliberately not given dedicated treatment');
p();
for (const [name, why] of Object.entries(MENTION_ONLY)) p(`- \`${name}\` — ${why}`);
p();

const file = path.join(ROOT, 'audit', 'COVERAGE.md');
fs.writeFileSync(file, out.join('\n') + '\n');

const unassigned = rows.filter((r) => r.owner === '(unassigned)');
console.log(`wrote audit/COVERAGE.md — ${rows.length} tools`);
console.log(`  example: ${nEx}   reference: ${nRef}   mention: ${nMen}`);
console.log(`  blocked on client: ${blocked.length}`);
console.log(`  unassigned: ${unassigned.length}${unassigned.length ? ' → ' + unassigned.map((r) => r.name).join(', ') : ' (every tool has an owner)'}`);
