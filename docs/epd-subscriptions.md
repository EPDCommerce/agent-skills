---
skill: epd-subscriptions
surface: workflow
guide_version: 1.0.0
api_version: "2026-02-11"
---

# epd-subscriptions — guide

**Skill:** [`workflows/epd-subscriptions/SKILL.md`](../workflows/epd-subscriptions/SKILL.md) ·
**Policy:** [`SAFETY.md`](../SAFETY.md) ·
**Safety layer:** [`epd-mcp-operator`](./epd-mcp-operator.md)

Recurring billing after the customer exists: start it, change it, end it, or
recover a renewal that failed. The dunning half is the part worth reading twice,
because it is where a helpful agent charges someone twice.

## What it does

**Starts a subscription** on a customer who already has a vaulted payment method
(`create_subscription`). Signup and first subscription in one call is
[`epd-onboard-customer`](./epd-onboard-customer.md)'s `create_customer_and_subscribe`.

**Changes one in flight** (`update_subscription`, T2). Payment method and
shipping apply immediately, including to a queued retry. Billing terms —
`billing_cycle`, `billing_cycles`, `products` — apply from the **next** cycle.

**Ends it** — `cancel_subscription` for a quiet cancel, or
`cancel_subscription_and_report` when someone wants the "so what did this
subscription do?" rollup (`cycles_completed`, `total_billed_cents`, the original
status). Both are T3 and both need the subscription `active` or `paused`.

**Recovers a failed renewal** through the dunning loop — find it, classify the
decline, then decide whether anything should happen before the scheduled
attempt.

### Four facts about statuses that change how you query

Across all 130 sandbox subscriptions (18 September 2026), only four statuses
occur: `active`, `paused`, `canceled`, `completed`.

**A failed renewal stays `active`.** The tool schemas name `past_due` as a
filter value and the REST reference names `past_due` and `failed`. Neither
occurred. A subscription in dunning carries `attempt_count` (failures so far)
and `next_retry_at` (when the engine tries again), and **those two fields are
how you detect dunning** — never the status.

**`list_past_due_subscriptions` cannot be trusted as-is.** It looks like exactly
the tool for this. On 18 September 2026 it returned **all 130** subscriptions —
active, canceled, completed and paused — because nothing has that status and the
filter behind it is dropped silently. Acting on its output would put healthy and
already-cancelled subscriptions into a retry loop. It does expand `customer` and
`plan`, which saves calls, so the skill's position is: use it if you want the
expansion, then apply the `attempt_count` / `next_retry_at` filter to every row
it returns.

**Pause is not reachable.** The status exists; the public surface has no way to
enter or leave it. A pause request is modelled as cancel-now plus create-later,
or escalated to dashboard control.

**There is no `plan_id` on update.** `products` can replace the recurring
product lines from the next cycle, but moving to a different *plan* means
cancelling and creating a new subscription — and proration is not handled
automatically, so that is a conversation, not a mechanical step.

## When it fires

- *"Cancel a subscription."* · *"List past-due subs."*
- *"The renewal failed."* · *"Retry the failed charge."*
- Changing a customer's plan or payment method on a subscription.

### What it must not answer

| Near miss | Goes to |
|---|---|
| Signing up a brand-new customer | [`epd-onboard-customer`](./epd-onboard-customer.md) |
| Money must also go back to the customer | [`epd-refunds`](./epd-refunds.md) — `refund_and_cancel` |
| A **one-off** charge failed and nobody has diagnosed it | [`epd-transaction-triage`](./epd-transaction-triage.md) |
| A failure on a **renewal** | stays here — that is dunning |

That last split is the one the two skills had to be pulled apart on. Triage owns
one-off failures; dunning is a lifecycle state and belongs to the subscription.
Both skills now state the boundary in the same terms.

## What it refuses to do, and why

| Refusal | Why |
|---|---|
| **Retry before classifying.** | An expired or lost/stolen card fails identically every time. Worse, repeated attempts against a card reported lost or stolen is what fraud monitoring looks for. `insufficient_funds` is the mirror image: the card is fine and a new one is not needed, but an immediate retry fails for the same reason and burns an attempt. |
| **Retry by hand on top of a scheduled retry.** | If `next_retry_at` is set, the engine will try again. A fresh order for the same amount is a second charge. Use `retry_order`, which reconciles the cycle, or let the schedule run. |
| **Hand-roll cancel plus refund.** | `refund_and_cancel` exists, cancels first, and reports a failed refund with the order to retry. Doing it by hand risks a "subscription cancelled, refund stuck" state with nothing that names the stuck order. |
| **Invent a `cancellation_reason`.** | It is matched case-insensitively against the account's catalog. An unknown value returns `invalid_value` and the subscription is **not** cancelled — so a guess does not merely add noise, it blocks the cancel. Free text goes in `cancellation_notes`, which is kept either way. |
| **Update a cancelled subscription.** | The server returns `subscription_not_modifiable`. Create a new one on the same customer, or say the action is not possible. |
| **Trust `status: past_due`.** | Returns everything. So does `list_past_due_subscriptions`. |
| **Cite `update_subscription` as destructive.** | It is a T2 write and the server does not annotate it otherwise. Confirming it anyway before a payment-method swap on a live subscription is good practice — but the skill requires that to be stated as an operator judgment, not as a fact about the server. |

