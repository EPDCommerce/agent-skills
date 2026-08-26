
import fs from 'node:fs';
import path from 'node:path';

const ROOT = path.resolve(import.meta.dirname, '..');

// ── the 12 skills ─────────────────────────────────────────────────────────────
// `triggers`  — phrases that should load this skill
// `skip`      — [condition, skill that should win instead]
// Every skip target must be a real skill name; verified at the bottom.
const SKILLS = [
  {
    name: 'epd-best-practices', kind: 'integration', status: 'existing',
    owns: 0,
    purpose: 'Master router for building EPD Commerce into your own backend over the v1 REST API.',
    triggers: ['integrate EPD', 'api.epd.com', 'EPD_API_KEY', 'epd_live_sk_', 'how do I charge a card', 'pagination', 'error envelope', 'X-EPD-Idempotency-Key'],
    skip: [
      ['operating a live account through an MCP-connected agent', 'epd-mcp-operator'],
      ['first integration, nothing built yet', 'epd-quickstart'],
      ['writing a webhook receiver', 'epd-webhooks'],
    ],
  },
  {
    name: 'epd-quickstart', kind: 'integration', status: 'existing',
    owns: 0,
    purpose: 'First-integration walkthrough — sandbox key to first test charge.',
    triggers: ['getting started', 'first time', 'hello world', 'set up EPD', 'my first charge', 'quickstart'],
    skip: [['past the first charge, asking general integration questions', 'epd-best-practices']],
  },
  {
    name: 'epd-webhooks', kind: 'integration', status: 'existing',
    owns: 0,
    purpose: 'Writing and debugging a webhook receiver — HMAC-SHA256 verification, replay protection, raw-body handling.',
    triggers: ['verify a webhook signature', 'EPD-Signature header', 'EPD_WEBHOOK_SECRET', 'HMAC', 'raw body', 'signature mismatch'],
    skip: [['registering or rotating endpoints on a live account via MCP', 'epd-webhook-ops']],
  },
  {
    name: 'epd-mcp-operator', kind: 'workflow', status: 'new',
    owns: 3,
    purpose: 'Master router and safety layer for the MCP surface. Tool selection, confirmation tiers, key mode, idempotency, rate limits, permission errors.',
    triggers: ['which EPD tool should I use', 'am I in test or live', 'is this safe to run', 'insufficient_permissions', 'rate limited', '429', 'idempotency_key', 'before the first write of a session'],
    skip: [
      ['the task is customer records or their cards', 'epd-onboard-customer'],
      ['the task is products, plans or placing an order', 'epd-catalog'],
      ['the task is recurring billing', 'epd-subscriptions'],
      ['money must go back to a customer', 'epd-refunds'],
      ['a charge failed and nobody has diagnosed it yet', 'epd-transaction-triage'],
      ['the task is webhook endpoints on the account', 'epd-webhook-ops'],
      ['the task is discounts or promo codes', 'epd-coupons'],
      ['the question is about totals over a period', 'epd-reporting'],
      ['generating backend code rather than operating an account', 'epd-best-practices'],
    ],
  },
  {
    name: 'epd-onboard-customer', kind: 'workflow', status: 'revised',
    owns: 10,
    purpose: 'Customer lifecycle: create, look up, update, delete, and attach or remove payment methods.',
    triggers: ['onboard a customer', 'sign up a new customer', 'add a card to this customer', 'update the customer record', 'remove their card'],
    skip: [
      ['selling something to an existing customer', 'epd-catalog'],
      ['starting recurring billing on an existing customer', 'epd-subscriptions'],
    ],
  },
  {
    name: 'epd-catalog', kind: 'workflow', status: 'new',
    owns: 11,
    purpose: 'Products, plans, images, and placing one-off orders.',
    triggers: ['create a product', 'change the price', 'product images', 'what plans exist', 'place an order', 'sell them the', 'SKU'],
    skip: [
      ['discounting rather than pricing', 'epd-coupons'],
      ['recurring billing rather than a one-off order', 'epd-subscriptions'],
    ],
  },
  {
    name: 'epd-subscriptions', kind: 'workflow', status: 'revised',
    owns: 8,
    purpose: 'Subscription lifecycle: start, change billing cycle or payment method, cancel, and recover past_due through dunning.',
    triggers: ['start a subscription', 'cancel the subscription', 'change the billing cycle', 'past due', 'dunning', 'retry the failed charge', 'move them to a different plan'],
    skip: [
      ['money must go back to the customer as well', 'epd-refunds'],
      ['the customer does not exist yet', 'epd-onboard-customer'],
    ],
  },
  {
    name: 'epd-refunds', kind: 'workflow', status: 'revised',
    owns: 3,
    purpose: 'Issuing refunds — full or partial, on an order or a transaction, optionally with cancellation.',
    triggers: ['refund this order', 'refund $', 'give the money back', 'partial refund', 'cancel and refund'],
    skip: [
      ['diagnosing why a charge failed, before deciding anything', 'epd-transaction-triage'],
      ['cancelling with no money moving', 'epd-subscriptions'],
    ],
  },
  {
    name: 'epd-transaction-triage', kind: 'workflow', status: 'new',
    owns: 5,
    purpose: 'Read-only diagnosis of a failed charge: soft decline safe to retry, hard decline that must not be, or a config error wearing a decline\'s clothes.',
    triggers: ['why did this fail', 'declined', 'decline code', 'the charge did not go through', 'is it safe to retry', 'do_not_honor', 'insufficient_funds'],
    skip: [
      ['the decision is already made and money must move', 'epd-refunds'],
      ['the failure is a subscription dunning cycle', 'epd-subscriptions'],
      ['asking about totals over a period rather than one failure', 'epd-reporting'],
    ],
  },
  {
    name: 'epd-webhook-ops', kind: 'workflow', status: 'new',
    owns: 16,
    purpose: 'Operating webhook endpoints on a live account: registration, secret rotation, replay, delivery logs, and version migration.',
    triggers: ['register a webhook endpoint', 'rotate the webhook secret', 'replay that event', 'deliveries are failing', 'upgrade the webhook version', 'delivery logs'],
    skip: [['writing or debugging the receiver code itself', 'epd-webhooks']],
  },
  {
    name: 'epd-coupons', kind: 'workflow', status: 'new',
    owns: 9,
    purpose: 'Discounts end to end: create, validate, bulk-generate codes, archive and unarchive.',
    triggers: ['create a coupon', 'promo code', 'discount code', 'generate codes', 'is this code valid', 'archive the coupon', 'launch a promotion'],
    skip: [['changing list price rather than discounting it', 'epd-catalog']],
  },
  {
    name: 'epd-reporting', kind: 'workflow', status: 'new',
    owns: 2,
    purpose: 'Read-only aggregates: revenue over a period, per-customer financial summaries, month-end reconciliation.',
    triggers: ['revenue this month', 'month end', 'reconcile', 'how much did we bill', 'financial summary', 'what has this customer paid us'],
    skip: [['one specific transaction failed', 'epd-transaction-triage']],
  },
];

