# Skill map and routing

Twelve skills across two surfaces. Regenerate with `node audit/skill-map.mjs`.

Trigger collisions fail silently — the wrong skill loads, the agent follows guidance
written for a different workflow, and nothing errors. So the routing below is checked
mechanically, not by eye.

## The twelve

| Skill | Surface | Status | MCP tools | Purpose |
|---|---|---|---|---|
| `epd-best-practices` | integration | existing | — | Master router for building EPD Commerce into your own backend over the v1 REST API. |
| `epd-quickstart` | integration | existing | — | First-integration walkthrough — sandbox key to first test charge. |
| `epd-webhooks` | integration | existing | — | Writing and debugging a webhook receiver — HMAC-SHA256 verification, replay protection, raw-body handling. |
| `epd-mcp-operator` | workflow | new | 3 | Master router and safety layer for the MCP surface. Tool selection, confirmation tiers, key mode, idempotency, rate limits, permission errors. |
| `epd-onboard-customer` | workflow | revised | 10 | Customer lifecycle: create, look up, update, delete, and attach or remove payment methods. |
| `epd-catalog` | workflow | new | 11 | Products, plans, images, and placing one-off orders. |
| `epd-subscriptions` | workflow | revised | 8 | Subscription lifecycle: start, change billing cycle or payment method, cancel, and recover past_due through dunning. |
| `epd-refunds` | workflow | revised | 3 | Issuing refunds — full or partial, on an order or a transaction, optionally with cancellation. |
| `epd-transaction-triage` | workflow | new | 5 | Read-only diagnosis of a failed charge: soft decline safe to retry, hard decline that must not be, or a config error wearing a decline's clothes. |
| `epd-webhook-ops` | workflow | new | 16 | Operating webhook endpoints on a live account: registration, secret rotation, replay, delivery logs, and version migration. |
| `epd-coupons` | workflow | new | 9 | Discounts end to end: create, validate, bulk-generate codes, archive and unarchive. |
| `epd-reporting` | workflow | new | 2 | Read-only aggregates: revenue over a period, per-customer financial summaries, month-end reconciliation. |

The three `integration` skills own no MCP tools by design: they generate backend code
against the REST API. The nine `workflow` skills operate a live account through MCP.
That split is the single most important routing boundary in the repo, and it is the one
an agent gets wrong most easily, because the vocabulary is nearly identical on both sides.

## Triggers and routing

### `epd-best-practices`

Master router for building EPD Commerce into your own backend over the v1 REST API.

**Triggers on:** _"integrate EPD"_ · _"api.epd.com"_ · _"EPD_API_KEY"_ · _"epd_live_sk_"_ · _"how do I charge a card"_ · _"pagination"_ · _"error envelope"_ · _"X-EPD-Idempotency-Key"_

**Skip when:**

- operating a live account through an MCP-connected agent → `epd-mcp-operator`
- first integration, nothing built yet → `epd-quickstart`
- writing a webhook receiver → `epd-webhooks`

### `epd-quickstart`

First-integration walkthrough — sandbox key to first test charge.

**Triggers on:** _"getting started"_ · _"first time"_ · _"hello world"_ · _"set up EPD"_ · _"my first charge"_ · _"quickstart"_

**Skip when:**

- past the first charge, asking general integration questions → `epd-best-practices`

### `epd-webhooks`

Writing and debugging a webhook receiver — HMAC-SHA256 verification, replay protection, raw-body handling.

**Triggers on:** _"verify a webhook signature"_ · _"EPD-Signature header"_ · _"EPD_WEBHOOK_SECRET"_ · _"HMAC"_ · _"raw body"_ · _"signature mismatch"_

**Skip when:**

- registering or rotating endpoints on a live account via MCP → `epd-webhook-ops`

### `epd-mcp-operator`

Master router and safety layer for the MCP surface. Tool selection, confirmation tiers, key mode, idempotency, rate limits, permission errors.

**Triggers on:** _"which EPD tool should I use"_ · _"am I in test or live"_ · _"is this safe to run"_ · _"insufficient_permissions"_ · _"rate limited"_ · _"429"_ · _"idempotency_key"_ · _"before the first write of a session"_

**Skip when:**

