---
name: epd-best-practices
description: Use when integrating EPD Commerce (EasyPayDirect) into a codebase via the v1 REST API. Triggers when imports use api.epd.com, when env vars EPD_API_KEY / EPD_WEBHOOK_SECRET appear, when file content matches a key prefix (epd_live_sk_, epd_test_sk_, epd_restricted_sk_live_, epd_restricted_sk_test_), or when the user mentions EPD Commerce / EasyPayDirect and asks how to charge a card / start a subscription / refund an order. Skip when the user is operating an EPD Commerce account via an MCP-connected agent — use the workflow skills under workflows/ for that.
compatibility: Requires an HTTP client + JSON parser in any backend language. Server-side only — secret keys must never reach a browser.
metadata:
  version: 1.1.0
  api_version: "2026-02-11"
---

# EPD Commerce — best practices for REST integration

You are helping a developer integrate EPD Commerce into their backend. The
EPD Commerce v1 API uses bearer-token auth, JSON responses, cursor
pagination, idempotent writes, and signed webhooks. Generate code in
whatever language the surrounding repo uses.

Full reference: <https://docs.api.epd.com/>. This skill encodes the **non-obvious
patterns** that live above the reference — load a domain reference for detail.

> **No publishable / browser-safe key exists** in EPD Commerce. All API
> authentication uses a server-side secret. Browser-side card collection
> happens in a separate vault layer (see `references/security.md`).

## Routing — pick the reference that matches the task

| Task                                              | Read                          |
|---------------------------------------------------|-------------------------------|
| Reusable HTTP client (auth + retry + idempotency) | `references/sdk-wrapper.md`   |
| One-time charge / order processing                | `references/payments.md`      |
| Plans, subscriptions, trials, dunning             | `references/subscriptions.md` |
| Refunds — partial / full / order vs transaction   | `references/refunds.md`       |
| Decoding an error response, retry strategy        | `references/errors.md`        |
| Stuck on a confusing error — decision tree         | `references/debugging.md`     |
| Key handling, sandbox vs live, PCI scope          | `references/security.md`      |
| Sandbox tokens, environment guards                | `references/testing.md`       |
| API version pinning, deprecation, migration       | `references/versioning.md`    |

For webhook setup and signature verification, switch to the sibling skill
`epd-webhooks` — it ships language-specific verifier scripts.

## Universal rules — apply to every EPD Commerce request

These never change across endpoints. Encode them once in the HTTP wrapper, not
at every call site (see `references/sdk-wrapper.md`).

### Base URL & version pinning

```
Base URL:                https://api.epd.com
Version header:          EPD-Version: 2026-02-11
```

Pin the version on every request. Without it, the merchant's account-default
version is used — which silently changes when they upgrade. Pinning decouples
your release schedule from theirs. See `references/versioning.md` for the
migration playbook.

### Authentication

```
Authorization: Bearer epd_live_sk_<32 random hex>     # production
Authorization: Bearer epd_test_sk_<32 random hex>     # sandbox
```

Restricted keys (limited scope) use `epd_restricted_sk_live_` / `_test_`
prefixes. Issue these for analytics dashboards or read-only workloads instead
of full secret keys.

EPD Commerce does **not** issue publishable (browser-safe) keys. Card
tokenization happens through the EPD Gateway vault, which has its own
credentials — see
`references/security.md`.

Rules:

- Secret keys server-side only. Never commit, never log, never ship to a browser.
- Rotate by issuing the new key, deploying it, then revoking the old one. Never
  the other way around.
- Missing or malformed `Authorization` header returns **401** with error code
  `missing_api_key` or `invalid_api_key`.

### Idempotency — non-negotiable on writes

EPD Commerce requires the **`X-EPD-Idempotency-Key`** HTTP header on every POST that
moves money or creates a resource (orders, subscriptions, refunds, customers,
payment methods).

```
X-EPD-Idempotency-Key: 8f9a4d2e-7b1c-4f3a-9e2d-5c8a1b7d9e3f
```

