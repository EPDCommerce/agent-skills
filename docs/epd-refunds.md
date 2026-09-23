---
skill: epd-refunds
surface: workflow
guide_version: 1.0.0
api_version: "2026-02-11"
---

# epd-refunds — guide

**Skill:** [`workflows/epd-refunds/SKILL.md`](../workflows/epd-refunds/SKILL.md) ·
**Policy:** [`SAFETY.md`](../SAFETY.md) ·
**Safety layer:** [`epd-mcp-operator`](./epd-mcp-operator.md)

Money going back to a customer. Three tools, all T3, all irreversible. This is
the smallest workflow skill in the repository and the one with the least room
for improvisation.

## What it does

Picks between three refund tools and gets the confirmation right before using
one.

| The operator has | Tool | Notes |
|---|---|---|
| An `order_id` | `refund_order` | The default. |
| A `transaction_id` | `refund_transaction` | Resolves the linked order, then runs the same logic. |
| A subscription to close out **and** refund | `refund_and_cancel` | Two-phase composite. Cancel runs first. |

The first two are nearly equivalent — `refund_transaction` looks up the
transaction, validates it is type `sale` (you cannot refund a refund), resolves
the linked `order_id`, and calls the same code. Use whichever matches the ID in
hand rather than fetching one to get to the other.

`amount` is optional on both and is in **minor units**. Omit it for a full
refund. Partial refunds are allowed up to the original amount minus prior
partial refunds; the server tracks the running total, so the operator does not
have to.

### `refund_and_cancel` is not atomic, and that is deliberate

Cancellation runs first, so billing stops even if the refund half fails. If it
does fail, the response is:

```json
{
  "success": false,
  "status": "canceled_refund_pending",
  "subscription_id": "<uuid>",
  "order_id_pending_refund": "<uuid>",
  "refund_status": "failed",
  "error": { "type": "...", "code": "...", "message": "..." }
}
```

The subscription is **already canceled** and there is no rollback. The
operator's job at that point is to surface `order_id_pending_refund` and let the
human decide between retrying with `refund_order` and writing it off.

Two things the skill insists on around this composite:

- It takes **no amount**. Read the order first (`list_orders` filtered to
  `succeeded,partially_refunded`, newest first) so the confirmation can name the
  figure the customer will actually see.
- It caches the **whole chain** under one idempotency key. Retrying a
  half-completed composite returns the partial-failure response, not a fresh
  execution. Re-issuing it after a refund failure would attempt to cancel an
  already-cancelled subscription while the customer is still owed money.

An already-canceled subscription is refused with `invalid_state` and nothing is
refunded — measured in sandbox on 18 September 2026. A subscription in dunning
is still `active`; there is no separate past-due status to check for.

## When it fires

- *"Refund this order."* · *"Refund $X to the customer."*
- *"Cancel the subscription and refund the last charge."*
- Questions about partial refunds.

### What it must not answer

| Near miss | Goes to |
|---|---|
| Cancel a subscription with **no** refund | [`epd-subscriptions`](./epd-subscriptions.md) |
| A charge failed and nobody has diagnosed why | [`epd-transaction-triage`](./epd-transaction-triage.md) first |
| *"How do I refund an order?"* — writing code | [`epd-best-practices`](./epd-best-practices.md) |
| *"Refund order A1B2C3D4"* — operating an account | here |

That last pair is the code-versus-operate boundary, and it is the easiest
routing mistake in the repository because the vocabulary is identical on both
sides. It was missing from this skill's own description until Phase D, even
though `epd-mcp-operator` uses "how do I refund an order" as its example of the
mistake and only `epd-onboard-customer` guarded against it. Guessing wrong means
generating a code snippet for someone who wanted money moved, or moving money
for someone who wanted a snippet.

## What it refuses to do, and why

| Refusal | Why |
|---|---|
| **Refund before diagnosing a failure.** | A hard decline may mean nothing was captured and no refund is owed. Refunding an order that never took money is a support conversation about a refund that does not exist. |
| **Use `refund_and_cancel` for a non-subscription refund.** | It will either reject or do something nobody asked for — ending a subscription is not a side effect anyone should discover afterwards. |
| **Issue a partial refund larger than what remains.** | The server rejects it, but the reason to state the arithmetic in the confirmation is that `amount: 29.99` and `amount: 2999` are both plausible typing, and only one of them is $29.99. |
| **Refund an order just because a filtered list returned it.** | An unrecognised value in a list filter is dropped silently rather than rejected. Check the `status` of what comes back before acting on it. |
| **Refund a standalone transaction with no `order_id`.** | The refund flow goes through the order. Rare, but it happens for legacy or directly-created transactions; escalate to the dashboard or EPD support rather than finding another route. |
| **Carry a yes forward.** | T3 consent is never transitive. Two partial refunds of $10 on one order are two operations, two confirmations and two idempotency keys. |
| **Propose a smaller refund after a refusal.** | A refused refund is not an invitation to negotiate. |

## What to check afterwards

- [ ] **The confirmation quoted the exact amount, currency, object ID and mode**,
      and every one of them was read back from an API response rather than
      inferred.