## What to check afterwards

After a cancel:

- [ ] The confirmation named the **plan, the amount, the cadence and the
      customer**, and said that billing stops immediately.
- [ ] A second cancel under a new key returns `already_canceled` —
      **that is an error, not a silent no-op**, and it means the first one
      landed.
- [ ] For `cancel_subscription_and_report`: its schema claims re-cancelling is a
      no-op even without a key. In sandbox it returned `invalid_state`. Check
      status before calling.

After a dunning recovery — this is the checklist that matters most:

- [ ] **Read the subscription back with `expand: cycles`** and check the failed
      cycle's `status`.
- [ ] **Check `next_retry_at` on the original cycle's order.** If it is still
      set after a manual retry, a second attempt is scheduled and the human
      needs to be told, not reassured.
- [ ] **The cycle was reconciled**, which `retry_order` does and
      `retry_failed_charge` does not claim to.
- [ ] **Every case reached an end state** — recovered, or cancelled by
      decision. Leaving one in the retry loop is the outcome that looks like
      success in a transcript and is not.

## A worked transcript

Illustrative. Statuses, field names and the `retry_order` behaviour are as the
skill documents them from sandbox; names, IDs and amounts are placeholders.

---

**Billing manager:** We've got renewals failing. Pull the past-due ones and
retry them.

**Agent:** Two problems with that as stated, and both are worth fixing before
anything runs.

**There is no past-due status on this account.** All 130 subscriptions sit in
`active`, `paused`, `canceled` or `completed`. A subscription whose renewal
failed stays `active` and carries `attempt_count` and `next_retry_at`. The
`list_past_due_subscriptions` tool returned every subscription on the account
when this was measured — so if I ran it and retried its output, I would be
retrying healthy and already-cancelled subscriptions.

**"Retry them" is a decision per subscription, not a batch.** Each one is a T3
charge and the codes differ. Let me find the real set first.

```
tool: list_subscriptions
input:
  status: active
  limit: 100
```

Keeping only rows where `attempt_count > 0` or `next_retry_at` is set leaves
**four**, not the 130 the past-due tool would have handed me:

| Customer | Subscription | Amount | `attempt_count` | `next_retry_at` |
|---|---|---|---|---|
| Alice Liddell | `4d6a4b2f-…` | $39.99 | 2 | 25 Sep 10:00Z |
| Bob Carroll | `9f8c2e11-…` | $29.99 | 3 | 24 Sep 10:00Z |
| Carol Dodgson | `57174562-…` | $89.00 | 1 | 24 Sep 02:00Z |
| Dan Tenniel | `2c963f66-…` | $19.99 | 1 | 26 Sep 10:00Z |

The status does not carry the decline code, so classifying each one takes two
more reads: the subscription's failed cycle, then that cycle's order. Eight
calls for the four. Here is Carol's, since she is where this ends up:

```
tool: get_subscription
input:
  id: 57174562-b3fc-2c96-3f66-afa63fa85f64
  expand: cycles
```

```json
{
  "id": "57174562-b3fc-2c96-3f66-afa63fa85f64",
  "status": "active",
  "plan": { "name": "SMS Pack", "amount": 8900, "currency": "usd" },
  "payment_method": { "id": "8e107c5a-3d0b-4e42-9f8c-2e114d6a4b2f",
                      "card": { "brand": "visa", "last4": "4242" } },
  "cycles": [
    { "cycle_number": 3, "status": "succeeded", "amount": 8900 },
    { "cycle_number": 4, "status": "failed", "amount": 8900,
      "order_id": "1a2b3c4d-5e6f-4a7b-8c9d-0e1f2a3b4c5d" }
  ]
}
```

```
tool: get_order
input:
  id: 1a2b3c4d-5e6f-4a7b-8c9d-0e1f2a3b4c5d
  expand: transactions
```

```json
{
  "id": "1a2b3c4d-5e6f-4a7b-8c9d-0e1f2a3b4c5d",
  "status": "failed", "total": 8900,
  "failure_code": "issuer_unavailable",
  "attempt_count": 1,
  "next_retry_at": "2026-09-24T02:00:00.000Z",
  "subscription_id": "57174562-b3fc-2c96-3f66-afa63fa85f64",
  "subscription_cycle": 4
}
```

The other three were read the same way. Running all four codes through
[`epd-transaction-triage`](./epd-transaction-triage.md):

| Customer | Amount | Code | Class | `next_retry_at` |
|---|---|---|---|---|
| Alice Liddell | $39.99 | `insufficient_funds` | soft | 25 Sep 10:00Z |
| Bob Carroll | $29.99 | `expired_card` | **hard** | 24 Sep 10:00Z |
| Carol Dodgson | $89.00 | `issuer_unavailable` | soft | 24 Sep 02:00Z |
| Dan Tenniel | $19.99 | `lost_stolen_card` | **hard** | 26 Sep 10:00Z |