Rules — get these wrong and you double-charge customers:

1. One fresh UUID v4 per **logical operation** (one charge, one refund, one signup).
2. Format: 16–64 alphanumeric characters, hyphens and underscores allowed. UUID
   v4 is the recommended default.
3. On network failure or 5xx, retry with the **same** key. The cached response
   is returned for **24 hours**.
4. Reusing a key with a **different request body** returns **HTTP 422** with
   error code `idempotency_key_mismatch` — generate a new key for a new intent.
5. A request still in-flight returns **HTTP 409** with code `idempotency_key_in_use`.
   Wait (250 ms – 2 s), then retry with the same key.
6. Never use semantic strings (`"order-123"`, `"signup-feb"`). They collide.

> **MCP vs REST:** in the EPD MCP server, `idempotency_key` is a body parameter
> in the tool input schema (because MCP tool inputs are flat objects). In REST
> it is the **`X-EPD-Idempotency-Key` HTTP header**. Don't confuse them when
> porting code between surfaces.

### Error envelope

Every non-2xx response has the same JSON shape:

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

Possible fields:

| Field          | Type     | When present                                    |
|----------------|----------|-------------------------------------------------|
| `type`         | string   | always — high-level category (see below)        |
| `code`         | string   | always — specific machine-readable code         |
| `message`      | string   | always — human-readable explanation             |
| `request_id`   | string   | always — also exposed via `X-Request-Id` header |
| `param`        | string   | optional — name of the offending parameter      |
| `doc_url`      | string   | optional — link to relevant doc page            |
| `field_errors` | array    | optional — per-field validation failures        |

`field_errors` shape: `[{ field, code, message }]`.

Top-level `type` values: `invalid_request_error`, `authentication_error`,
`authorization_error`, `idempotency_error`, `processing_error`,
`rate_limit_error`, `webhook_error`. Full code list in `references/errors.md`.

**Always surface `request_id`** to your support tooling — EPD Commerce support
uses it to look up the request context.

Retry strategy:

- 5xx and network errors → retry with the **same** `X-EPD-Idempotency-Key`,
  exponential backoff, max 3 attempts.
- 4xx (except 409 `idempotency_key_in_use`) → never retry. The request is
  wrong, retrying won't fix it.
- 429 (rate limited) → respect `Retry-After` header, then retry with the same key.

### IDs

Bare UUIDs everywhere on output. On input, prefixed forms are accepted for
backward compatibility — **except `payment_method_id`, which requires a bare
UUID always**.

Recognized prefixes on input:

```
cus_<uuid>     customers
sub_<uuid>     subscriptions
ord_<uuid>     orders
txn_<uuid>     transactions
plan_<uuid>    plans
prod_<uuid>    products
img_<uuid>     product images
addr_<uuid>    shipping addresses
ship_<uuid>    shipping options
```

Wrong format returns **400** with `code: invalid_<resource>_id`.

### Pagination — cursor-based

```
GET /v1/customers?limit=50&starting_after=<id_of_last_seen_record>
GET /v1/customers?limit=50&ending_before=<id_of_first_seen_record>
```

Use `starting_after` to page forward and `ending_before` to page backward.
Passing both in the same request returns **400 validation_error** —
they're mutually exclusive.

Response shape:

```json
{
  "object": "list",
  "data": [...],
  "has_more": true,
  "url": "/v1/customers",
  "cursors": {
    "next": "0192ab34-...",
    "previous": "0192ab12-..."
  },
  "total_count": 247
}
```

Defaults:

- `limit`: 10 (default), 100 (max)
- No `?page=` parameter — there is no offset pagination.
- `total_count` is included on most list endpoints but treat it as optional.
- For unbounded result sets, stream pages — never accumulate into memory.

### Filtering — bracket notation

Numeric and date filters use bracket notation, **not** snake_case suffixes:

```
?amount[gte]=2999&amount[lt]=10000
?created_at[gte]=2026-01-01T00:00:00Z
?created_at[lte]=2026-01-31T23:59:59Z
```

