# Composite tools — what they chain, and when not to use them

Eleven of the 67 tools chain several primitives into one call. The MCP server's
own `instructions` block tells every session to prefer them. That is usually
right, and wrong in two specific ways that this file exists to cover.

## When a composite beats the primitives

- **Fewer round trips.** The data bucket allows 60 requests/minute and the
  global bucket 1000/hour. A composite that replaces three calls costs one.
- **One idempotency key for the whole operation** instead of one per step, with
  no window between steps where a retry could half-apply.
- **The multi-step logic is tested.** Reconstructing `retry_failed_charge` by
  hand means re-deriving an order from a failed transaction, and getting that
  subtly wrong charges the wrong amount.

## All eleven

| Tool | Tier | Replaces | `idempotency_key` |
|---|---|---|---|
| `create_customer_and_charge` | T3 | `create_customer` + `add_payment_method` + charge | required |
| `create_customer_and_subscribe` | T3 | `create_customer` + `add_payment_method` + `create_subscription` | required |
| `process_order` | T3 | customer validation + `create_order` | required |
| `refund_transaction` | T3 | `get_transaction` + resolve order + `refund_order` | required |
| `refund_and_cancel` | T3 | `cancel_subscription` + `refund_order` | required |
| `retry_failed_charge` | T3 | `get_transaction` + rebuild order + charge | required |
| `cancel_subscription_and_report` | T3 | `cancel_subscription` + billing summary | optional |
| `setup_webhook_monitoring` | T2 | `create_webhook_endpoint` pre-scoped | optional |
| `get_customer_financial_summary` | T0 | profile + payment methods + subscriptions + orders + transactions | — |
| `get_revenue_summary` | T0 | aggregate over `list_transactions` | — |
| `list_past_due_subscriptions` | T0 | `list_subscriptions` filtered to `past_due` | — |

Seven of the eleven are T3 destructive, three are T0 reads, and one is a T2
write. A composite is not a lighter-weight call because it is convenient — more
often it is the heaviest thing on the surface.

## The two that cannot be used headlessly

`create_customer_and_charge` and `create_customer_and_subscribe` both **require**
`card_token` (`^cct_[0-9a-f]{48}$`), which only the EPD Elements SDK running in a
browser can mint. There is no fixture value and no server-side way to produce
one.

They are therefore unreachable from an MCP session with no browser in the loop —
and they are exactly the composites an onboarding agent would reach for first,
which is why the server's "prefer composites" hint is actively misleading here.

**Use the primitives instead:**

```
1. create_customer             (MCP)   -> customer_id
2. POST https://secure.epd.com (REST)  -> payment_method_id
   {"customer_id": "...", "card": {"number","exp_month","exp_year","cvc"}}
3. create_order | create_subscription  (MCP, with payment_method_id)
```

Verified end to end against sandbox on 27 August 2026 (order created, status
`succeeded`). Evidence is recorded in `audit/COVERAGE.md`; specific ids are kept
out of the published skill.

Two cautions on that path:

- Step 2 is the only step in this repository that handles a card number, and the
  only one that leaves the MCP surface. `secure.epd.com` is PCI-scoped; the MCP
  tools deliberately are not. See [`SAFETY.md` rule 8](../../SAFETY.md).
- **Step 2 cannot be safely retried.** With the same key and a byte-identical
  body it returns `409 idempotency_key_conflict`. On a timeout, call
  `list_payment_methods` for the customer and look for the card before doing
  anything else.

Reserve the two `card_token` composites for integrations that genuinely run in a
browser. There they are the better choice: one call, one key, automatic rollback.

## Failure contracts differ — read before you retry

The server instruction implies composites behave alike on partial failure. They
do not. Four of them state different contracts in their own descriptions:

| Tool | On partial failure |
|---|---|
| `create_customer_and_charge` | Customer + payment method **rolled back**. If the rollback itself fails, `partial_rollback_failed` with the orphaned `customer_id`. |
| `create_customer_and_subscribe` | Same — rolled back, `partial_rollback_failed` with orphaned IDs. |
| `process_order` | **No rollback.** The order row persists with `status: "failed"` so the attempt can be audited. |
| `refund_and_cancel` | **Partially commits.** Cancellation runs first. If the refund then fails, `refund_status: "failed"` carries the original order ID and the subscription stays cancelled. |

So a failed composite leaves one of three states: nothing changed, a failed row
you must not read as nothing, or a half-applied change where the irreversible
part already happened.

**Never re-issue a failed composite on the assumption it was atomic.**
`refund_and_cancel` is the sharpest case — retrying after a refund failure tries
to cancel an already-cancelled subscription while the customer is still owed
money. The response tells you to retry *the refund*, by order ID, not the
composite.

## Per-tool notes

### `get_revenue_summary` — check `truncated`

Paginates up to 10,000 transactions per side (sales and refunds). Beyond that it
sets `"truncated": true` and the totals are **incomplete**.

Reporting a truncated total as the month's revenue is a wrong number delivered
confidently. Always read the flag; if set, narrow the date range and sum the
parts.

### `setup_webhook_monitoring` — the secret is shown once

The signing secret is returned in the response and **will not be shown again**.
If it is not captured at that moment it cannot be recovered — only
`rotate_webhook_secret` (T3) will issue a new one, invalidating the old.

So this is the one place an agent must surface a secret to the human rather than
discard it. Present it, say plainly that it will not be shown again, and do not
write it into a summary that gets logged.

### `retry_failed_charge` — can target a different card

Takes an optional `payment_method_id`. Omit it to retry the original card;
supply one to charge a different card. That is the difference between retrying a
temporary decline and acting on a customer's new card, and the confirmation
should say which is happening.

### `refund_transaction` vs `refund_order`

`refund_transaction` takes a `transaction_id`, resolves the linked order, and
refunds it. Use it when the failure you are looking at is a transaction; use
`refund_order` when you already hold the order.

### `cancel_subscription_and_report`

The only T3 composite where `idempotency_key` is optional. Pass it anyway.
Returns cycles completed and total billed, which makes it the better choice over
plain `cancel_subscription` when anyone will ask about revenue impact.

### `get_customer_financial_summary`

T0 and the cheapest way to answer "what is going on with this customer" — one
call instead of four. `include_transactions` and `transaction_limit` control the
size of the response; keep it small unless the transactions are the point.

## When not to use a composite

- You cannot call it (the two `card_token` tools, headless).
- You have not read what it does on partial failure.
- You need a field it does not expose. `create_order` supports `coupon_code` and
  shipping; `process_order` does not, and is a higher tier for less.
