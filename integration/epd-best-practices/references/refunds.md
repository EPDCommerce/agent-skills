# Refunds

EPD Commerce exposes **one** REST refund primitive — `POST /v1/orders/{id}/refund` —
and two MCP composites for higher-level flows. The right choice depends on
**what you have** (an order vs. a specific transaction) and **what you want
to do** (just refund, or refund + cancel a subscription).

## Decision tree

```
Need to refund...
│
├── An order (the typical case)?
│       → REST: POST /v1/orders/{order_id}/refund
│       (EPD Commerce picks underlying transactions to refund against)
│
├── A specific transaction (multi-capture flow, partial transaction refund)?
│       → MCP only: refund_transaction
│       (no REST equivalent — there is no
│       POST /v1/transactions/{id}/refund endpoint)
│
└── A subscription's last charge AND cancel future billing?
        → MCP only: refund_and_cancel
          (in REST: refund the order, then DELETE the subscription)
```

## Refund an order — `POST /v1/orders/{order_id}/refund`

The most common case. EPD Commerce figures out which transactions to refund.

```http
POST /v1/orders/{order_id}/refund HTTP/1.1
Authorization: Bearer epd_test_sk_...
EPD-Version: 2026-02-11
X-EPD-Idempotency-Key: <uuid v4>
Content-Type: application/json

{
  "amount": 1500
}
```

Body:

| Field    | Required | Notes                                                                                                 |
|----------|----------|-------------------------------------------------------------------------------------------------------|
| `amount` | no       | Integer cents, 1–99,999,999. Omit for a **full refund**. Server-validated; >outstanding returns 400.  |

> The DTO is `amount`-only. **Do not send `reason`, `metadata`, or other
> fields** — `forbidNonWhitelisted` is on and any extra property returns
> `validation_error`. If you need a free-text note, log it on your side
> against the returned refund-transaction ID.

Response:

```json
{
  "id": "<refund txn uuid>",
  "object": "transaction",
  "type": "refund",
  "status": "succeeded",
  "amount": 1500,
  "order_id": "<order uuid>",
  "created_at": "2026-05-08T15:00:00Z"
}
```

After a partial refund, the order's `status` becomes `partially_refunded`.
After a full refund (cumulative amount across multiple partial refunds equals
the order total), it becomes `refunded`.

You can call this endpoint multiple times until the cumulative refund amount
equals the order total. Each call needs a **new** idempotency key (each refund
is a distinct logical operation).

## Refund a specific transaction — MCP only

There is **no REST endpoint** to refund a single transaction. If you need
transaction-level granularity (multi-capture flows, refunding a specific
capture out of several on the same order), use the MCP tool
`refund_transaction` against an MCP-connected agent.

From a pure REST integration, refund at the order level instead — EPD
Commerce picks which underlying transactions to settle the refund against.

## Refund + cancel subscription (MCP only)

For "the customer wants their last charge back AND don't bill them again":

- **MCP**: `refund_and_cancel` — one tool call, one idempotency key, atomic.
- **REST**: chain two requests:

  ```http
  POST   /v1/orders/{last_order_id}/refund        # idempotency key A
  DELETE /v1/subscriptions/{sub_id}               # idempotency key B
  ```

  If the refund succeeds and the cancel fails, you have a refunded order on
  an active subscription. Implement compensation: poll for the cancel to
  succeed, or surface the partial-failure to the support agent.

## Idempotency on refunds

Refunds are the **easiest** place to double-charge your customer in reverse —
issuing two refunds when the customer should only have gotten one. Always:

- Generate a fresh idempotency key per refund logical operation.
- On 5xx or network failure, **retry with the same key**. EPD Commerce returns
  the cached refund record, no double-refund.
- A `200` response with `status: "succeeded"` means the refund hit. Trust it.

## Constraints

- You cannot refund an order in `failed`, `pending`, or `voided` status.
- You cannot refund more than the order's outstanding (post-refund) amount —
  attempts return `400 amount_exceeds_refundable`.
- You cannot refund a chargeback. Chargebacks are handled by the issuer; the
  funds have already been pulled by the network.
- A refund may take **5–10 business days** to appear on the customer's
  statement. The EPD Commerce response is immediate; the bank's ledger update isn't.

## Webhooks for refunds

If you have webhooks configured (see `epd-webhooks` skill), refunds emit:

- `transaction.refunded` — fires when a refund transaction succeeds.
- `order.refunded` — fires when an order's cumulative refunds reach the total.
- `order.partially_refunded` — fires on partial refunds.

Use these to update your own database / accounting system. Don't rely on the
synchronous response alone if your reconciliation is downstream.

## Common bugs to avoid

1. **Forgetting to bump the idempotency key on second refund of same order.**
   You issued a $15 refund yesterday. Today you want to refund another $10.
   Reusing yesterday's key + new body → 422 `idempotency_key_mismatch`.
   Generate a new key per refund.
2. **Refunding then canceling a subscription, in either order, without a
   compensation path.** If step 2 fails, you're in a partial state. Either
   use the MCP composite if you have access, or build retry/compensation
   logic for the second step.
3. **Treating `partially_refunded` as a terminal state.** It isn't — you can
   issue more refunds against the same order until cumulative = total.
4. **Storing the original `amount` instead of `outstanding amount`.** When
   computing "is this fully refunded yet?", compare against the order's
   current outstanding, not the original total.

## Where to go next

- Webhook events for refund completion → `epd-webhooks` skill
- Error codes (`amount_exceeds_refundable`, etc.) → `errors.md`