Operators: `[gt]`, `[gte]`, `[lt]`, `[lte]`.

**Unknown query parameters return 400.** EPD Commerce list endpoints use a strict
schema — you can't sneak a `page=2` or `amount_gte=...` past the validator. If
your filter does nothing, you'll see a `validation_error`, not silent success.

### Money & locale

- **Amounts**: integers in the smallest currency unit. `2999` = $29.99 USD.
  Decimals are rejected.
- **Currency**: ISO 4217 lowercase. `"usd"`, `"eur"`, `"gbp"`.
- **Country**: ISO 3166-1 alpha-2 uppercase. `"US"`, `"GB"`, `"DE"`.
- **Datetimes**: ISO 8601 with timezone. `"2026-04-30T00:00:00Z"`.

### Rate limiting

Public API: per-merchant throttling enforced. On 429, respect the `Retry-After`
response header (seconds) before retrying. The MCP endpoint is additionally
throttled at 60 requests / minute at the HTTP layer.

## Schema lookup — endpoints not deep-covered here

The `references/` folder deep-covers payments, subscriptions, refunds, and
webhook consumption. For everything else — **transactions, plans, products,
product images, shipping addresses, shipping options, webhook endpoints,
account** — fetch the OpenAPI spec on demand. Never pre-load it (220 KB).

```
Spec: https://docs.api.epd.com/openapi.yaml
```

Fetch with a **targeted prompt**, not a full read:

> Extract the request and response schema for `<METHOD> <PATH>`. List every
> parameter with type, required/optional, constraints (length, enum, pattern),
> and a one-line description. Skip examples.

A focused fetch returns ~2–3 KB instead of 220 KB.

**Do not fetch the spec for** authentication, idempotency, the error envelope,
pagination, filtering, money/locale rules, or the four deep-covered domains —
the skill already encodes these, and the spec may carry backward-compat
aliases that conflict.

> **Known spec drift to ignore:** the spec's `servers:` block may list a
> non-canonical host (e.g. `api-commerce.epd.com`). The canonical base URL
> is **`https://api.epd.com`** — pinned at the top of this skill. Trust the
> skill over the spec on host.

**Version drift check.** If the repo pins an `EPD-Version` other than this
skill's `metadata.api_version`, fetch the spec and diff the affected endpoints
before generating code.

## Composite endpoints

EPD Commerce provides composite MCP tools that chain steps server-side with
structured partial-failure responses:

| Composite                        | What it does                                                     |
|----------------------------------|------------------------------------------------------------------|
| `process_order`                  | Validates customer (exists, not soft-deleted) → creates order    |
| `create_customer_and_charge`     | Creates customer → charges → rolls back customer on charge fail  |
| `create_customer_and_subscribe`  | Creates customer → starts subscription                           |
| `refund_and_cancel`              | Cancels subscription → refunds most recent succeeded order       |
| `cancel_subscription_and_report` | Cancels + returns billing summary (cycles_completed, totals)     |
| `retry_failed_charge`            | Reconstructs a failed transaction's order and retries            |

> **These exist as MCP tools only — there are no REST equivalents.** REST
> integrations chain primitives themselves: `create_customer` →
> `add_payment_method` → `create_order`. The composites are exposed for
> agents that need server-side orchestration with one idempotency key
> covering the whole chain. `process_order` differs from `create_order` only
> by adding pre-flight customer validation; in REST you'd do a `GET
> /v1/customers/{id}` yourself before posting the order.

If your dev is using REST, point them at `references/payments.md` for the
chained-primitive pattern. If they want the composite behavior, they need the
MCP server.

## What this skill will not do

- Won't write business logic — cart math, tax, fulfillment, etc.
- Won't pick a frontend tokenization strategy (EPD Elements vs hosted checkout
  vs embedded SDK) — that's a product decision, see <https://docs.api.epd.com/>.
- Won't generate webhook signature verification — load `epd-webhooks`.
- Won't operate against a live EPD Commerce account — that's the workflow skills under
  `workflows/`, loaded by an MCP-connected agent.
