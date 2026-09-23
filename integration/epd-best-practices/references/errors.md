# Errors & retry strategy

Every non-2xx response from the EPD Commerce API has the same envelope:

```json
{
  "error": {
    "type": "invalid_request_error",
    "code": "validation_error",
    "message": "Customer with ID cus_123 not found.",
    "request_id": "req_abc123def456",
    "param": "customer_id"
  }
}
```

`request_id` is also exposed via the `X-Request-Id` response header on **every**
request (success and error). Log it on every call — EPD Commerce support uses
it to look up the request context.

> **Envelope errors are not the same as a declined order.** A successful
> HTTP 2xx may still carry `status: "failed"` on the order body, with a
> `failure_code` (the machine value) and a `failure_reason` (prose for
> humans) — that is the issuer's decline, not an envelope-level API error.
> The two sets of codes are disjoint; branch on HTTP status first, then on
> the body. The `failure_code` values are at the bottom of this page.

## Top-level `type` values

These are the seven envelope types the API actually emits:

| `type`                  | Meaning                                                                |
|-------------------------|------------------------------------------------------------------------|
| `invalid_request_error` | Malformed request — missing/wrong params, validation, not-found, conflicts. (400, 404, 409, 422) |
| `authentication_error`  | API key missing, invalid, expired, or revoked. (401)                   |
| `authorization_error`   | Key valid but lacks scope / IP not allowed / wrong environment. (403)  |
| `rate_limit_error`      | Too many requests — respect `Retry-After`. (429)                       |
| `idempotency_error`     | Idempotency key reused with a different body, still in flight, or malformed. (400, 409) |
| `processing_error`      | Server-side processing failure — internal error, gateway, upstream. (500, 502, 503) |
| `webhook_error`         | Webhook delivery / configuration / signature failures. (400, 500)      |

## Common `code` values

| `code`                              | HTTP | `type`                  | Meaning / what to do                                                         |
|-------------------------------------|------|-------------------------|------------------------------------------------------------------------------|
| `validation_error`                  | 400  | `invalid_request_error` | Body / query failed schema validation. See diagnostic note below.            |
| `invalid_customer_id`               | 400  | `invalid_request_error` | Customer-ID format wrong. Same pattern for `invalid_product_id`, `invalid_order_id`, `invalid_subscription_id`. |
| `resource_not_found`                | 404  | `invalid_request_error` | Resource doesn't exist for this merchant or has been soft-deleted.            |
| `resource_already_exists`           | 409  | `invalid_request_error` | A unique field (email, sku, phone) collides with an existing record.         |
| `email_already_exists` / `phone_already_exists` / `sku_already_exists` | 409 | `invalid_request_error` | More specific variants of `resource_already_exists`.                     |
| `customer_has_active_subscriptions` | 400  | `invalid_request_error` | Cannot delete customer until subscriptions are canceled.                     |
| `already_canceled`                  | 409  | `invalid_request_error` | `DELETE /v1/subscriptions/{id}` against an already-canceled subscription.    |
| `shipping_address_required`         | 400  | `invalid_request_error` | An item with `requires_shipping: true` is in the order but no shipping address was provided. |
| `missing_api_key`                   | 401  | `authentication_error`  | No `Authorization` header.                                                   |
| `invalid_api_key` / `invalid_api_key_format` / `expired_api_key` / `revoked_api_key` | 401 | `authentication_error` | Bad, malformed, expired, or revoked key.                            |
| `insufficient_permissions`          | 403  | `authorization_error`   | Restricted key without access to this resource.                              |
| `ip_not_allowed`                    | 403  | `authorization_error`   | Source IP not in the merchant's allowlist.                                   |
| `environment_mismatch`              | 403  | `authorization_error`   | Test key used against a live resource (or vice versa).                       |
| `invalid_api_version` / `api_version_sunset` | 403 | `authorization_error` | `EPD-Version` header is unknown or no longer supported.                  |
| `rate_limit_exceeded` / `global_rate_limit_exceeded` | 429 | `rate_limit_error` | Throttled — respect `Retry-After`.                                     |
| `missing_idempotency_key`           | 400  | `invalid_request_error` | Endpoint requires `X-EPD-Idempotency-Key` and it wasn't sent.                |
| `request_in_progress`               | 409  | `idempotency_error`     | Same key, same body, seen before. The first attempt may have gone through — look it up; don't spin. See below. |
| `idempotency_key_conflict`          | 409  | `idempotency_error`     | Same key, **different body**. Something changed between attempts — find out what before sending anything else. |
| `invalid_idempotency_key`           | 400  | `idempotency_error`     | Key isn't 16–64 characters of letters, digits, `-` or `_`.                  |
| `merchant_not_configured`           | 400  | `invalid_request_error` | Merchant's payment gateway link isn't provisioned. Operator-side fix.        |
| `gateway_error`                     | 502  | `processing_error`      | Upstream payment gateway (vault / NMI) returned an error.                    |
| `internal_error`                    | 500  | `processing_error`      | Server-side fault. Capture `request_id` and escalate — not retriable by changing the body. |
| `not_implemented`                   | 501  | `processing_error`      | Endpoint exists in the OpenAPI surface but isn't implemented yet (e.g. subscription pause/resume). |
| `service_unavailable`               | 503  | `processing_error`      | Transient — retry with backoff and the same idempotency key.                 |
| `webhook_signature_failed` / `webhook_endpoint_invalid` / `webhook_delivery_failed` | 400/500 | `webhook_error` | Webhook-side errors — see `epd-webhooks`.                  |