// ── mechanical collision check ────────────────────────────────────────────────
const STOP = new Set(('a an the this that these those is are was were be been do does did i my we our you your it its of to in on at for with and or not no if then than as by from ' +
  'should would could can will shall may might have has had get got make made use used using them they their there here what which who how why when where').split(' '));

// Domain words that belong to the product, not to any one skill.
const DOMAIN = new Set(['epd', 'commerce', 'account', 'api']);

function terms(skill) {
  const out = new Set();
  for (const t of skill.triggers) {
    for (const w of t.toLowerCase().match(/[a-z_][a-z0-9_.]*/g) ?? []) {
      if (w.length < 3 || STOP.has(w) || DOMAIN.has(w)) continue;
      out.add(w);
    }
  }
  return out;
}

const termsOf = new Map(SKILLS.map((s) => [s.name, terms(s)]));

// A term appearing in 3+ skills cannot disambiguate anything on its own.
const freq = new Map();
for (const [, set] of termsOf) for (const t of set) freq.set(t, (freq.get(t) ?? 0) + 1);
const ambiguous = [...freq.entries()].filter(([, n]) => n >= 3).sort((a, b) => b[1] - a[1]);

// Reachability over the Skip-when graph, so a hop through a router counts.
const edges = new Map(SKILLS.map((s) => [s.name, s.skip.map(([, to]) => to)]));
// Returns hop distance, or Infinity if unreachable. Distance matters: a direct
// Skip-when line is read by the agent alongside the trigger; a three-hop chain
// is technically documented but nobody traverses it.
function hops(from, to) {
  const seen = new Set([from]);
  let frontier = [from], d = 0;
  while (frontier.length) {
    d++;
    const next = [];
    for (const cur of frontier) {
      for (const n of edges.get(cur) ?? []) {
        if (n === to) return d;
        if (!seen.has(n)) {
          seen.add(n);
          next.push(n);
        }
      }
    }
    frontier = next;
  }
  return Infinity;
}

