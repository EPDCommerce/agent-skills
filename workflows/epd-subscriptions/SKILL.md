---
name: epd-subscriptions
description: Use when an operator-agent connected to the EPD Commerce MCP server needs to manage the subscription lifecycle on a merchant account — starting subscriptions on existing customers, changing payment method or billing cycle, canceling, and recovering past_due subscriptions through dunning. References MCP tool names (create_subscription, update_subscription, cancel_subscription, cancel_subscription_and_report, list_past_due_subscriptions, retry_failed_charge), not REST endpoints. Triggers when the user says "cancel a subscription", "list past-due subs", "retry the failed charge", or asks to change a customer's plan / payment method on a subscription. Skip when the user is signing up a brand-new customer — load epd-onboard-customer for that.
compatibility: Requires an MCP-connected agent authenticated against an EPD Commerce account; not for direct REST integration.
metadata:
  version: 1.0.0
  api_version: "2026-02-11"
---

# Subscription lifecycle through the EPD Commerce MCP server

You are operating an EPD Commerce merchant account through the MCP server.
Tools used here are MCP tool calls, not REST endpoints. Every tool that
mutates state needs an `idempotency_key` (UUID v4) — same rules as the rest
of EPD Commerce.

This skill picks up where `epd-onboard-customer` left off: a subscription
already exists, and the operator wants to change, recover, or end it.

## Subscription statuses

The MCP surface returns these statuses on subscription objects:

| Status      | Meaning                                                              |
|-------------|----------------------------------------------------------------------|
| `active`    | Currently billing on schedule.                                       |
| `past_due`  | A scheduled charge failed; subscription has not yet been canceled.   |
| `canceled`  | Permanently ended. History preserved; no further billing.            |
| `completed` | Reached `billing_cycles` cap (finite-term subscription finished).    |
| `failed`    | Initial signup payment failed.                                       |

Only `active` subscriptions can be **updated**. Both `active` and `past_due`
can be **canceled**. Calls against `canceled` / `completed` subscriptions
are rejected — don't try to "re-cancel" or "update" a finished one.

> **Pause is not exposed.** A `paused` state exists internally but the
> public surface does not provide a way to enter or leave it. If the user
> asks to pause, model it as cancel-now + create-fresh-later, or escalate to
> dashboard control.

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
  billing_cycles: 12           # optional — finite term; omit for unlimited
  start_date: "2026-06-01"     # optional
  shipping_address_id: <uuid>  # optional, mutually exclusive with shipping_address
  idempotency_key: <UUID v4>
```

Notes:

- `payment_method_id` is the **only** ID on this surface that requires a bare
  UUID with no legacy prefix. Pass it back exactly as `add_payment_method`
  returned it.
- You can provide `shipping_address_id` OR an inline `shipping_address`, not
  both. The server rejects the combination.
- `billing_cycles` caps the subscription at N cycles, after which it
  transitions to `completed`. Omit it for indefinite.

## Changing a subscription

Use `update_subscription` for in-flight changes:

```
tool: update_subscription
input:
  id: <subscription uuid>
  payment_method_id: <new bare uuid>     # swap the card
  billing_cycle:                         # change cadence
    interval: month
    interval_count: 1
  shipping_address_id: <uuid>            # or inline shipping_address
  idempotency_key: <UUID v4>             # optional but recommended
```

Common patterns:

- **Card update after a decline** — set `payment_method_id` to the newly
  vaulted one. Then call `retry_failed_charge` if there's a stuck failed
  transaction (see "Recovering past-due" below).
- **Plan change** — there is no `plan_id` on update. Plan changes are not
  expressed as a single MCP call; they require canceling the current
  subscription and creating a new one on the new plan. Confirm with the user
  before doing this (proration is not handled automatically).
- **Pause / resume** — not available through this surface. See the note in
  "Subscription statuses" above; offer cancel-and-recreate-later instead.

## Cancelling

Two cancel tools, pick the one matching intent:

### `cancel_subscription` — quiet cancel

```
tool: cancel_subscription
input:
  id: <subscription uuid>
  idempotency_key: <UUID v4>
