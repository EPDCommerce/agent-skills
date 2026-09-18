# Subscriptions — recurring billing

A **subscription** links a customer to a **plan** with a billing cycle. Plans
define the catalog (price, currency, billing interval template); subscriptions
are individual customer instances of a plan with their own cycle, payment
method, and status.

## Lifecycle

```
[draft]
   │
   │  POST /v1/subscriptions
   ▼
[active] ──── PATCH /v1/subscriptions/{id} ────► [active]
   │
   │  DELETE /v1/subscriptions/{id}
   ▼
[canceled]   (immediate, history preserved)


[active] ──── scheduled charge fails ────► [active, attempt_count > 0,
                                             next_retry_at set] ── dunning succeeds ──► [active]
                                                │
                                                │  retries exhausted
                                                ▼
                                            [canceled]


[active] ──── billing_cycles reached ────► [completed]
```

The API reference also names `past_due` and `failed`. Neither appears in
sandbox: across all 130 subscriptions on 18 September 2026 the statuses were
`active`, `canceled`, `completed` and `paused`. A subscription in dunning stays
`active` and carries `attempt_count` and `next_retry_at`; nine `canceled`
ones carry `attempt_count: 4`, which is what dunning that ran out looks like.
So detect dunning by those two fields, not by status — see "Past-due /
dunning" below.

> **`paused` is read-only via the public REST API.** A subscription can
> appear with `status: "paused"` (set internally, or via dashboard), but
> the pause / resume controller endpoints currently respond
> `NotImplemented` — don't build REST flows that pause or resume.
> Treat `paused` like `active` for read paths, and model user-initiated
> pause as cancel + resubscribe.
>
> **`failed`**, if you ever see it, is terminal: treat it like `canceled` for
> billing purposes — no future cycles will run.

## Create a subscription

Prerequisite: the customer exists and has at least one payment method on
file. See `payments.md` for that flow.

```http
POST /v1/subscriptions HTTP/1.1
Authorization: Bearer epd_test_sk_...
EPD-Version: 2026-02-11
X-EPD-Idempotency-Key: <uuid v4>
Content-Type: application/json

{
  "customer_id": "<bare uuid or cus_<uuid>>",
  "plan_id": "<bare uuid or plan_<uuid>>",
  "payment_method_id": "<bare uuid only>",
  "billing_cycle": {
    "interval": "month",
    "interval_count": 1,
    "anchor_day": 1
  },
  "start_date": "2026-05-15",
  "billing_cycles": 12
}
```

Body fields:

| Field                | Required | Notes                                                            |
|----------------------|----------|------------------------------------------------------------------|
| `customer_id`        | yes      | Prefixed or bare UUID.                                           |
| `plan_id`            | yes      | Prefixed or bare UUID.                                           |
| `payment_method_id`  | yes      | **Bare UUID only.**                                              |
| `billing_cycle`      | yes      | See below.                                                       |
| `start_date`         | no       | ISO 8601 date. Defaults to today.                                |
| `end_date`           | no       | ISO 8601 date — fixed-end subscriptions.                         |
| `billing_cycles`     | no       | Total cycles to bill. `0` = unlimited (default).                 |
| `shipping_address_id`| no       | Existing saved address — **xor** with `shipping_address`.        |
| `shipping_address`   | no       | Inline address — **xor** with `shipping_address_id`.             |
| `shipping_option_id` | no       | Existing saved shipping option.                                  |

`billing_cycle` shape:

```json
{
  "interval": "month",      // "day" or "month"
  "interval_count": 1,      // 1 = monthly, 3 = quarterly, 12 = annual
  "anchor_day": 1           // 1–31, only for "month" interval
}
```

`anchor_day` semantics: if you set `anchor_day: 31`, billing falls on the last
day of months that don't have a 31st (Feb, April, June, etc.) — not the
following month's 1st. If you need exact same-day-of-month billing, use a day
1–28.

## Change a subscription mid-cycle

```http
PATCH /v1/subscriptions/{id} HTTP/1.1
```

Updatable fields: `payment_method_id`, `billing_cycle`, `shipping_address_id`,
`shipping_address`, `shipping_option_id`.

