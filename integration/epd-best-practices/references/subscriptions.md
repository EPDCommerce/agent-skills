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


[active] ──── scheduled charge fails ────► [past_due] ──── dunning succeeds ────► [active]
                                                │
                                                │  retries exhausted
                                                ▼
                                            [canceled] or [failed]


[active] ──── billing_cycles reached ────► [completed]
```

States returned by the API: `active`, `paused`, `past_due`, `failed`,
`canceled`, `completed`.

> **`paused` is read-only via the public REST API.** A subscription can
> appear with `status: "paused"` (set internally, or via dashboard), but
> the pause / resume controller endpoints currently respond
> `NotImplemented` — don't build REST flows that pause or resume.
> Treat `paused` like `active` for read paths, and model user-initiated
> pause as cancel + resubscribe.
>
> **`failed`** is a terminal state reached when dunning retries are
> exhausted with a non-retriable failure reason. Treat it like `canceled`
> for billing purposes — no future cycles will run.

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

You can only update subscriptions in `active` state. Updating a `canceled`,
`completed`, or `past_due` subscription returns 400. To recover a `past_due`
subscription, see the past-due section below.

## Cancel

```http
DELETE /v1/subscriptions/{id} HTTP/1.1
Authorization: Bearer epd_test_sk_...
EPD-Version: 2026-02-11
X-EPD-Idempotency-Key: <uuid v4>     # optional but recommended
```

An optional `CancelSubscriptionDto` JSON body may be sent (currently empty
in v1; reserved for forthcoming `cancel_reason` / `at_period_end` fields).
Send `{}` or omit the body entirely.

- Cancellation is **immediate**. There's no "cancel at end of period" flag —
  you implement that yourself by scheduling the cancel.
- The subscription record is preserved with `status: "canceled"`. History is
  not deleted.
- Cancelling an already-canceled subscription returns **409 Conflict** with
  `error.code: "already_canceled"`. Cancelling a `completed` subscription
  returns 409 with `error.code: "subscription_completed"`. Cancel is not a
  no-op — wrap the call and treat those 409 codes as success in your
  retry/idempotent layer.
- Re-subscribing requires a new `POST /v1/subscriptions`.

## Past-due / dunning

When a scheduled charge fails, the subscription enters `past_due` and EPD
Commerce automatically retries on its dunning schedule. The REST API does
**not** expose a manual "retry now" endpoint.

The recovery path from your backend is:

1. Customer updates their card. In a browser flow, your frontend captures it
   with **EPD Elements** (a publishable key) and gets back a `card_token`;
   for a headless/back-office update, POST the card straight to
   `https://secure.epd.com` with your secret key instead — see
   `security.md` for both flows.
2. If you captured a `card_token`, `POST /v1/customers/{id}/payment_methods`
   with it to attach the card. (Skip this step if you used
   `secure.epd.com` — that call already created the payment method.)
3. `PATCH /v1/subscriptions/{id}` with the new `payment_method_id`.
4. Wait for the next scheduled dunning attempt — it will use the updated
   payment method.

If you need to drive retries on demand (e.g. "retry now" button after a card
update), that orchestration lives in the MCP `retry_failed_charge` composite
tool, not the REST API. See the `epd-subscriptions` workflow skill.

To list all past-due subscriptions for a dunning report:

```http
GET /v1/subscriptions?status=past_due&limit=100
```

## Listing & filtering

```http
GET /v1/subscriptions?status=active,past_due&customer_id=<id>&limit=50
```

Filters: `customer_id`, `plan_id`, `status` (comma-separated),
`created_at[gte]`/`[lt]`/etc.

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
   charge **and** cancel, the MCP composite `refund_and_cancel` does both
   atomically; in REST you call `POST /v1/orders/{id}/refund` first, then
   `DELETE /v1/subscriptions/{id}`.

## Where to go next

- Refund flows → `refunds.md`
- Handling `past_due` and decline codes → `errors.md`
- Sandbox cards that decline on schedule → `testing.md`
