---
skill: epd-mcp-operator
surface: workflow
guide_version: 1.0.0
api_version: "2026-02-11"
---

# epd-mcp-operator — guide

**Skill:** [`workflows/epd-mcp-operator/SKILL.md`](../workflows/epd-mcp-operator/SKILL.md) ·
**Policy:** [`SAFETY.md`](../SAFETY.md) ·
**Tier table:** [`references/tiers.md`](../workflows/epd-mcp-operator/references/tiers.md)

The safety layer and the router for everything an agent does against a live EPD
Commerce account. It is the workflow counterpart to `epd-best-practices`, which
covers the REST side. Read this guide before any of the other workflow guides:
the eight domain skills deliberately carry no tier tables, no idempotency rules
and no rate-limit handling of their own, because all of it lives here.

## What it does

Four jobs, in the order an agent needs them.

**1. Establishes which account and which mode.** One `ping` at the start of the
session returns `environment`, `is_sandbox`, `merchant_id` and the account's
`api_version`. Every response after that carries `x-epd-environment` and
`x-epd-test-mode` headers, including responses to calls that failed. The skill
requires the mode to be stated in words to the human before the first write —
*"Connected to Acme Ltd in LIVE mode. Writes from here move real money."*

The expensive failure this prevents is not an agent that checks the wrong
environment. It is a human who assumes the session is sandbox because the
conversation started as an experiment.

**2. Finds the tier and runs the confirmation.** Tiers are a pure function of
the annotations the server declares on each tool — `readOnlyHint` is T0,
`destructiveHint` is T3, `openWorldHint` is T2-external, any other write is T2.
The per-tool table is generated from the `tools/list` snapshot by
`npm run gen:tiers`, so it cannot disagree with the server. The skill supplies
the confirmation templates; [`SAFETY.md`](../SAFETY.md) supplies the rules about
what a confirmation must contain.

**3. Handles the cross-cutting mechanics.** Idempotency keys and what to do when
a write times out; the three rate-limit buckets and which one to back off on;
the three shapes a failure can arrive in; the fact that no call can be
backgrounded. Each is a place where the obvious behaviour is wrong in a way that
costs money.

**4. Routes to the skill that owns the task.** Ten rows. The only skill it does
not route to is `epd-quickstart`, which fires before there is an account to
operate. Two boundaries do most of the work: *code generation versus account
operation* ("how do I refund an order" is a code question, "refund order
A1B2C3D4" is an account action), and *diagnosis before money* ("the payment
failed, refund them" goes to triage first, because a hard decline may mean
nothing was captured and no refund is owed).

### The three facts most worth knowing

| Fact | Why it matters |
|---|---|
| A failed tool call returns **HTTP 200** with `isError: true` and the error JSON inside a string in `content[0].text`. | An agent that checks only the status code reports a failed refund to the customer as done. |
| Three rate-limit buckets decrement on every request, including `initialize` and `tools/list`. The tightest is `-data` at 60/minute; the one that ends long sessions is `-global` at 1000/hour. | The unprefixed `x-ratelimit-remaining` is the loosest header and the one naive code reads first. It showed 39 remaining at the moment the server started returning 429. |
| Five write tools have no `idempotency_key` parameter at all. | "An idempotency key on every write" is a clean rule that is false on five tools, and a blind retry of `replay_webhook_event` is a genuine second delivery to a live consumer. |

## When it fires

On questions about the *surface* rather than about a domain:

- Naming a tool and asking whether to use it — *"should I use
  `create_customer_and_charge`"*, *"is `process_order` the right one"*.
- *"Am I in test or live?"* · *"Is this safe to run?"*
- A call came back `insufficient_permissions`, `idempotency_key_conflict`,
  `invalid_format`, or a 429.
- A write timed out and it is unclear whether to retry.
- Before the first write of any session.

It also fires **inside** a domain workflow. A subscription cancellation that hits
a 429 is a rate-limit question, not a subscription question, and the answer is
here.

### What it must not answer

