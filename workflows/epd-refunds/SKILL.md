---
name: epd-refunds
description: Use when an operator-agent connected to the EPD Commerce MCP server needs to issue a refund — full or partial, on an order or transaction, optionally combined with subscription cancellation. References MCP tool names (refund_order, refund_transaction, refund_and_cancel), not REST endpoints. Triggers when the user says "refund this order", "refund $X to the customer", "cancel the subscription and refund the last charge", or asks about partial refunds. Skip when the user wants to cancel a subscription without a refund — load epd-subscriptions for that. Skip when a charge failed and nobody has diagnosed why yet — load epd-transaction-triage first. Skip when the user is writing backend code against api.epd.com rather than operating an account — "how do I refund an order" is epd-best-practices, "refund order A1B2C3D4" is this skill.
compatibility: Requires an MCP-connected agent authenticated against an EPD Commerce account; not for direct REST integration.
metadata:
  version: 1.2.0
  api_version: "2026-02-11"
---

# Refunds through the EPD Commerce MCP server

You are operating an EPD Commerce merchant account through the MCP server. Refunds
move money in the customer's direction and are **irreversible** — the three
refund tools, `refund_order`, `refund_transaction` and `refund_and_cancel`, are
annotated `destructiveHint: true`. Confirm with the user before invoking them.
The lookups used to find the order (`get_order`, `list_orders`,
`list_transactions`) are read-only.

Tiers come from
[`references/tiers.md`](../epd-mcp-operator/references/tiers.md), generated from
the `tools/list` snapshot by `npm run gen:tiers` so it cannot drift. What each
tier requires is defined once in
[SAFETY.md](https://github.com/EPDCommerce/agent-skills/blob/main/SAFETY.md).
Do not hand-maintain a tier list here.

## Decision tree — which tool

EPD Commerce exposes three refund tools. They look similar but apply in different
situations:

| Situation                                                          | Tool                  |
|--------------------------------------------------------------------|-----------------------|
| User has an `order_id` and wants to refund it                      | `refund_order`        |
| User has a `transaction_id` (e.g. from `list_transactions`)        | `refund_transaction`  |
| User wants to cancel a subscription AND refund the last payment    | `refund_and_cancel`   |

The first two are nearly equivalent — `refund_transaction` resolves the
linked order and then runs the same refund logic. Use whichever matches the
ID the user has in hand.

## `refund_order` — refund by order ID

```
tool: refund_order
input:
  order_id: <order uuid>
  amount: 1500                # optional, in cents — omit for full refund
  idempotency_key: <UUID v4>
```

- `amount` is in **cents**, not dollars. `1500` means $15.00.
- Omit `amount` for a full refund of the order.
- Partial refunds are allowed up to the original order amount minus any
  prior partial refunds. Going over is rejected. Measured on 29 September
  2026: 50 of 150 left the order `partially_refunded`; 150 more returned
  `validation_error`, "Refund amount (150 cents) exceeds maximum refundable
  amount (100 cents)."; `100.5` returned `invalid_type`; the remaining 100 left
  it `refunded`.
- Idempotency is critical here — retrying without the same key risks a
  double refund.

## `refund_transaction` — refund by transaction ID

```
tool: refund_transaction
input:
  transaction_id: <transaction uuid>
  amount: 1500                # optional, in cents — omit for full refund
  idempotency_key: <UUID v4>
```

What it does:

1. Looks up the transaction.
2. Validates it's type `sale` (rejects auth/refund/other types — you can't
   refund a refund).
3. Resolves the linked `order_id`. **Rejects if the transaction has no
   order_id** (rare, but happens for legacy or directly-created
   transactions).
4. Calls the same refund logic as `refund_order`.
5. Returns `transaction_id`, `order_id`, and the refund result.

Use this when the operator is paging through transactions
(`list_transactions`) and needs to refund the underlying charge without
having to fetch the order first.

## `refund_and_cancel` — composite for subscription closeout

Use when the user wants to **end a subscription and undo the last
payment** in one operation — e.g. a customer asking for a "full
cancellation and refund."

```
tool: refund_and_cancel
input:
  subscription_id: <subscription uuid>
  idempotency_key: <UUID v4>
```

Two-phase composite:

1. **Cancel** the subscription. The tool's own description names an
   **active** subscription. An already-canceled one is refused with
   `invalid_state` and nothing is refunded (checked in sandbox,
   18 September 2026). A subscription in dunning is still `active` — there is
   no separate past-due status to check for.
2. **Full refund** on the customer's most recent **succeeded** order. Read
   that order first (`list_orders` below) so the confirmation can name the
   amount — the tool does not take one.

**It is the customer's most recent order, not the subscription's.** Measured on
29 September 2026: with a one-off order placed after the subscription's first
charge, `refund_and_cancel` refunded the one-off and left the subscription's
charge untouched. So read the customer's newest succeeded order and check its
`subscription_id`. If it is not this subscription's charge, do not use the
composite: cancel through `epd-subscriptions` and refund the right order with
`refund_order`, each with its own confirmation.

Cancellation runs first so billing stops even if the refund half hits an
issue. On success the response reads `status: "canceled_and_refunded"`, with
`cancel_status` and `refund_status` both `"succeeded"`, `refunded_order_id`,
`refunded_amount_cents`, and the refunded order under `refund` — measured.