**Cannot update**: `customer_id`, `plan_id`. To switch plans, cancel the
existing subscription and create a new one (the customer's cycle restarts).

You can only update subscriptions in `active` or `paused` state — which
includes one in dunning, since those stay `active`. A payment-method change
applies immediately, including to a queued retry; billing-cycle changes take
effect from the next cycle. Updating a `canceled` subscription returns
`subscription_not_modifiable`.

## Cancel

```http
DELETE /v1/subscriptions/{id} HTTP/1.1
Authorization: Bearer epd_test_sk_...
EPD-Version: 2026-02-11
X-EPD-Idempotency-Key: <uuid v4>     # optional but recommended
```

The REST route takes no body in the published API reference; omit it. (The
MCP `cancel_subscription` tool is the one that accepts a
`cancellation_reason`, validated against the account's reasons catalog, and
free-text `cancellation_notes`.)

- Cancellation is **immediate**. There's no "cancel at end of period" flag —
  you implement that yourself by scheduling the cancel.
- The subscription record is preserved with `status: "canceled"`. History is
  not deleted.
- Cancelling an already-canceled subscription returns **409 Conflict** with
  `error.code: "already_canceled"`. Cancelling a `completed` subscription
  returns 409 with `error.code: "subscription_completed"`. Cancel is not a
  no-op under a new idempotency key — wrap the call and treat those 409
  codes as success in your retry/idempotent layer.
- Re-subscribing requires a new `POST /v1/subscriptions`.

## Past-due / dunning

When a scheduled charge fails, EPD Commerce retries it on its own dunning
schedule. In sandbox the subscription stays `active` while this happens; what
changes is `attempt_count` (failures so far) and `next_retry_at` (when the
next automatic attempt runs), on both the subscription and the failed cycle's
order.

**Finding them.** Don't filter on `status=past_due`: the value is silently
ignored, and `GET /v1/subscriptions?status=past_due` returned every
subscription on the sandbox account (18 September 2026). Page through
`GET /v1/subscriptions?status=active` and keep the rows where
`attempt_count > 0` or `next_retry_at` is set.

**Finding the failed charge.** `GET /v1/subscriptions/{id}?expand=cycles`
lists each cycle with its `status` and `order_id`. The failed cycle's order
carries the decline — `failure_code`, `attempt_count`, `next_retry_at` — see
the decline table in `errors.md` for what the code means.

**Recovering with a new card** (hard declines — `expired_card`,
`transaction_not_allowed`, `incorrect_cvv` and the like):

1. Customer updates their card. In a browser flow, your frontend captures it
   with **EPD Elements** (a publishable key) and gets back a `card_token`;
   for a headless/back-office update, POST the card straight to
   `https://secure.epd.com` with your secret key instead — see
   `security.md` for both flows.
2. If you captured a `card_token`, `POST /v1/customers/{id}/payment_methods`
   with it to attach the card. (Skip this step if you used
   `secure.epd.com` — that call already created the payment method.)
3. `PATCH /v1/subscriptions/{id}` with the new `payment_method_id`. This
   applies immediately, including to the queued retry.
4. Let the scheduled attempt at `next_retry_at` run — it uses the new card.

**Retrying now on the same card** (soft declines — `insufficient_funds`,
`issuer_unavailable` and the like, once the customer says it's resolved):

```http
POST /v1/orders/{failed_cycle_order_id}/retry HTTP/1.1
X-EPD-Idempotency-Key: <uuid v4>
```

No body. It re-charges the **order's** card on file — there is no card
switch — and on success reconciles the cycle so the daily billing cron will
not charge the customer again. Only a `failed` order (or one whose refund
failed) can be retried; a decline leaves it `failed` with `attempt_count`
incremented.
Don't fire it for a card you have just replaced in step 3 above; let the
scheduled attempt use the new card instead.

The MCP surface has the same retry as `retry_order`, plus
`retry_failed_charge`, which can switch cards but builds a new order rather
than reconciling the cycle — see the `epd-subscriptions` workflow skill before
using it on a subscription.

## Listing & filtering

```http
GET /v1/subscriptions?status=active,paused&customer_id=<id>&limit=50
```

Filters: `customer_id`, `plan_id`, `status` (comma-separated — only
`active`, `paused`, `canceled` and `completed` filter; anything else is
dropped without an error), `created_at[gte]`/`[lt]`/etc.

Expand: `customer`, `plan`, `cycles` (history of past billing cycles).

## Subscription cycles

Each scheduled charge generates a **cycle** record with the resulting
transaction. To inspect billing history:

```http
GET /v1/subscriptions/{id}?expand=cycles
```

Cycles are append-only — they record what happened (succeeded, failed, retried).

## Common bugs to avoid

1. **Trying to update `plan_id`.** Returns 400. Cancel + create a new
   subscription instead. Warn the user that the cycle restarts.
2. **Setting `anchor_day: 31` on a month interval.** It "works" but billing
   skews on short months. Use 1–28 for predictable billing.
3. **Idempotency key reuse on retry vs. resubscribe.** A retried `POST
   /v1/subscriptions` for a transient failure → same key. A new subscription
   after cancel → new key.
4. **Sending both `shipping_address_id` and `shipping_address`.** Returns
   400. Pick one.
5. **Assuming `DELETE /v1/subscriptions/{id}` refunds the last charge.**
   It doesn't — it only stops future cycles. To refund the most recent
   charge **and** cancel, the MCP composite `refund_and_cancel` does both in
   one call (cancel first, then refund — not atomic; see `refunds.md`); in
   REST you call `POST /v1/orders/{id}/refund` first, then
   `DELETE /v1/subscriptions/{id}`.
6. **Retrying a failed cycle by hand while a retry is scheduled.** If the
   order's `next_retry_at` is set, the dunning engine will try again on its
   own. Use `POST /v1/orders/{id}/retry` for the manual attempt — it
   reconciles the cycle — and never a fresh `POST /v1/orders` for the same
   amount, which the cron knows nothing about and will not stop it charging
   again.

## Where to go next

- Refund flows → `refunds.md`
- Decline codes on a failed cycle → `errors.md`
- Sandbox tokens that decline → `testing.md`