- [ ] **The arithmetic was stated** on a partial refund — what was charged, what
      is being returned, what remains.
- [ ] **The refund ID and order ID were surfaced** so the human can find it in
      the dashboard.
- [ ] After `refund_and_cancel`: **`refund_status` was read**, not assumed.
      `success: false` with `status: "canceled_refund_pending"` means the
      subscription is gone and the money is not.
- [ ] **Nothing was re-issued on a timeout** except with the same idempotency
      key.
- [ ] If the customer's card was involved, **no card data beyond brand and last
      four** appears in the summary.

## A worked transcript

Illustrative. Tool names, response shapes and error codes are as the skill
documents them; names, IDs and amounts are placeholders.

---

**Support lead:** Alice wants to cancel her Pro subscription and get her last
payment back.

**Agent:** That is `refund_and_cancel` — the composite that does both — rather
than a cancel and a refund chained by hand. Before I can confirm it, I need the
amount, because the tool does not take one: it refunds the most recent succeeded
order, and I would rather tell you which one that is than find out afterwards.

```
tool: list_subscriptions
input:
  customer_id: 7c5a3d0b-9e42-4b2f-8e10-9f8c2e114d6a
  status: active,paused
```

One subscription, `active`, `$29.99`/month on the Pro plan.

```
tool: list_orders
input:
  customer_id: 7c5a3d0b-9e42-4b2f-8e10-9f8c2e114d6a
  status: succeeded,partially_refunded
  sort: created_at[desc]
  limit: 1
```

```json
{
  "data": [
    { "id": "9f8c2e11-4d6a-4b2f-8e10-7c5a3d0b9e42",
      "status": "succeeded", "total": 2999, "currency": "usd",
      "created_at": "2026-09-01T09:14:22Z" }
  ]
}
```

I included `partially_refunded` in the filter because what is left on such an
order is still refundable, and I checked the `status` on the row that came
back — a list filter can drop a value it does not recognise without erroring,
so the filter is not proof of what it returned.

That order is clean: $29.99, no prior refunds.

> I'm about to cancel Alice Liddell's **$29.99/month Pro** subscription
> (`2c963f66-afa6-3fa8-5f64-57174562b3fc`) **and** refund her most recent
> payment of **$29.99 USD** on order `9f8c2e11-4d6a-4b2f-8e10-7c5a3d0b9e42`, in
> **LIVE** mode. The subscription ends immediately and she will not be billed
> again. The refund is irreversible. Proceed?

**Support lead:** Yes.

```
tool: refund_and_cancel
input:
  subscription_id: 2c963f66-afa6-3fa8-5f64-57174562b3fc
  idempotency_key: 8f9a4d2e-7b1c-4f3a-9e2d-5c8a1b7d9e3f
```

```json
{
  "success": false,
  "status": "canceled_refund_pending",
  "subscription_id": "2c963f66-afa6-3fa8-5f64-57174562b3fc",
  "order_id_pending_refund": "9f8c2e11-4d6a-4b2f-8e10-7c5a3d0b9e42",
  "refund_status": "failed",
  "error": {
    "type": "processing_error",
    "code": "gateway_unavailable",
    "message": "Refund could not be processed at this time.",
    "request_id": "req_abc123def456"
  }
}
```

**Half of that landed. Read this one carefully.**

- **The subscription is cancelled.** That is not reversible from here and there
  is no rollback — cancellation runs first by design, so billing stops even when
  the refund does not.
- **The refund did not happen.** Alice is still owed **$29.99** on order
  `9f8c2e11-4d6a-4b2f-8e10-7c5a3d0b9e42`.
- `request_id` for EPD support if you need it: `req_abc123def456`.

I am **not** re-running `refund_and_cancel`. It caches the whole chain under the
key I used, so a retry returns this same response rather than retrying the
refund — and under a new key it would try to cancel a subscription that is
already cancelled while she is still out of pocket.

The refund on its own is `refund_order` against that order. That is a separate
T3 decision and I will ask you to confirm the amount again before I run it — the
yes you just gave covered the composite, not this.

Want me to put that plan up now, or wait for the gateway?

---

### What the transcript demonstrates

- **The amount was read before the confirmation**, because the composite does
  not take one and a confirmation you cannot fill from prior responses is not
  ready to ask.
- **The list filter was verified**, not trusted.
- **A partial failure was read rather than reported as a success.** The tool
  returned `success: false` inside an otherwise ordinary response.
- **The retry was refused with its reason**, and the correct next step named as a
  separate decision needing its own confirmation.
- **`request_id` was surfaced verbatim.** It is not recoverable afterwards.

## Where it hands off

| If the task is | Load |
|---|---|
| Cancel without a refund, or recover a failed renewal | [`epd-subscriptions`](./epd-subscriptions.md) |
| Diagnosing a failure before refunding | [`epd-transaction-triage`](./epd-transaction-triage.md) |
| Revenue or customer financial totals | [`epd-reporting`](./epd-reporting.md) |
| Writing refund code against `api.epd.com/v1` | [`epd-best-practices`](./epd-best-practices.md) |
