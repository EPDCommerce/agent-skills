# Debugging — when a request is failing and the error envelope is unhelpful

This is a decision tree, not a bug list. The goal is to **stop you from
permuting the request body when the body isn't the problem.** Most lost
hours on EPD integrations come from re-tweaking JSON in response to an error
that has already told you the JSON is fine.

## Decision tree — read the error envelope first

Every non-2xx response is the shape:

```json
{
  "error": {
    "type": "...",
    "code": "...",
    "message": "...",
    "request_id": "req_...",
    "param": "...",                // optional
    "field_errors": [...]          // optional
  }
}
```

Branch on what's present:

| `code`                 | `field_errors` | `param` | What it means                                                                 | What to do                                                                                 |
|------------------------|----------------|---------|-------------------------------------------------------------------------------|--------------------------------------------------------------------------------------------|
| `validation_error`     | present        | set     | Schema rejected a specific field                                              | Fix that field. Map `field_errors[].field` → form UI directly.                             |
| `validation_error`     | **absent**     | set     | One field failed a semantic rule (length, format, business rule)              | Read `message`; fix the field at `param`.                                                  |
| `validation_error`     | **absent**     | **absent** | **Server-side ORM rejection.** Body already passed validation.            | **Stop permuting the body.** Capture `request_id`; escalate. See "Pre-flight" below.       |
| `invalid_<resource>_id`| —              | set     | ID format wrong (e.g. you sent `pm_<uuid>` to `payment_method_id`)            | Strip / add the prefix per the resource. Payment methods take bare UUIDs only.             |
| `resource_not_found`   | —              | optional| Resource doesn't exist for this merchant, or is soft-deleted, or wrong tenant | Check it via `GET /v1/<resource>/{id}`. Don't assume "I created it yesterday → it exists." |
| `missing_api_key` / `invalid_api_key` | — | — | Auth header missing or wrong prefix/value | Re-check the `Authorization` header. See "Environment-mismatch heuristic" below.  |
| `insufficient_permissions` | —          | —       | Restricted key without scope, or wrong IP / environment for the key            | Widen the key's scope or use a full secret key. Check `message` for IP / env detail.       |
| `idempotency_key_mismatch` | —          | —       | Reusing a key with a **different body** (HTTP 422)                            | Generate a new UUID v4. Never reuse a key for a different cart / intent.                   |
| `idempotency_key_in_use` | —            | —       | Same key, still being processed (HTTP 409)                                    | Short backoff (250 ms – 2 s), retry with the **same** key.                                 |
| order body has `status: "failed"` with `failure_reason` set (e.g. `transaction_not_allowed`, `insufficient_funds`, `expired_card`) | — | — | Issuer rejected the card — **this is a 200 OK, not an error envelope** | Surface to the customer. Don't auto-retry — let them pick a different card. See `errors.md` for the full failure_reason enum. |
| `internal_error`       | —              | —       | Server fault — not retriable by changing the body                             | Capture `request_id`; escalate. Treat the same as "validation_error with no field_errors". |

## The fingerprint that costs people hours

The single failure mode that traps integrations the longest:

```json
{
  "error": {
    "type": "invalid_request_error",
    "code": "validation_error",
    "message": "Invalid data format in request.",
    "request_id": "req_2cb5973f56464205a3dff101760f0ec2"
  }
}
```

— no `field_errors`, no `param`. **This is not a body-shape error.** The
schema validator already accepted the request. The database client rejected
the resulting query at serialization time (type mismatch, `NaN`, `undefined`
where a value was required, an unsupported character such as a null byte in
a string field, ORM-schema drift).

Symptoms that confirm it:

- The exact same body succeeded earlier.
- Removing or simplifying fields produces no new information — same generic
  message every time.
- The same call via the EPD MCP server returns **500 `internal_error`** with
  the message *"The server failed to process this request. Reference the
  request_id when reporting this issue."* — that's the same root cause,
  surfaced more honestly.

**What to do — in order:**

1. **Stop editing the JSON.** Permuting fields won't help — the validator
   already accepted them.
2. **Capture the `request_id`** from the response body and (if present) the
   `X-Request-Id` header. They're the same value.
3. **Run the pre-flight sanity check** below to rule out resource-state
   drift.
4. **Escalate with the `request_id`** to the EPD support contact / operator
   running the server. They need it to find the stack trace.

## Pre-flight sanity check — run this before assuming the worst

When something downstream is failing, verify the resources you're sending
to actually exist and are usable. One GET per ID is cheaper than another
hour of permuting JSON:

```http
GET /v1/account                                            → confirms the key is valid & which env you're in
GET /v1/customers/{customer_id}                            → exists? is `deleted_at` null?
GET /v1/customers/{customer_id}/payment_methods            → does the PM you're sending appear in this list?
GET /v1/products/{product_id}                              → exists? still owned by this merchant?
```

If any of those returns 404 or a different shape than you expect, **that's
your bug** — the resource referenced in the failing request isn't where you
think it is. Fix that and the failing request will start succeeding without
any body changes.

## Environment-mismatch heuristic

If the request is failing and your config looks like one of these, stop and
re-check **before** debugging the body:

| Symptom                                              | Almost certainly                                                            |
|------------------------------------------------------|-----------------------------------------------------------------------------|
| Key prefix is `epd_live_sk_` and the URL is `localhost` or a private host | The dev pointed a live key at a local server, or pointed a localhost host at production data. Pick one. |
| Key prefix is `epd_test_sk_` and the URL is `api.epd.com` and `GET /v1/account` returns `is_sandbox: false` | The key is for a different merchant than the URL suggests. |
| `EPD-Version` header is missing                      | Responses you see in dev may not match prod when the merchant upgrades. Pin the version. |
| Different keys / URLs across dev, CI, and prod with no explicit env switch | The integration is one deploy away from charging a real card with a test key, or vice versa. Wire env-aware config. |

## What to log on every EPD call

So that when something does fail, you can trace it without re-running:

- `request_id` (from response body or `X-Request-Id` header) — **on success
  and failure both**, not just on errors.
- HTTP status.
- Endpoint + method.
- The idempotency key you sent.
- The `error.code` (when not 2xx).

Never log:

- Full response bodies (PII).
- API keys.
- Card numbers, CVVs, full webhook bodies.

## When to escalate vs. when to keep debugging

| Signal                                                                   | Action                                                                 |
|--------------------------------------------------------------------------|------------------------------------------------------------------------|
| `field_errors` is present                                                 | Fix the body — you have everything you need.                          |
| `code` is `invalid_<resource>_id`, `idempotency_*`, etc. (envelope errors) | Fix it client-side per the table above.                               |
| HTTP 200 with order `status: "failed"` and a `failure_reason`             | Not an envelope error — surface to the customer; pick a different card.|
| `resource_not_found` for an ID you "know" exists                          | Run `GET /v1/<resource>/{id}` — assumption is probably wrong.         |
| `validation_error` with no `field_errors` / no `param`                    | Escalate with `request_id`. Do not permute the body.                  |
| `internal_error` / 5xx                                                    | Retry with the **same** idempotency key, exponential backoff, max 3.  |
| Repeated 5xx after retries                                                | Escalate with `request_id`.                                           |

Time-budget rule of thumb: **15 minutes** of body-permutation on a generic
`validation_error` is the cap. Past that you are guessing — escalate the
`request_id` and move on.