That splits three ways, and only one of the four is a retry.

**Bob and Dan cannot be retried.** An expired card and a card reported
lost or stolen fail identically on every attempt. They need a new payment
method, which is [`epd-onboard-customer`](./epd-onboard-customer.md) and needs
the customer in the loop. For Dan I would go further: do not retry that card by
any route, because repeated attempts on a card flagged lost or stolen is the
pattern fraud monitoring watches for. Both have a scheduled attempt armed that
will fail — worth a note to whoever handles the customer contact.

**Alice is a soft decline with a retry already scheduled** for the 25th.
Retrying `insufficient_funds` today fails for the same reason and burns an
attempt. My recommendation is to let the schedule run.

**Carol is the one worth retrying now.** `issuer_unavailable` means the issuer
was briefly unreachable, which is usually short-lived, and hers is the one where
a prompt retry is reasonable rather than wishful.

Shall I do Carol only?

**Billing manager:** Yes, do Carol.

**Agent:** `retry_order` rather than `retry_failed_charge`, because this is a
subscription cycle: `retry_order` re-charges the card already on the order and
reconciles the cycle, so the dunning cron will not also charge her on the 24th.
`retry_failed_charge` reconstructs the order and does not claim to reconcile
anything, which would leave the scheduled attempt armed on top of mine.

> I'm about to call **`retry_order`** on order
> `1a2b3c4d-5e6f-4a7b-8c9d-0e1f2a3b4c5d` — cycle 4 of **Carol Dodgson**'s SMS
> Pack subscription — re-charging **$89.00 USD** to the **Visa ending 4242**
> already on that order, in **LIVE** mode. It reconciles the cycle, so the
> attempt scheduled for **24 Sep 02:00Z** will not also charge her. This moves
> real money. Proceed?

**Billing manager:** Go.

```
tool: retry_order
input:
  order_id: 1a2b3c4d-5e6f-4a7b-8c9d-0e1f2a3b4c5d
  idempotency_key: 3c9b2a8f-7e6d-4c5b-9a29-187f6e5d4c3b
```

```json
{ "id": "1a2b3c4d-5e6f-4a7b-8c9d-0e1f2a3b4c5d", "status": "succeeded",
  "total": 8900, "attempt_count": 2 }
```

Succeeded. Confirming rather than assuming:

```
tool: get_order
input:
  id: 1a2b3c4d-5e6f-4a7b-8c9d-0e1f2a3b4c5d
```

```json
{
  "id": "1a2b3c4d-5e6f-4a7b-8c9d-0e1f2a3b4c5d",
  "status": "succeeded", "total": 8900,
  "failure_code": null,
  "attempt_count": 2,
  "next_retry_at": null,
  "subscription_id": "57174562-b3fc-2c96-3f66-afa63fa85f64",
  "subscription_cycle": 4
}
```

`next_retry_at` is `null` and the cycle 4 order reads `succeeded`, so the
attempt scheduled for the 24th is stood down. **Carol is recovered and will not
be charged twice.**

That last read is the one worth not skipping. `retry_order` returning
`succeeded` says the charge went through; it does not say the cycle reconciled.
`next_retry_at` going `null` is the field that does, and it is the difference
between telling you she is recovered and telling you she is about to be charged
again.

Three still open: Alice on schedule for the 25th, Bob and Dan needing new cards.
Nothing is left sitting in the retry loop without a decision attached.

---

### What the transcript demonstrates

- **The batch instruction was narrowed to four**, then to one, with the
  reasoning shown at each step.
- **The broken tool was named and not used blindly**, with the measurement
  behind the claim.
- **The drill-down was shown, not asserted.** Every value in the
  confirmation — the order ID, the amount, the card, the scheduled retry — is
  visible in a response above it. The cost was stated too: two reads per
  subscription, eight for the four. `SAFETY.md` rule 4 is what makes a T3
  confirmation meaningful, and it applies to the reads that fill it.
- **Classification happened before any charge**, and produced three different
  answers, only one of which was "retry".
- **The confirmation named the tool.** The paragraph above it argues
  `retry_order` over `retry_failed_charge`; a confirmation that says neither
  leaves the human approving the argument rather than the call.
- **The result was verified by reading the order back**, including
  `next_retry_at`, rather than trusting the `succeeded` response — which reports
  the charge, not the reconciliation.

## Where it hands off

| If the task is | Load |
|---|---|
| Refunds, including `refund_and_cancel` | [`epd-refunds`](./epd-refunds.md) |
| New customer signup, or a new card on file | [`epd-onboard-customer`](./epd-onboard-customer.md) |
| Diagnosing why a charge failed | [`epd-transaction-triage`](./epd-transaction-triage.md) |
| Looking up a plan, or a one-off order | [`epd-catalog`](./epd-catalog.md) |
| Applying a discount to a subscription | [`epd-coupons`](./epd-coupons.md) |
| Customer financial history, revenue totals | [`epd-reporting`](./epd-reporting.md) |