```

Immediate cancellation. History preserved. Idempotent no-op if already
canceled. Use when the user just wants the subscription stopped.

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

Both reject `canceled` / `completed` subscriptions.

### When the user wants "cancel + refund the last payment"

That's a different composite — `refund_and_cancel`. See `epd-refunds` for
the decision tree; do not chain `cancel_subscription` + `refund_order`
yourself when the composite exists.

## Recovering past-due subscriptions (dunning)

When a scheduled charge fails, the subscription enters `past_due`. The
operator's recovery loop:

### 1. Find them

```
tool: list_past_due_subscriptions
input:
  limit: 20                  # default 20, max 100
  starting_after: <cursor>   # optional
```

Returns subscriptions in `past_due` status with `customer` and `plan`
auto-expanded. Page forward with `cursors.next`.

### 2. Find the failed transaction

For each past-due subscription, look up the customer's recent failed
transactions to find the one that triggered the past-due state. Use
`list_transactions` with `customer_id` and `status: failed`.

### 3. Decide on the path

- **Hard card issue** (e.g. `transaction_not_allowed`, `expired_card`,
  `incorrect_cvv`, `invalid_account`, `closed_card`, `lost_stolen_card`,
  `fraud_suspected`) → get a new card on file. In a browser flow, capture a
  `card_token` via EPD Elements and attach it with `add_payment_method`; for
  a headless/back-office update, POST straight to `secure.epd.com` (which
  creates the payment method directly) — see
  `epd-best-practices/references/security.md`. Then update the
  subscription's payment method, then retry.
- **Soft / transient issue** (e.g. `processor_declined`, `insufficient_funds`,
  `issuer_unavailable`, `do_not_honor`) → retry on the same payment method
  with a delay. See `epd-best-practices/references/errors.md` for the
  hard-vs-soft breakdown of every failure reason.

### 4. Retry

```
tool: retry_failed_charge
input:
  transaction_id: <failed transaction uuid>
  payment_method_id: <new bare uuid>     # optional — defaults to original
  idempotency_key: <UUID v4>
```

This **reconstructs the order** from the failed transaction and creates a
**new order** with the same items + customer. The original failed
transaction stays in history (immutable). Returns
`original_transaction_id`, `original_order_id`, and the `new_order`.

Validation: the transaction must be type `sale` and status `failed`. The
tool refuses anything else — don't try to retry a successful or refunded
transaction.

### 5. Confirm what changed

After a successful retry, fetch the subscription again (`get_subscription`)
to confirm it transitioned out of `past_due`.

## Confirmation prompts (destructive operations)

Tools annotated `destructiveHint: true` on this surface:

- `cancel_subscription`
- `cancel_subscription_and_report`
- `update_subscription` (when changing the payment method on a live
  subscription — affects future billing)
- `retry_failed_charge` (moves money)

Always confirm before invoking. Templates:

> "This will cancel the $29.99/month Pro subscription for Alice Liddell,
> effective immediately. No further charges. Proceed?"

> "This will retry the $29.99 charge for Alice that failed on 2026-04-30,
> using the card ending in 4242. Proceed?"

## Idempotency rules

Same as everything else: UUID v4 per logical operation. Retry with the same
key after a network/timeout failure to avoid double-execution.

`update_subscription` accepts `idempotency_key` as optional — pass it
anyway, especially for payment method swaps where the cost of a duplicate
write is real.

## Common operator mistakes

1. **Trying to update a canceled subscription.** Server rejects. Either
   create a new subscription on the same customer, or surface that the
   action isn't possible.
2. **Hand-rolling cancel + refund instead of `refund_and_cancel`.** The
   composite handles partial-failure rollback. Doing it yourself risks a
   "subscription canceled, refund stuck" state. See `epd-refunds`.
3. **Calling `retry_failed_charge` without confirming the failure reason.**
   If the card was declined for fraud or insufficient funds, retrying
   immediately on the same card just produces another decline. Update the
   payment method first.
4. **Treating `past_due` as a permanent state.** It's a workflow state.
   Either retry succeeds (→ `active`) or the operator cancels it (→
   `canceled`). Drive every past-due subscription to a terminal state.

## Where to go next

- Refunds (including `refund_and_cancel`) → `epd-refunds`
- New customer signup → `epd-onboard-customer`
- Customer financial history → `get_customer_financial_summary`