`code` is the source of truth — branch on it, not on `message`. Messages are
human-readable and may be reworded between releases without notice.

## `field_errors`

For schema validation failures, the envelope often includes `field_errors`:

```json
{
  "error": {
    "type": "invalid_request_error",
    "code": "validation_error",
    "message": "Validation failed.",
    "request_id": "req_xyz",
    "field_errors": [
      { "field": "email", "code": "invalid_format", "message": "Email is not valid." },
      { "field": "phone", "code": "required_field", "message": "Phone is required." }
    ]
  }
}
```

When `field_errors` is present, surface it to the form UI rather than the
top-level `message` — the per-field codes are designed to map onto form input
errors directly. Nested paths use **bracket notation** (e.g.
`items[0][quantity]`), not dot notation.

## Diagnostic: `validation_error` with **no** `field_errors` and **no** `param`

If you see this exact response shape:

```json
{
  "error": {
    "type": "invalid_request_error",
    "code": "validation_error",
    "message": "Invalid data format in request.",
    "request_id": "req_..."
  }
}
```

— with **no `field_errors`, no `param`** — your request body already passed
DTO/schema validation. The failure happened deeper, at the database client
layer: the server's ORM rejected the query before it reached the database.

**Do not keep permuting the JSON body.** The body is not the problem.

What this means in practice:

- The request reached the service successfully and was being committed.
- A type mismatch, `NaN`, `undefined` where a value was required, an
  unsupported character (e.g. a null byte in a string field),
  or schema drift caused the ORM to throw.
- The same underlying error class is treated as **400** on the REST surface
  and **500** on the MCP surface — same root cause, different policy. The
  MCP-side response is the more honest one: this is a server-side fault, not
  a client-input fault.

What to do:

1. Capture the `request_id`. It is the only lookup key for the underlying
   stack trace, and it is also returned on every successful response in the
   `X-Request-Id` header — pin a per-request logger to it.
2. Stop debugging the body. If the same body succeeded yesterday and fails
   today, the resource state changed server-side, not your request.
3. Escalate with the `request_id`. EPD support / the EPD operator needs the
   server-side log to identify which ORM call threw.
4. While waiting: run the **pre-flight sanity check** in
   `debugging.md` to confirm whether referenced resources still exist and
   are usable.

**Reliable fingerprint to commit to memory:** `validation_error` + no
`field_errors` + no `param` + message exactly `"Invalid data format in
request."` → server-side rejection at the ORM layer. Not your body.

## Retry strategy — exact rules

Retry **only** these conditions, with the **same** `X-EPD-Idempotency-Key` you
sent originally:

| Condition                                              | Retry?                                |
|--------------------------------------------------------|---------------------------------------|
| Network error (timeout, connection refused, DNS)       | Yes — exponential backoff             |
| HTTP 500, 502, 503, 504                                | Yes — exponential backoff             |
| HTTP 429                                               | Yes — sleep `Retry-After` seconds     |
| HTTP 409 `request_in_progress`                         | **No** — read the resource back first |
| HTTP 409 `idempotency_key_conflict`                    | **No** — find out what changed        |
| Other 4xx                                              | **No** — request is wrong, fix it     |
| HTTP 2xx with order `status: "failed"`                 | **No** — payment failed; show the customer, don't auto-retry |

Backoff schedule: `200ms × 2^(attempt - 1)`, capped at 5 seconds. Max 3
attempts for a single logical operation.

```
Attempt 1 fails → sleep 200ms
Attempt 2 fails → sleep 400ms
Attempt 3 fails → surface error
```

## Why "same idempotency key" matters on retry

If you retry with a **different** key, EPD treats it as a new operation. For
`POST /v1/orders` that means a **second charge** on the customer's card. The
idempotency mechanism is the only thing standing between a flaky network and
a duplicate charge — never bypass it on retry.