- the task is customer records or their cards → `epd-onboard-customer`
- the task is products, plans or placing an order → `epd-catalog`
- the task is recurring billing → `epd-subscriptions`
- money must go back to a customer → `epd-refunds`
- a charge failed and nobody has diagnosed it yet → `epd-transaction-triage`
- the task is webhook endpoints on the account → `epd-webhook-ops`
- the task is discounts or promo codes → `epd-coupons`
- the question is about totals over a period → `epd-reporting`
- generating backend code rather than operating an account → `epd-best-practices`

### `epd-onboard-customer`

Customer lifecycle: create, look up, update, delete, and attach or remove payment methods.

**Triggers on:** _"onboard a customer"_ · _"sign up a new customer"_ · _"add a card to this customer"_ · _"update the customer record"_ · _"remove their card"_

**Skip when:**

- selling something to an existing customer → `epd-catalog`
- starting recurring billing on an existing customer → `epd-subscriptions`

### `epd-catalog`

Products, plans, images, and placing one-off orders.

**Triggers on:** _"create a product"_ · _"change the price"_ · _"product images"_ · _"what plans exist"_ · _"place an order"_ · _"sell them the"_ · _"SKU"_

**Skip when:**

- discounting rather than pricing → `epd-coupons`
- recurring billing rather than a one-off order → `epd-subscriptions`

### `epd-subscriptions`

Subscription lifecycle: start, change billing cycle or payment method, cancel, and recover past_due through dunning.

**Triggers on:** _"start a subscription"_ · _"cancel the subscription"_ · _"change the billing cycle"_ · _"past due"_ · _"dunning"_ · _"retry the failed charge"_ · _"move them to a different plan"_

**Skip when:**

- money must go back to the customer as well → `epd-refunds`
- the customer does not exist yet → `epd-onboard-customer`

### `epd-refunds`

Issuing refunds — full or partial, on an order or a transaction, optionally with cancellation.

**Triggers on:** _"refund this order"_ · _"refund $"_ · _"give the money back"_ · _"partial refund"_ · _"cancel and refund"_

**Skip when:**

- diagnosing why a charge failed, before deciding anything → `epd-transaction-triage`
- cancelling with no money moving → `epd-subscriptions`

### `epd-transaction-triage`

Read-only diagnosis of a failed charge: soft decline safe to retry, hard decline that must not be, or a config error wearing a decline's clothes.

**Triggers on:** _"why did this fail"_ · _"declined"_ · _"decline code"_ · _"the charge did not go through"_ · _"is it safe to retry"_ · _"do_not_honor"_ · _"insufficient_funds"_

**Skip when:**

- the decision is already made and money must move → `epd-refunds`
- the failure is a subscription dunning cycle → `epd-subscriptions`
- asking about totals over a period rather than one failure → `epd-reporting`

### `epd-webhook-ops`

Operating webhook endpoints on a live account: registration, secret rotation, replay, delivery logs, and version migration.

**Triggers on:** _"register a webhook endpoint"_ · _"rotate the webhook secret"_ · _"replay that event"_ · _"deliveries are failing"_ · _"upgrade the webhook version"_ · _"delivery logs"_

**Skip when:**

- writing or debugging the receiver code itself → `epd-webhooks`

### `epd-coupons`

Discounts end to end: create, validate, bulk-generate codes, archive and unarchive.

**Triggers on:** _"create a coupon"_ · _"promo code"_ · _"discount code"_ · _"generate codes"_ · _"is this code valid"_ · _"archive the coupon"_ · _"launch a promotion"_

**Skip when:**

- changing list price rather than discounting it → `epd-catalog`

### `epd-reporting`

Read-only aggregates: revenue over a period, per-customer financial summaries, month-end reconciliation.

**Triggers on:** _"revenue this month"_ · _"month end"_ · _"reconcile"_ · _"how much did we bill"_ · _"financial summary"_ · _"what has this customer paid us"_

**Skip when:**

- one specific transaction failed → `epd-transaction-triage`

## Disambiguation table

The prompts that could plausibly load two skills, and which one wins.