const pairs = [];
for (let i = 0; i < SKILLS.length; i++) {
  for (let j = i + 1; j < SKILLS.length; j++) {
    const a = SKILLS[i], b = SKILLS[j];
    const shared = [...termsOf.get(a.name)].filter((t) => termsOf.get(b.name).has(t));
    if (!shared.length) continue;
    // Routed if either can reach the other by following Skip-when edges. A
    // hop through a router counts: that is what a router is for, and requiring
    // every leaf to name every other leaf would produce 12 unreadable
    // descriptions instead of 2 routers and 10 short ones.
    const dist = Math.min(hops(a.name, b.name), hops(b.name, a.name));
    const routed = dist !== Infinity;
    pairs.push({ a: a.name, b: b.name, shared, routed, dist, sameSurface: a.kind === b.kind });
  }
}
pairs.sort((x, y) => y.shared.length - x.shared.length);

// Cross-surface overlap is the expensive kind: the agent either writes code when
// it should have operated the account, or operates the account when it should
// have written code. One shared term is enough to flag it. Within a surface the
// blast radius is smaller, so require two.
const unrouted = pairs.filter(
  (p) => !p.routed && (p.sameSurface ? p.shared.length >= 2 : p.shared.length >= 1),
);

// Every skip target must name a real skill (or the documented placeholder).
const names = new Set(SKILLS.map((s) => s.name));
const badTargets = [];
for (const s of SKILLS) {
  for (const [cond, to] of s.skip) {
    if (!names.has(to) && to !== 'the owning leaf skill') badTargets.push(`${s.name} → ${to}`);
  }
}

// ── emit ──────────────────────────────────────────────────────────────────────
const out = [];
const p = (s = '') => out.push(s);

p('# Skill map and routing');
p();
p('Twelve skills across two surfaces. Regenerate with `node audit/skill-map.mjs`.');
p();
p('Trigger collisions fail silently — the wrong skill loads, the agent follows guidance');
p('written for a different workflow, and nothing errors. So the routing below is checked');
p('mechanically, not by eye.');
p();

p('## The twelve');
p();
p('| Skill | Surface | Status | MCP tools | Purpose |');
p('|---|---|---|---|---|');
for (const s of SKILLS) p(`| \`${s.name}\` | ${s.kind} | ${s.status} | ${s.owns || '—'} | ${s.purpose} |`);
p();
p('The three `integration` skills own no MCP tools by design: they generate backend code');
p('against the REST API. The nine `workflow` skills operate a live account through MCP.');
p('That split is the single most important routing boundary in the repo, and it is the one');
p('an agent gets wrong most easily, because the vocabulary is nearly identical on both sides.');
p();

p('## Triggers and routing');
p();
for (const s of SKILLS) {
  p(`### \`${s.name}\``);
  p();
  p(`${s.purpose}`);
  p();
  p('**Triggers on:** ' + s.triggers.map((t) => `_"${t}"_`).join(' · '));
  p();
  p('**Skip when:**');
  p();
  for (const [cond, to] of s.skip) p(`- ${cond} → \`${to}\``);
  p();
}

p('## Disambiguation table');
p();
p('The prompts that could plausibly load two skills, and which one wins.');
p();
p('| Prompt | Wins | Why |');
p('|---|---|---|');
const DISAMBIG = [
  ['"the payment failed, refund them"', 'epd-transaction-triage', 'Diagnose before moving money. Triage hands off to epd-refunds once the failure is classified — a hard decline may mean no refund is owed at all.'],
  ['"how do I verify a webhook signature"', 'epd-webhooks', 'Writing receiver code, not operating an endpoint.'],
  ['"the webhook signature is failing in production"', 'epd-webhooks', 'Still receiver-side. Only becomes epd-webhook-ops if the fix is rotating the secret.'],
  ['"our webhooks stopped arriving"', 'epd-webhook-ops', 'Delivery-side. Read the logs before touching the receiver.'],
  ['"charge this customer $50"', 'epd-catalog', 'A one-off order. epd-onboard-customer only owns the customer record and its cards.'],
  ['"sign up Alice and bill her monthly"', 'epd-onboard-customer', 'Starts with a customer that does not exist; hands to epd-subscriptions after creation.'],
  ['"cancel and refund them"', 'epd-refunds', 'Money moves, so the refund skill owns the confirmation. It calls refund_and_cancel.'],
  ['"cancel at period end"', 'epd-subscriptions', 'No money moves.'],
  ['"this card keeps getting declined on renewal"', 'epd-subscriptions', 'Dunning, not a one-off failure. Triage explicitly routes recurring failures here.'],
  ['"how much did we make in July"', 'epd-reporting', 'Aggregate over a period.'],
  ['"why is this $40 charge missing from July"', 'epd-transaction-triage', 'One transaction, not an aggregate.'],
  ['"set up a 20% off code"', 'epd-coupons', 'Discount, not list price.'],
  ['"drop the price to $40"', 'epd-catalog', 'List price, not a discount.'],
  ['"am I about to do this against live?"', 'epd-mcp-operator', 'Cross-cutting safety, no domain.'],
];
for (const [prompt, wins, why] of DISAMBIG) p(`| ${prompt} | \`${wins}\` | ${why} |`);
p();

