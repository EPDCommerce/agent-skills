#!/usr/bin/env node
/**
 * Empirical permissions matrix for EPD Commerce API keys.
 *
 * Usage:  node audit/key-matrix.mjs
 */

import fs from 'node:fs';
import path from 'node:path';

const ENDPOINT = 'https://api.epd.com/mcp';
const API_VERSION = '2026-02-11';
const ROOT = path.resolve(import.meta.dirname, '..');

// One read-only probe per tool group. Groups whose probe needs arguments get
// them from PROBE_ARGS; everything else takes no required input.
// Safe write probes. Every one targets a randomly generated UUID that cannot
// exist, so a permitted call fails on lookup and an unpermitted call fails on
// authorization,, nothing is ever created or mutated. The difference between
// the two failures is exactly what we want to measure, and it also reveals
// whether the server checks permission before existence.
const NOWHERE = () => crypto.randomUUID();
const WRITE_PROBES = [
  ['Customers', 'update_customer', () => ({ id: NOWHERE(), company: 'permission probe' })],
  ['Products', 'update_product', () => ({ id: NOWHERE(), name: 'permission probe' })],
  ['Subscriptions', 'update_subscription', () => ({ id: NOWHERE(), billing_cycle: { interval: 'month', interval_count: 1 } })],
  ['Webhook Endpoints', 'update_webhook_endpoint', () => ({ id: NOWHERE(), description: 'permission probe' })],
  ['Coupons', 'update_coupon', () => ({ id: NOWHERE(), name: 'permission probe' })],
];

const PROBES = [
  ['Account', 'get_account', {}],
  ['Customers', 'list_customers', { limit: 1 }],
  ['Payment Methods', 'list_payment_methods', null], // needs a customer_id
  ['Products', 'list_products', { limit: 1 }],
  ['Plans', 'list_plans', { limit: 1 }],
  ['Orders', 'list_orders', { limit: 1 }],
  ['Subscriptions', 'list_subscriptions', { limit: 1 }],
  ['Transactions', 'list_transactions', { limit: 1 }],
  ['Webhook Endpoints', 'list_webhook_endpoints', {}],
  ['Webhook Versions', 'list_webhook_versions', {}],
  ['Coupons', 'list_coupons', { limit: 1 }],
  ['Composite', 'list_past_due_subscriptions', { limit: 1 }],
];

