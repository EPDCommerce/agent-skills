---
name: epd-subscriptions
description: Use when an operator-agent connected to the EPD Commerce MCP server needs to manage the subscription lifecycle on a merchant account — starting subscriptions on existing customers, changing payment method or billing cycle, canceling, and recovering a failed renewal through dunning. References MCP tool names (create_subscription, update_subscription, cancel_subscription, cancel_subscription_and_report, list_subscriptions, retry_order, retry_failed_charge), not REST endpoints. Triggers when the user says "cancel a subscription", "list past-due subs", "the renewal failed", "retry the failed charge", or asks to change a customer's plan / payment method on a subscription. Skip when the user is signing up a brand-new customer — load epd-onboard-customer for that. Skip when money must go back to the customer as well — load epd-refunds. Skip when a one-off charge failed and nobody has diagnosed why yet — load epd-transaction-triage first; any failure on a subscription renewal is dunning and stays here.
compatibility: Requires an MCP-connected agent authenticated against an EPD Commerce account; not for direct REST integration.
metadata:
  version: 1.1.0
  api_version: "2026-02-11"
---

# Subscription lifecycle through the EPD Commerce MCP server

You are operating an EPD Commerce merchant account through the MCP server.
Tools used here are MCP tool calls, not REST endpoints. Idempotency mechanics
are in `epd-mcp-operator`'s idempotency section / `SAFETY.md` rule 3; where a
tool here takes the key as optional, pass it anyway.

This skill picks up where `epd-onboard-customer` left off: a subscription
already exists, and the operator wants to change, recover, or end it.