Once the tool choice is settled and only domain steps remain, this skill hands
off. It does not create customers, issue refunds, or place orders. The
guide-level symptom that routing went wrong: the agent is quoting tier mechanics
at length while the human waits for a subscription to be cancelled.

The word **charge** appears in the trigger vocabulary of four skills and
straddles the code/operate boundary. The skill states outright that no skill may
be selected on that word alone.

## What it refuses to do, and why

| Refusal | Why |
|---|---|
| **Run a domain workflow itself.** | Single ownership. If two skills can both cancel a subscription, the one that happens to be loaded decides the safety behaviour — and which one loads is not something anyone controls. |
| **Restate the confirmation policy.** | [`SAFETY.md`](../SAFETY.md) is the only copy, so EPD can change its risk tolerance in one place. A restatement is a second copy that drifts and then contradicts. |
| **Hand-maintain a list of destructive tools.** | This is the rule that earns the skill its place. Before Phase D, `epd-subscriptions` listed `update_subscription` under *"tools annotated `destructiveHint: true`"*. The server annotates it as an ordinary T2 write. The product judgment behind the entry was sound — a payment-method change on a live subscription does deserve care. The defect was that a judgment had been recorded as a server fact, in a hand-typed list, with nothing to catch the divergence. |
| **Restate the server's own `instructions` block.** | Money units, bare UUIDs and pagination defaults already arrive in every session. Repeating them creates a second source that can go stale. |
| **Widen permissions or route around them.** | `insufficient_permissions` on this surface almost always means the key is restricted and cannot use MCP at all. Retrying, or finding another tool that reaches the same effect, converts a clean stop into an unlogged workaround. |
| **Decide policy at runtime.** | Standing authorizations for unattended work are written into `SAFETY.md` in advance. An agent that can grant itself an exception has no policy. |
| **Cover the REST surface.** | `api.epd.com/v1` belongs to `epd-best-practices`. The single exception is `secure.epd.com`, which appears here because the headless card flow passes through it. |

### The permissions reality, stated plainly

Every agent on this surface holds a key that can delete every customer, refund
every order and rotate every webhook secret. There is no smaller key. Two
restricted sandbox keys were created and measured on 27 August 2026: over REST
they honour their scopes exactly; against the MCP endpoint both are refused
outright — zero tools returned, `ping` included.

So the confirmation policy is not defence in depth. It is the defence. Re-check
with `node audit/key-matrix.mjs` once EPD ship the API Access permission; a
non-empty tool list from a restricted key means that section has gone stale.

## What to check afterwards

After any session that went through this skill:

- [ ] **The mode was stated in words** before the first write, not implied by a
      tool result the human may not have read.
- [ ] **Every T2 and T3 call has a visible confirmation** above it in the
      transcript, and the T3 confirmations quote an amount, a currency, an
      object ID and the mode.
- [ ] **No confirmation was reused.** One yes, one object.
- [ ] **Every write carries an idempotency key**, except the five tools that have
      no such parameter — and none of those five was retried.
- [ ] **`isError` was checked**, not just the absence of an exception. A reported
      success with no object ID in it is the shape of this going wrong.
- [ ] **`request_id` was surfaced** on every failure reported to a human. It is
      the first thing EPD support asks for and it is not recoverable afterwards.
- [ ] If the session was long, **it was paced against the hourly bucket.** 1000
      requests an hour is about 17 a minute sustained.

## A worked transcript

Illustrative. Tool names, argument shapes and error codes are as the skill
documents them; the merchant, IDs and amounts are placeholders.

---

**Operator:** Something's wrong with order A1B2C3D4 — the customer says they
were charged twice. Can you refund one of them?

**Agent:** Before I touch anything, let me establish where I am.

```
tool: ping
input: {}
```

```json
{
  "merchant_id": "3fa85f64-5717-4562-b3fc-2c963f66afa6",
  "name": "Acme Ltd",
  "environment": "live",
  "is_sandbox": false,
  "api_version": null,
  "latest_api_version": "2026-02-11"
}
```

Connected to **Acme Ltd** in **LIVE** mode. Writes from here move real money.