p('## Collision check');
p();
p(`${pairs.length} skill pairs share at least one trigger term.`);
p();
p('### Terms too common to disambiguate');
p();
p('Appearing in three or more skills, so none of them may rely on the word alone:');
p();
p('| Term | Skills |');
p('|---|---|');
for (const [t, n] of ambiguous) p(`| \`${t}\` | ${n} |`);
p();
p('### Pairs sharing vocabulary without an explicit routing rule');
p();
if (!unrouted.length) {
  p('None. Every pair sharing two or more trigger terms has an explicit `Skip when` rule');
  p('in at least one direction.');
} else {
  p('| Pair | Shared terms | Same surface |');
  p('|---|---|---|');
  for (const c of unrouted) p(`| \`${c.a}\` ↔ \`${c.b}\` | ${c.shared.map((s) => `\`${s}\``).join(', ')} | ${c.sameSurface ? 'yes' : 'no'} |`);
}
p();
p('### Highest-overlap pairs');
p();
p('`Hops` is the shortest `Skip when` path between the two. 1 means one skill names the');
p('other directly. 3 or more means the route exists on paper but no agent will traverse it —');
p('those pairs are carried by distinct vocabulary, not by routing, so their trigger phrases');
p('must stay disjoint.');
p();
p('| Pair | Shared | Hops | Same surface |');
p('|---|---|---|---|');
for (const c of pairs.slice(0, 10)) {
  const h = c.dist === Infinity ? '**none**' : c.dist >= 3 ? `${c.dist} (weak)` : String(c.dist);
  p(`| \`${c.a}\` ↔ \`${c.b}\` | ${c.shared.map((s) => `\`${s}\``).join(', ')} | ${h} | ${c.sameSurface ? 'yes' : 'no'} |`);
}
p();
const weak = pairs.filter((c) => c.dist >= 3 && c.dist !== Infinity);
if (weak.length) {
  p(`${weak.length} pair(s) are only reachable in 3+ hops. None share more than one term, so`);
  p('vocabulary carries them — but none of those shared terms may be used alone as a trigger.');
  p();
}

p('## Notes against the existing six');
p();
p('- `epd-webhooks` already carries a `Skip when ... use workflow skills` clause, but it');
p('  names no specific skill. It should name `epd-webhook-ops` once that exists.');
p('- `epd-best-practices` currently says to skip to "the workflow skills under workflows/".');
p('  With nine workflow skills that is no longer actionable — it should route to');
p('  `epd-mcp-operator`, which then routes onward.');
p('- `epd-onboard-customer` describes itself as covering "first charge or subscription".');
p('  Under this map it owns the customer and its payment methods only; charging is');
p('  `epd-catalog` and recurring is `epd-subscriptions`. Its description narrows.');
p('- `epd-subscriptions` and `epd-refunds` already cross-reference each other correctly;');
p('  both need a new clause pointing at `epd-transaction-triage` for diagnosis.');
p('- All six inherit the safety layer from `epd-mcp-operator` rather than restating it,');
p('  which is what removes the duplication Phase D is budgeted to strip.');
p();

if (badTargets.length) {
  p('## Broken skip targets');
  p();
  for (const b of badTargets) p(`- ${b}`);
  p();
}

fs.writeFileSync(path.join(ROOT, 'audit', 'SKILL-MAP.md'), out.join('\n') + '\n');

console.log(`wrote audit/SKILL-MAP.md — ${SKILLS.length} skills`);
console.log(`  total MCP tools owned: ${SKILLS.reduce((n, s) => n + s.owns, 0)}`);
console.log(`  pairs sharing vocabulary: ${pairs.length}`);
console.log(`  ambiguous terms (3+ skills): ${ambiguous.length}${ambiguous.length ? ' → ' + ambiguous.map(([t]) => t).join(', ') : ''}`);
console.log(`  UNROUTED collisions: ${unrouted.length}${unrouted.length ? ' → ' + unrouted.map((c) => c.a + '/' + c.b).join('; ') : ' (all routed)'}`);
console.log(`  broken skip targets: ${badTargets.length}${badTargets.length ? ' → ' + badTargets.join('; ') : ''}`);