Tiers come from
[`references/tiers.md`](../epd-mcp-operator/references/tiers.md), generated from
the `tools/list` snapshot by `npm run gen:tiers` so it cannot drift. What each
tier requires is defined once in
[SAFETY.md](https://github.com/EPDCommerce/agent-skills/blob/main/SAFETY.md).
Do not hand-maintain a tier list here.

## Subscription statuses

Across all 130 subscriptions on the sandbox account (18 September 2026) the
statuses were:

| Status      | Meaning                                                              |
|-------------|----------------------------------------------------------------------|
| `active`    | Billing on schedule — **including while a failed renewal is being retried** (see dunning below). |
| `paused`    | Not billing. Exists, but the public surface has no way to enter or leave it. |
| `canceled`  | Permanently ended. History preserved; no further billing.            |
| `completed` | Reached its `billing_cycles` cap (finite-term subscription finished). |

The tool schemas also name `past_due` (as a `status` filter value), and the
REST API reference names both `past_due` and `failed`. Neither occurred. A subscription whose renewal
failed stays `active` and carries `attempt_count` (failures so far) and
`next_retry_at` (when the dunning engine will try again). **Detect dunning by
those two fields, never by status.**

What each change needs, per the tools' own descriptions and checked in
sandbox:

| Change | Allowed from |
|---|---|
| Payment method or shipping (`update_subscription`) | any status except `canceled` / `completed` — applies immediately, including to a queued retry |
| Billing terms — `billing_cycle`, `billing_cycles`, `products` (`update_subscription`) | `active` or `paused`, from the **next** cycle; rejected for migrated subscriptions |
| Cancel (`cancel_subscription`, `cancel_subscription_and_report`) | `active` or `paused` |

Against a `canceled` subscription, `update_subscription` returns
`subscription_not_modifiable`.

> **Pause is not exposed.** If the user asks to pause, model it as
> cancel-now + create-fresh-later, or escalate to dashboard control.

## Starting a subscription on an existing customer

Use `create_subscription` when the customer already exists with a vaulted
payment method. (For signup + first subscription in one call, see
`epd-onboard-customer` and use `create_customer_and_subscribe`.)

```
tool: create_subscription
input:
  customer_id: <uuid>
  plan_id: <uuid>
  payment_method_id: <bare uuid — no prefix>
  billing_cycle:
    interval: month            # "day" or "month"
    interval_count: 1          # 1–365
    anchor_day: 1              # optional, 1–31 (for monthly)
  billing_cycles: 12           # optional — finite term; 0 or omitted = unlimited
  start_date: "2026-06-01"     # optional — defaults to today
  shipping_address_id: <uuid>  # optional, mutually exclusive with shipping_address
  idempotency_key: <UUID v4>
```

Notes:

- `payment_method_id` is the one ID whose schema says outright "bare, no
  prefix". Pass it exactly as `secure.epd.com`, `add_payment_method` or
  `list_payment_methods` returned it.
- You can provide `shipping_address_id` OR an inline `shipping_address`, not
  both. The server rejects the combination.
- `billing_cycles` caps the subscription at N cycles, after which it
  transitions to `completed`.
- `coupon_code` is also accepted, and a failed coupon means no subscription
  is created — see `epd-coupons` before using it.

## Changing a subscription

Use `update_subscription` for in-flight changes:

```
tool: update_subscription
input:
  id: <subscription uuid>
  payment_method_id: <new bare uuid>     # swap the card
  billing_cycle:                         # change cadence, from the next cycle
    interval: month
    interval_count: 1
  shipping_address_id: <uuid>            # or inline shipping_address
  idempotency_key: <UUID v4>             # optional but recommended
```

Common patterns:

- **Card update after a decline** — set `payment_method_id` to the newly
  vaulted one. The server applies it at once, **including to the queued
  retry**, so the dunning engine's next attempt already uses it. See
  "Recovering a failed renewal" before also retrying by hand.
- **Plan change** — there is no `plan_id` on update. `products` can replace
  the recurring product lines from the next cycle, but moving to a different
  *plan* means canceling the current subscription and creating a new one.
  Confirm with the user before doing this (proration is not handled
  automatically).
- **Pause / resume** — not available through this surface. See the note in
  "Subscription statuses" above; offer cancel-and-recreate-later instead.

## Cancelling

Two cancel tools, pick the one matching intent. Both need the subscription to
be `active` or `paused`.

### `cancel_subscription` — quiet cancel

```
tool: cancel_subscription
input:
  id: <subscription uuid>
  cancellation_reason: <a name from the account's reasons catalog>   # optional
  cancellation_notes: "Customer asked by email, ticket 4471"          # optional
  idempotency_key: <UUID v4>
```

Immediate cancellation. History preserved. Use when the user just wants the
subscription stopped.

- `cancellation_reason` is matched, case-insensitively, against the account's
  catalog of cancellation reasons. **Don't invent one**: an unknown value
  returns `invalid_value` and the subscription is **not** canceled. If the
  human gives a reason that might not be in the catalog, put it in
  `cancellation_notes`, which is free text and kept either way.
- Retrying with the **same** key after a timeout replays the cancel. A second
  cancel under a **new** key returns `already_canceled` — the subscription is
  already where you wanted it, but it is an error, not a silent no-op.

### `cancel_subscription_and_report` — cancel + summary

```
tool: cancel_subscription_and_report
input:
  subscription_id: <subscription uuid>
  idempotency_key: <UUID v4>
```

Cancels the subscription **and** returns a billing summary
(`cycles_completed`, `total_billed_cents`, original status, full
subscription object). Use when the user is closing an account and wants the
"so what did this subscription do?" rollup.

Its schema says re-cancelling is "a no-op even without a key". In sandbox it
was not: against an already-canceled subscription it returned
`invalid_state`. Check the status first.

### When the user wants "cancel + refund the last payment"

That's a different composite — `refund_and_cancel`. See `epd-refunds` for
the decision tree; do not chain `cancel_subscription` + `refund_order`
yourself when the composite exists.

## Recovering a failed renewal (dunning)

When a scheduled charge fails, EPD's dunning engine retries it on its own
schedule. The subscription stays `active`; `attempt_count` and
`next_retry_at` change on the subscription and on the failed cycle's order.
The operator's job is to find these, classify the decline, and decide whether
anything should happen **before** the scheduled attempt.

### 1. Find them — filter on the fields, not the status

```
tool: list_subscriptions
input:
  status: active
  limit: 100
  starting_after: <cursors.next from the previous page>   # omit on the first page
```

Keep the rows where `attempt_count > 0` or `next_retry_at` is set.

`list_past_due_subscriptions` looks like the tool for this and cannot be
trusted as-is:

```
tool: list_past_due_subscriptions
input:
  limit: 100                 # default 20
  starting_after: <cursor>   # optional
```

On 18 September 2026 it returned **all 130** sandbox subscriptions — active,
canceled, completed and paused — none of them `past_due`, because no
subscription has that status and the filter behind it is dropped silently
(`list_subscriptions` with `status: past_due` returns everything too). Acting
on its output would put healthy and already-canceled subscriptions into a
retry loop. It does expand `customer` and `plan`, which saves calls — but
apply the same `attempt_count` / `next_retry_at` filter to every row it
returns.

### 2. Find the failed cycle and its order

```
tool: get_subscription
input:
  id: <subscription uuid>
  expand: cycles
```

`cycles` lists each billing cycle with `cycle_number`, `status`, `amount` and
`order_id`. Take the `failed` one's `order_id`:

```
tool: get_order
input:
  id: <failed cycle's order uuid>
  expand: transactions
```

The order carries the decline (`failure_code`, `failure_reason`), the retry
state (`attempt_count`, `next_retry_at`), `subscription_id` /
`subscription_cycle`, and in `transactions` the failed `sale` transaction.

### 3. Classify before anything moves

Hand the order to `epd-transaction-triage` — it is read-only and owns the
soft / hard / ambiguous classes for the observed decline codes. The class
decides the path:

| Triage class | Path |
|---|---|
| Soft — `insufficient_funds`, `issuer_unavailable`, `card_limit_exceeded` | Same card. Default: let the attempt at `next_retry_at` run. Retry now (4a) only if the human asks — `issuer_unavailable` is the one where soon is reasonable. |
| Hard — `expired_card`, `transaction_not_allowed` — and `incorrect_cvv` | New card (4b). Retrying the same card cannot work. |
| `lost_stolen_card` | New card (4b), and **no retry** of the old one by any route. |
| Ambiguous — `do_not_honor`, `processor_declined` | At most one more attempt on the same card, later. A repeat of the same code means a new card. |

### 4a. Retry now on the same card — `retry_order`

```
tool: retry_order
input:
  order_id: <failed cycle's order uuid>
  idempotency_key: <UUID v4>
```

`epd-catalog` documents this tool; the subscription angle is why it is the
right one here. Per its own description it re-charges the **order's** card on
file (no card switch) and, because subscription cycles are orders, on success
it "reconciles the cycle so the dunning cron will not charge the customer
again". A manual retry that does not reconcile the cycle is how a customer
gets charged twice.

### 4b. New card — swap it, then let the schedule use it

1. Get the new card on file — `add_payment_method` with a browser
   `card_token`, or `secure.epd.com` for a headless update. Both are
   documented in `epd-onboard-customer`.
2. `update_subscription` with the new `payment_method_id`. It applies at
   once, including to the queued retry.
3. **Default: let the attempt at `next_retry_at` run.** It will use the new
   card, and it is the engine's own cycle, so there is nothing to reconcile.

If the human wants the new card charged now rather than at `next_retry_at`,
the only tool that retries on a different card is `retry_failed_charge`:

```
tool: retry_failed_charge
input:
  transaction_id: <the failed sale transaction's uuid>
  payment_method_id: <new bare uuid>     # optional — omit to reuse the original card
  idempotency_key: <UUID v4>
```

It **reconstructs the order** from the failed transaction and creates a
**new order** with the same items and customer, returning
`original_transaction_id`, `original_order_id` and `new_order`. The
transaction must be a `sale` in `failed` status; anything else is refused.

Unlike `retry_order`, its description says nothing about reconciling the
subscription cycle — and after step 2 the scheduled attempt would charge the
same new card. So say this before running it, and afterwards read the
original cycle's order: if `next_retry_at` is still set, tell the human a
second attempt is scheduled rather than assuming it will be skipped. When in
doubt, the scheduled attempt is the safer route.

### 5. Confirm what changed

Read the subscription again with `expand: cycles` and check the failed
cycle's `status` and the order's `next_retry_at` before telling the human
it is recovered. Drive every one to an end state — recovered, or canceled by
decision — rather than leaving it in the retry loop.

## Confirmation prompts

Tiers and which tools are destructive come from `references/tiers.md` — see
the pointer above; do not hand-list them here. `cancel_subscription`,
`cancel_subscription_and_report`, `retry_order` and `retry_failed_charge` are
T3. Confirm each using the pattern in `epd-mcp-operator`'s "Running a
confirmation" section.

`update_subscription` is **T2**, not destructive — the server does not
annotate a payment-method or billing-cycle change as `destructiveHint`.
Confirming it anyway before a payment-method swap on a live subscription is
still good practice, since it affects future billing and the queued retry —
but that is an operator judgment call, not a server-stated requirement. Say
so if you apply it, rather than citing it as a tier fact.

Templates:

> "This will cancel the $29.99/month Pro subscription for Alice Liddell,
> effective immediately. No further charges. Proceed?"

> "This will retry the $29.99 charge for Alice that failed on 2026-04-30,
> on the card ending in 4242 that's already on the order. It reconciles
> that billing cycle, so the scheduled retry won't also charge her. Proceed?"

## Common operator mistakes

1. **Trying to update a canceled subscription.** Server rejects it with
   `subscription_not_modifiable`. Either create a new subscription on the
   same customer, or surface that the action isn't possible.
2. **Hand-rolling cancel + refund instead of `refund_and_cancel`.** The
   composite cancels first and reports a failed refund with the order to
   retry; doing it yourself risks a "subscription canceled, refund stuck"
   state with nothing to show for it. See `epd-refunds`.
3. **Retrying before classifying.** An expired or lost/stolen card fails the
   same way every time — and repeated attempts on a card reported
   lost/stolen are what fraud monitoring looks for. `insufficient_funds` is
   the opposite case: the card is fine and a new one is not needed, but an
   immediate retry fails for the same reason. Classify first (step 3).
4. **Trusting `list_past_due_subscriptions`, or `status: past_due`.** Both
   return every subscription today. Filter on `attempt_count` /
   `next_retry_at`.
5. **Retrying by hand on top of a scheduled retry.** If `next_retry_at` is
   set, the engine will try again. Use `retry_order`, which reconciles the
   cycle, or let the schedule run — not a fresh order for the same amount.
6. **Guessing a `cancellation_reason`.** An unknown one blocks the cancel.
   Use `cancellation_notes` for free text.

## Where to go next

- Refunds (including `refund_and_cancel`) → `epd-refunds`
- New customer signup, or a new card on file → `epd-onboard-customer`
- Diagnosing why a charge failed → `epd-transaction-triage`
- Customer financial history, revenue totals → `epd-reporting`