Two notes before I go on. The account's `api_version` is `null`, so it is not
pinned and floats on whatever is current — worth pinning separately, and that is
itself a destructive call. And "charged twice" is a diagnosis, not an
observation, so I am going to read before I act on it. Refunding is
irreversible; reading is free.

```
tool: list_orders
input:
  customer_id: 7c5a3d0b-9e42-4b2f-8e10-9f8c2e114d6a
  limit: 10
```

Two orders, ninety seconds apart, same amount, same items — but their statuses
differ:

| Order | Status | Total |
|---|---|---|
| `A1B2C3D4…` | `succeeded` | 4999 |
| `E5F6A7B8…` | `failed` | 4999 |

Only one of these took money. Let me confirm the second never captured.

```
tool: get_order
input:
  id: e5f6a7b8-1234-4c3d-9e2f-5a6b7c8d9e0f
  expand: transactions
```

```json
{
  "status": "failed",
  "failure_code": "do_not_honor",
  "attempt_count": 1,
  "next_retry_at": null,
  "transactions": [
    { "type": "sale", "status": "failed", "amount": 4999 }
  ]
}
```

Confirmed: one succeeded sale, one failed sale, no capture on the second. A
failed order row persists so the attempt can be audited, which is why it shows
up in the customer's history looking like a second charge.

**The customer was charged once.** The other entry is an authorization their
bank has not yet released — typically three to five business days, and not
something either of us can accelerate from here.

I have not issued a refund and I am not going to propose one, because there is
no second payment to return. If you want me to refund the *successful* order —
a different decision, made on the merits rather than to fix a double charge —
say so and I will read the order back and ask you to confirm the amount first.

**Operator:** No, that's fine. Can you pull the last month's failures so I can
see if `do_not_honor` is spiking?

**Agent:** That is partly a reporting question and partly a triage question, and
they are different skills — but both are read-only, so neither needs a
confirmation. One pacing note before I start: a month of transactions is five or
six pages at 100 rows each, and every page spends one call against the
60-per-minute data bucket and the 1000-per-hour global one. I will page through
the month rather than pulling the year.

---

### What the transcript demonstrates

- **`ping` first, mode stated in words**, before anything else — including
  before the read, because the mode changes how the results should be read.
- **A T3 action was requested and not taken.** "Refund one of them" is an
  instruction, but the premise was wrong, and the skill's *diagnosis before
  money* boundary says read first.
- **The refusal names what it will not do and what it would need** in order to do
  the other thing, rather than just declining.
- **No confirmation was requested**, because nothing reached T2. Asking approval
  for a read is noise that trains humans to approve without reading.
- **Rate limits came up before the expensive operation**, not after the 429.

## Where it hands off

| If the task is | Load |
|---|---|
| Customer record or cards | [`epd-onboard-customer`](./epd-onboard-customer.md) |
| Subscription lifecycle, dunning | [`epd-subscriptions`](./epd-subscriptions.md) |
| Money going back to a customer | [`epd-refunds`](./epd-refunds.md) |
| Products, plans, one-off orders | [`epd-catalog`](./epd-catalog.md) |
| Why a charge failed | [`epd-transaction-triage`](./epd-transaction-triage.md) |
| Webhook endpoints on the account | [`epd-webhook-ops`](./epd-webhook-ops.md) |
| Coupons and promo codes | [`epd-coupons`](./epd-coupons.md) |
| Revenue, month-end, per-customer totals | [`epd-reporting`](./epd-reporting.md) |
| Writing backend code against `api.epd.com/v1` | [`epd-best-practices`](./epd-best-practices.md) |
| Writing or debugging a webhook receiver | [`epd-webhooks`](./epd-webhooks.md) |

Deeper references, loaded on demand by the skill itself:
[`tiers.md`](../workflows/epd-mcp-operator/references/tiers.md) (all 67 tools
with their annotations),
[`errors.md`](../workflows/epd-mcp-operator/references/errors.md) (observed codes
and retry rules),
[`composites.md`](../workflows/epd-mcp-operator/references/composites.md) (all 11
composite tools and their partial-failure contracts).