If you want to truly create a second, separate order (e.g. the customer added
another item to their cart), generate a new key.

## Handling specific failures

### Declined payment (HTTP 2xx with `status: "failed"`)

This is **not** an envelope error — it's a successful HTTP exchange whose
payment outcome was a decline. Show the customer the failure and let them
try a different card. Do **not** auto-retry. The `failure_code` field on the
order body (and on the underlying transaction) classifies the decline — see
the table below.

### `gateway_error` (502)

The upstream payment processor or vault failed. Safe to retry with the same
idempotency key. If the retry also fails, surface a generic "we couldn't
process payment" message and log `request_id` for support follow-up.

### `request_in_progress` vs `idempotency_key_conflict` (both 409)

- `request_in_progress` is what a repeat of the **same key and same body**
  returns. The API reference says such a repeat within 24 hours replays the
  original response; in sandbox it does not. A `POST /v1/customers` repeated
  1.5 seconds after it succeeded got `request_in_progress` (18 September
  2026), and a repeat at +90 seconds got the same in August. So a retry with
  the same key is still the right *safety* move — it cannot create a second
  resource — but it will not hand you the result. Read the resource back
  (list by `email`, by `customer_id` and `created_at`, and so on) instead of
  looping on the 409.
- `idempotency_key_conflict` means you reused a key with a **different
  request body**. This is almost always a bug in your code — find where the
  key is being reused and fix it. Generating a new key on the fly to "make it
  work" papers over the bug and, in payments, usually means an amount or a
  target changed between attempts.

### `insufficient_permissions` (403)

The dev is using a restricted key (`epd_restricted_sk_...`) that lacks scope
for this resource. Either widen the key's scope in the EPD dashboard or use
a full secret key for this operation. The same code is also returned when
the key's IP allowlist or environment doesn't match (look at the
accompanying `message`).

## Decline codes on failed orders

When an order comes back with `status: "failed"`, two fields describe the
decline, on the order and on its failed transaction:

- `failure_code` — the machine value, e.g. `do_not_honor`. **Branch on this.**
- `failure_reason` — prose for humans, e.g. `"a bank restriction"`. Not stable
  enough to switch on.

Older versions of this page put the codes in `failure_reason`; the API does
not. The codes map from the upstream processor's responses and are disjoint
from the envelope `code` values above.

The nine below are the ones the sandbox account's failed transactions
actually carry (678 of them, measured 11 September 2026). The classes are the
same ones `epd-transaction-triage` uses:

| `failure_code`            | Class     | Another attempt on the same card?                      |
|---------------------------|-----------|--------------------------------------------------------|
| `insufficient_funds`      | soft      | Later, on a schedule — not immediately                 |
| `issuer_unavailable`      | soft      | Yes — the issuer was unreachable, often briefly        |
| `card_limit_exceeded`     | soft      | Later, on a schedule                                   |
| `expired_card`            | hard      | **No** — needs a new card                              |
| `transaction_not_allowed` | hard      | **No** — needs a new card                              |
| `lost_stolen_card`        | hard      | **Never** — repeated attempts look like fraud          |
| `do_not_honor`            | ambiguous | At most once, later; a repeat means stop               |
| `incorrect_cvv`           | ambiguous | **No** — same stored data fails the same way; re-enter the card |
| `processor_declined`      | ambiguous | Treat like `do_not_honor`                              |

`processor_declined` is also what **every** sandbox decline test token
returns (see `testing.md`), so a sandbox test proves your decline branch runs,
not which decline it was.

Treat this as the observed set, not a closed one. Other values have been
documented for this field — `closed_card`, `invalid_account`, `blocked_card`,
`contact_bank`, `fraud_suspected`, `duplicate_transaction`,
`invalid_merchant_configuration`, `unknown` — but none appears in the sandbox
data. For any code you don't recognise, don't auto-retry: surface it and log
it with the `request_id`.

**Subscription cycles retry on their own schedule.** EPD's dunning engine
decides whether and when to re-attempt a failed cycle, and records it on the
order as `next_retry_at` and `attempt_count`. Read those rather than
predicting the engine from the code — in sandbox, a cycle that failed with
`do_not_honor` had a retry already scheduled. A manual retry on top of a
scheduled one can charge twice; see `subscriptions.md`.

## Logging — what to capture

For every EPD request, log:

- `request_id`
- HTTP status
- `error.code` (if not 2xx)
- `failure_code` (if 2xx and order `status === "failed"`)
- The endpoint + method
- The idempotency key you sent (if any)

Never log:

- The full response body (may contain customer PII).
- The API key.
- Card numbers, CVVs, full webhook bodies.