### Partial-failure response shape

If cancel succeeds but refund fails:

```json
{
  "success": false,
  "status": "canceled_refund_pending",
  "subscription_id": "<uuid>",
  "order_id_pending_refund": "<uuid>",
  "refund_status": "failed",
  "error": {
    "type": "...",
    "code": "...",
    "message": "..."
  }
}
```

The subscription is **already canceled** (no rollback — that's intentional;
the user wanted billing stopped). The operator's job is to surface the
`order_id_pending_refund` and let the user decide whether to retry the
refund manually (with `refund_order`) or write it off.

If both succeed:

```json
{
  "success": true,
  "subscription_id": "<uuid>",
  "refund_status": "succeeded",
  "refund": { ... }
}
```

If cancel itself fails (e.g. subscription was already canceled), neither
step commits — the response describes which precondition was violated.

## Notable quirks

### No refund without an order

The EPD Commerce refund flow goes through the order. Standalone transactions without
an `order_id` can't be refunded via these tools — the call returns an
error. If the operator hits this, escalate to the dashboard or EPD Commerce support.

### "Refund the last charge" without a subscription

If the user says "refund the customer's last payment" (no subscription
context), don't reach for `refund_and_cancel`. Instead:

```
tool: list_orders
input:
  customer_id: <customer uuid>
  status: succeeded,partially_refunded
  sort: created_at[desc]
  limit: 1
```

1. Take the one order returned. `partially_refunded` is included because
   what is left on it is still refundable.
2. Read its `total` and any earlier refunds (`get_order` with
   `expand: transactions` — refunds show as `type: "refund"` with negative
   amounts) so the confirmation states what is actually left.
3. Call `refund_order` on it.

Check the `status` of what comes back. An unrecognised status value in a
list filter is dropped silently rather than rejected (see
`epd-subscriptions`), so never refund an order just because a filtered list
returned it.

`refund_and_cancel` is specifically the subscription-closeout composite —
using it for non-subscription refunds is the wrong tool.

### Partial refund accounting

Multiple partial refunds on the same order are allowed as long as the
total stays at or under the original amount. The server tracks this; you
don't need to.

A second **full** refund of an order is refused:
`invalid_state_transition`, "Cannot refund order. Current status: refunded."
— measured on 28 September 2026. It means the first one landed. Nothing to
retry, and not a failure to report as one.

## Confirmation prompts

All three tools here are T3 (see `references/tiers.md`) — confirm using the
pattern in `epd-mcp-operator`'s "Running a confirmation" section: read the
object first, then echo the exact amount, currency, object ID and mode.
Refund-specific templates:

> I'm about to call **`refund_order`** on order `<id>` for **$15.00 USD** to
> Alice Liddell's Visa ending 1111, in **<mode>** mode. The charge was
> $29.99, so $14.99 will remain on the order. This is irreversible. Proceed?

> I'm about to call **`refund_order`** on order `<id>` for the full
> **$29.99 USD** to Alice Liddell, in **<mode>** mode. This is irreversible.
> Proceed?

> I'm about to call **`refund_and_cancel`** on subscription `<id>`. It
> cancels Alice's $29.99/month Pro subscription immediately, then refunds her
> most recent payment — **$29.99 USD** on order `<id>`, which is this
> subscription's charge — in **<mode>** mode. She won't be billed again. This
> is irreversible. Proceed?

After execution, surface the refund ID / order ID so the user can locate it
in the dashboard.

**Then say "issued", not "returned".** The order reads `refunded` (or
`partially_refunded`) at once, but the refund transaction starts `pending` —
measured on 28 September 2026 — and a pending refund is counted in no revenue
total until it settles. Tell the human, and through them the customer, that the
refund was issued on that date. "The money is back in your account" is a claim
the API has not made.

## Idempotency

Mechanics are in `epd-mcp-operator`'s idempotency section / `SAFETY.md` rule 3.
One thing specific to this skill: `refund_and_cancel` caches the **whole
chain's** result under one key — retrying a half-completed composite returns
the partial-failure response, not a fresh execution. Measured on the success
path on 29 September 2026: the same key returned the identical response, and a
new key returned `invalid_state`, "Subscription is in "canceled" status and
cannot be canceled.", refunding nothing.

## Common operator mistakes

1. **Passing dollar amounts instead of cents.** `amount: 29.99` is wrong;
   `amount: 2999` is right. The server will reject decimals, but if you
   typed `2999` thinking it was $2,999 you just refunded a hundred times
   too much.
2. **Using `refund_and_cancel` for a non-subscription refund.** It will
   either reject (no subscription) or do something the user didn't ask
   for. Use `refund_order` instead.
3. **Issuing a partial refund larger than what's left.** The server
   rejects this — partial refunds across the same order can't exceed the
   original amount. Check `get_order` if uncertain.

## Where to go next

- Subscription lifecycle (cancel without refund, recover a failed renewal) →
  `epd-subscriptions`
- Order/transaction lookup, or diagnosing a failure before refunding →
  `epd-transaction-triage`
- Revenue or customer financial totals → `epd-reporting`
