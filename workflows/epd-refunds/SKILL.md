---
name: epd-refunds
description: Use when an operator-agent connected to the EPD Commerce MCP server needs to issue a refund — full or partial, on an order or transaction, optionally combined with subscription cancellation. References MCP tool names (refund_order, refund_transaction, refund_and_cancel), not REST endpoints. Triggers when the user says "refund this order", "refund $X to the customer", "cancel the subscription and refund the last charge", or asks about partial refunds. Skip when the user wants to cancel a subscription without a refund — load epd-subscriptions for that.
compatibility: Requires an MCP-connected agent authenticated against an EPD Commerce account; not for direct REST integration.
metadata:
  version: 1.0.0
  api_version: "2026-02-11"
---

# Refunds through the EPD Commerce MCP server

You are operating an EPD Commerce merchant account through the MCP server. Refunds
move money in the customer's direction and are **irreversible** — every
tool here is annotated `destructiveHint: true`. Confirm with the user before
invoking.

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
  prior partial refunds. Going over is rejected.
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

1. **Cancel** the subscription. Allowed from `active` or `past_due`;
   rejected against `canceled` / `completed`.
2. **Full refund** on the customer's most recent **succeeded** order.

Cancellation runs first so billing stops even if the refund half hits an
issue.

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

1. `list_orders` filtered by `customer_id`, sorted desc by `created_at`.
2. Find the most recent `succeeded` order.
3. Call `refund_order` on it.

`refund_and_cancel` is specifically the subscription-closeout composite —
using it for non-subscription refunds is the wrong tool.

### Partial refund accounting

Multiple partial refunds on the same order are allowed as long as the
total stays at or under the original amount. The server tracks this; you
don't need to.

## Confirmation prompts (always required)

Refunds move money out of the merchant's account. Confirm before invoking
any tool here. Templates:

> "This will refund $15.00 to Alice Liddell on order <id>. The charge was
> originally $29.99, so $14.99 will remain on the order. Proceed?"

> "This will refund the full $29.99 on order <id> to Alice Liddell.
> Proceed?"

> "This will cancel Alice's $29.99/month Pro subscription AND refund her
> most recent payment of $29.99. The subscription will end immediately and
> she won't be billed again. Proceed?"

After execution, surface the refund ID / order ID so the user can locate it
in the dashboard.

## Idempotency rules

UUID v4 per logical refund operation. **Always pass it.** Retrying a
refund without the same key risks a duplicate refund. The composite
(`refund_and_cancel`) caches the whole chain's result under one key — a
retry of a half-completed composite returns the partial-failure response,
not a fresh execution.

## Common operator mistakes

1. **Skipping confirmation on refund tools.** All three are
   `destructiveHint: true`. Always confirm.
2. **Passing dollar amounts instead of cents.** `amount: 29.99` is wrong;
   `amount: 2999` is right. The server will reject decimals, but if you
   typed `2999` thinking it was $2,999 you just refunded a hundred times
   too much.
3. **Using `refund_and_cancel` for a non-subscription refund.** It will
   either reject (no subscription) or do something the user didn't ask
   for. Use `refund_order` instead.
4. **Recycling an idempotency key across different refund attempts.** A
   different body with the same key returns `idempotency_key_mismatch`.
   New intent → new key. Same intent retry → same key.
5. **Issuing a partial refund larger than what's left.** The server
   rejects this — partial refunds across the same order can't exceed the
   original amount. Check `get_order` if uncertain.

## Where to go next

- Subscription lifecycle (cancel without refund, retry past_due) →
  `epd-subscriptions`
- Customer financial history → `get_customer_financial_summary`
- Order/transaction lookup → `list_orders`, `list_transactions`,
  `get_order`, `get_transaction`