function loadEnv() {
  const out = {};
  const file = path.join(ROOT, '.env');
  if (!fs.existsSync(file)) throw new Error('.env not found at repo root');
  for (const line of fs.readFileSync(file, 'utf8').split(/\r?\n/)) {
    const m = line.match(/^\s*([A-Za-z_][A-Za-z0-9_]*)\s*=\s*(.*)\s*$/);
    if (!m) continue;
    out[m[1]] = m[2].replace(/^["']|["']$/g, '').trim();
  }
  return out;
}

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
let paceUntil = 0;

/** Send one JSON-RPC call. Backs off on the MINIMUM of the three rate buckets. */
async function rpc(key, method, params) {
  const wait = paceUntil - Date.now();
  if (wait > 0) await sleep(wait);

  const res = await fetch(ENDPOINT, {
    method: 'POST',
    headers: {
      authorization: `Bearer ${key}`,
      'epd-version': API_VERSION,
      'content-type': 'application/json',
      accept: 'application/json, text/event-stream',
    },
    body: JSON.stringify({ jsonrpc: '2.0', id: Date.now(), method, params }),
  });

  // The unprefixed header is the loosest of the three and overstates headroom.
  // Pace on whichever bucket is actually tightest.
  const remaining = ['x-ratelimit-remaining', 'x-ratelimit-remaining-global', 'x-ratelimit-remaining-data']
    .map((h) => Number(res.headers.get(h)))
    .filter((n) => Number.isFinite(n));
  const floor = Math.min(...remaining);
  paceUntil = Date.now() + (floor < 10 ? 2000 : floor < 25 ? 400 : 120);

  const body = await res.text();
  const data = body
    .split(/\r?\n/)
    .filter((l) => l.startsWith('data: '))
    .map((l) => l.slice(6))
    .join('');
  try {
    return { http: res.status, json: JSON.parse(data || body) };
  } catch {
    return { http: res.status, json: null, raw: body.slice(0, 300) };
  }
}

/** Unwrap a tools/call result into a compact verdict. */
function verdict(r) {
  if (!r.json) return { ok: false, label: `HTTP ${r.http}` };
  if (r.json.error) return { ok: false, label: r.json.error.message?.slice(0, 60) ?? 'rpc error' };
  const res = r.json.result;
  if (!res) return { ok: false, label: 'no result' };
  const text = res.content?.[0]?.text ?? '';
  if (res.isError) {
    let code = 'error';
    try {
      code = JSON.parse(text).error?.code ?? 'error';
    } catch {
      code = text.slice(0, 40);
    }
    return { ok: false, label: code };
  }
  return { ok: true, label: 'ok' };
}

async function auditKey(label, key) {
  const out = { label, prefix: key.slice(0, key.lastIndexOf('_') + 1) };

  const ping = await rpc(key, 'tools/call', { name: 'ping', arguments: {} });
  if (ping.json?.result?.content) {
    try {
      const p = JSON.parse(ping.json.result.content[0].text);
      out.environment = p.environment ?? (p.is_sandbox ? 'test' : 'live');
      out.merchant = p.name;
    } catch {}
  }
  out.pingVerdict = verdict(ping);

  const list = await rpc(key, 'tools/list', {});
  out.tools = list.json?.result?.tools?.map((t) => t.name) ?? [];

  out.probes = {};
  for (const [group, tool, args] of PROBES) {
    if (args === null) {
      out.probes[group] = { ok: null, label: 'skipped (needs id)' };
      continue;
    }
    if (out.tools.length && !out.tools.includes(tool)) {
      out.probes[group] = { ok: false, label: 'not in tools/list' };
      continue;
    }
    out.probes[group] = verdict(await rpc(key, 'tools/call', { name: tool, arguments: args }));
  }

  out.writes = {};
  for (const [group, tool, mkArgs] of WRITE_PROBES) {
    if (out.tools.length && !out.tools.includes(tool)) {
      out.writes[group] = { ok: false, label: 'not in tools/list' };
      continue;
    }
    out.writes[group] = verdict(await rpc(key, 'tools/call', { name: tool, arguments: mkArgs() }));
  }
  return out;
}

const pad = (s, n) => String(s).padEnd(n);

async function main() {
  const env = loadEnv();
  const keys = Object.entries(env).filter(([k, v]) => /^EPD_.*KEY$/.test(k) && v);
  if (!keys.length) throw new Error('no EPD_*_KEY variables found in .env');

  console.log(`auditing ${keys.length} key(s): ${keys.map(([k]) => k).join(', ')}\n`);

  const results = [];
  for (const [name, key] of keys) results.push(await auditKey(name, key));

  console.log('=== KEY IDENTITY ===');
  for (const r of results) {
    console.log(
      `${pad(r.label, 28)} ${pad(r.prefix, 26)} env=${pad(r.environment ?? '?', 6)} tools=${pad(r.tools.length, 4)} ${r.pingVerdict.ok ? '' : '  PING FAILED: ' + r.pingVerdict.label}`,
    );
  }

  const base = results[0];
  if (results.length > 1) {
    console.log('\n=== tools/list DIFF vs ' + base.label + ' ===');
    for (const r of results.slice(1)) {
      const missing = base.tools.filter((t) => !r.tools.includes(t));
      const extra = r.tools.filter((t) => !base.tools.includes(t));
      console.log(`\n${r.label}:  ${r.tools.length} tools  (${missing.length} fewer, ${extra.length} extra)`);
      if (!missing.length && !extra.length) {
        console.log('   IDENTICAL — tool surface does NOT narrow with scope.');
        console.log('   → enforcement is at call time; skills must read the error, not the list.');
      }
      if (missing.length) console.log('   absent: ' + missing.join(', '));
      if (extra.length) console.log('   extra:  ' + extra.join(', '));
    }
  }

  console.log('\n=== READ PROBE MATRIX (one read-only call per group) ===');
  const w = 20;
  console.log(pad('GROUP', w) + results.map((r) => pad(r.label.replace(/^EPD_|_KEY$/g, ''), 22)).join(''));
  console.log('-'.repeat(w + results.length * 22));
  for (const [group] of PROBES) {
    let row = pad(group, w);
    for (const r of results) {
      const p = r.probes[group];
      const mark = p.ok === null ? '—' : p.ok ? 'ok' : p.label;
      row += pad(mark, 22);
    }
    console.log(row);
  }

  console.log('\n=== WRITE PROBE MATRIX (update against a non-existent UUID — cannot mutate) ===');
  console.log(pad('GROUP', w) + results.map((r) => pad(r.label.replace(/^EPD_|_KEY$/g, ''), 26)).join(''));
  console.log('-'.repeat(w + results.length * 26));
  for (const [group] of WRITE_PROBES) {
    let row = pad(group, w);
    for (const r of results) row += pad(r.writes[group]?.label ?? '?', 26);
    console.log(row);
  }
  console.log(
    '\nreading the write matrix: `resource_not_found` means the key WAS allowed to write\n' +
      '(it got as far as the lookup); an authorization code means it was blocked before that.',
  );

  fs.writeFileSync(
    path.join(ROOT, 'audit', 'key-matrix.json'),
    JSON.stringify({ captured_at: new Date().toISOString(), results }, null, 2) + '\n',
  );
  console.log('\nwrote audit/key-matrix.json');
}

main().catch((e) => {
  console.error('FAILED:', e.message);
  process.exit(1);
});