| Prompt | Wins | Why |
|---|---|---|
| "the payment failed, refund them" | `epd-transaction-triage` | Diagnose before moving money. Triage hands off to epd-refunds once the failure is classified — a hard decline may mean no refund is owed at all. |
| "how do I verify a webhook signature" | `epd-webhooks` | Writing receiver code, not operating an endpoint. |
| "the webhook signature is failing in production" | `epd-webhooks` | Still receiver-side. Only becomes epd-webhook-ops if the fix is rotating the secret. |
| "our webhooks stopped arriving" | `epd-webhook-ops` | Delivery-side. Read the logs before touching the receiver. |
| "charge this customer $50" | `epd-catalog` | A one-off order. epd-onboard-customer only owns the customer record and its cards. |
| "sign up Alice and bill her monthly" | `epd-onboard-customer` | Starts with a customer that does not exist; hands to epd-subscriptions after creation. |
| "cancel and refund them" | `epd-refunds` | Money moves, so the refund skill owns the confirmation. It calls refund_and_cancel. |
| "cancel at period end" | `epd-subscriptions` | No money moves. |
| "this card keeps getting declined on renewal" | `epd-subscriptions` | Dunning, not a one-off failure. Triage explicitly routes recurring failures here. |
| "how much did we make in July" | `epd-reporting` | Aggregate over a period. |
| "why is this $40 charge missing from July" | `epd-transaction-triage` | One transaction, not an aggregate. |
| "set up a 20% off code" | `epd-coupons` | Discount, not list price. |
| "drop the price to $40" | `epd-catalog` | List price, not a discount. |
| "am I about to do this against live?" | `epd-mcp-operator` | Cross-cutting safety, no domain. |

## Collision check

16 skill pairs share at least one trigger term.

### Terms too common to disambiguate

Appearing in three or more skills, so none of them may rely on the word alone:

| Term | Skills |
|---|---|
| `charge` | 4 |

### Pairs sharing vocabulary without an explicit routing rule

None. Every pair sharing two or more trigger terms has an explicit `Skip when` rule
in at least one direction.

### Highest-overlap pairs

`Hops` is the shortest `Skip when` path between the two. 1 means one skill names the
other directly. 3 or more means the route exists on paper but no agent will traverse it —
those pairs are carried by distinct vocabulary, not by routing, so their trigger phrases
must stay disjoint.

| Pair | Shared | Hops | Same surface |
|---|---|---|---|
| `epd-subscriptions` ↔ `epd-transaction-triage` | `retry`, `charge` | 1 | yes |
| `epd-best-practices` ↔ `epd-quickstart` | `charge` | 1 | yes |
| `epd-best-practices` ↔ `epd-onboard-customer` | `card` | 2 | no |
| `epd-best-practices` ↔ `epd-subscriptions` | `charge` | 2 | no |
| `epd-best-practices` ↔ `epd-transaction-triage` | `charge` | 2 | no |
| `epd-quickstart` ↔ `epd-mcp-operator` | `first` | 2 | no |
| `epd-quickstart` ↔ `epd-subscriptions` | `charge` | 3 (weak) | no |
| `epd-quickstart` ↔ `epd-transaction-triage` | `charge` | 3 (weak) | no |
| `epd-webhooks` ↔ `epd-webhook-ops` | `webhook` | 1 | no |
| `epd-mcp-operator` ↔ `epd-transaction-triage` | `safe` | 1 | yes |

4 pair(s) are only reachable in 3+ hops. None share more than one term, so
vocabulary carries them — but none of those shared terms may be used alone as a trigger.

## Notes against the existing six

- `epd-webhooks` already carries a `Skip when ... use workflow skills` clause, but it
  names no specific skill. It should name `epd-webhook-ops` once that exists.
- `epd-best-practices` currently says to skip to "the workflow skills under workflows/".
  With nine workflow skills that is no longer actionable — it should route to
  `epd-mcp-operator`, which then routes onward.
- `epd-onboard-customer` describes itself as covering "first charge or subscription".
  Under this map it owns the customer and its payment methods only; charging is
  `epd-catalog` and recurring is `epd-subscriptions`. Its description narrows.
- `epd-subscriptions` and `epd-refunds` already cross-reference each other correctly;
  both need a new clause pointing at `epd-transaction-triage` for diagnosis.
- All six inherit the safety layer from `epd-mcp-operator` rather than restating it,
  which is what removes the duplication Phase D is budgeted to strip.

