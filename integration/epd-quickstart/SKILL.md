---
name: epd-quickstart
description: Use when a developer is integrating EPD Commerce for the first time and needs the minimal end-to-end path in code — getting a sandbox API key, creating a customer, attaching a payment method, creating a product, making the first test charge, and confirming a decline. Triggers when the user says "first time", "getting started", "set up EPD", "make my first charge", or asks for a quickstart / hello-world flow against EPD Commerce. Skip when the user is past first-charge and is asking general integration questions — load epd-best-practices for that. Skip when an MCP-connected agent is being asked to onboard a real customer on an account rather than to write code — load epd-mcp-operator, which routes to epd-onboard-customer.
compatibility: Any backend with HTTP + JSON; curl examples shown but applicable to any language.
metadata:
  version: 1.1.0
  api_version: "2026-02-11"
---

# EPD Commerce — quickstart

Goal: from zero to a successful test charge in fifteen minutes. After this,
load `epd-best-practices` for everything else.

## Prerequisites

- An EPD Commerce account. Sign up at <https://commerce.epd.com/auth>.
- A backend with an HTTP client + JSON support.
- A UUID generator (`uuidgen` on macOS/Linux, `[guid]::NewGuid()` on
  PowerShell, `crypto.randomUUID()` in Node, `uuid.uuid4()` in Python).

## Step 1 — Get a sandbox API key

1. Log in to the EPD Commerce dashboard and switch the environment toggle to
   **Test mode**.
2. Go to **Developers → API keys → Create secret key**. Name it (e.g.
   `local-dev`) and copy the value — keys start with `epd_test_sk_` and are
   shown once. Save it to your secret manager or local `.env`:

   ```bash
   # .env
   EPD_API_KEY=epd_test_sk_...
   ```

3. Confirm `.env` is in `.gitignore`.

## Step 2 — Verify the key

```bash
curl -s https://api.epd.com/v1/account \
  -H "Authorization: Bearer $EPD_API_KEY" \
  -H "EPD-Version: 2026-02-11"
```

Expect `200 OK` with the account JSON, including `"is_sandbox": true`. A 401
means the key didn't paste correctly — repeat step 1: `missing_api_key` (no
header), `invalid_api_key_format` (not an `epd_…_sk_` key at all) or
`invalid_api_key` (right shape, wrong value).

## Step 3 — Create a test customer

```bash
curl -s https://api.epd.com/v1/customers \
  -X POST \
  -H "Authorization: Bearer $EPD_API_KEY" \
  -H "EPD-Version: 2026-02-11" \
  -H "X-EPD-Idempotency-Key: $(uuidgen)" \
  -H "Content-Type: application/json" \
  -d '{
    "email": "alice@example.com",
    "first_name": "Alice",
    "last_name": "Liddell",
    "phone": "+14155551234"
  }'
```

Save the returned `id` as `CUSTOMER_ID`.

## Step 4 — Attach a sandbox card

This quickstart is pure curl with no browser, so it uses the headless
`secure.epd.com` path: POST the card with your secret key and a PCI-scoped
proxy tokenizes the PAN (it never reaches the main API) and creates the
payment method in one call. Use the sandbox test PAN `4111 1111 1111 1111`
(always succeeds).

```bash
curl -s "https://secure.epd.com" \
  -X POST \
  -H "Authorization: Bearer $EPD_API_KEY" \
  -H "Content-Type: application/json" \
  -d '{
    "customer_id": "'"$CUSTOMER_ID"'",
    "card": { "number": "4111111111111111", "exp_month": "12", "exp_year": "2030", "cvc": "123" },
    "set_as_default": true
  }'
```

Save the returned `id` as `PAYMENT_METHOD_ID`. **It is a bare UUID — never
prefix it with `pm_` on input.**

> **Other ways to get a card on file:** in a browser integration, capture a
> `card_token` (`cct_…`) with the **EPD Elements** SDK (publishable key) and
> attach it via `POST /v1/customers/{id}/payment_methods`. A legacy sandbox
> shortcut also exists — pass a `card_` test token (e.g. `card_visa`) as
> `billing_id` to that same endpoint — but `billing_id` is deprecated; prefer
> `secure.epd.com` or `card_token`. See
> `epd-best-practices/references/security.md`.

## Step 5 — Create a product

Order amounts come from product pricing — you can't price an order inline.

```bash
curl -s https://api.epd.com/v1/products \
  -X POST \
  -H "Authorization: Bearer $EPD_API_KEY" \
  -H "EPD-Version: 2026-02-11" \
  -H "X-EPD-Idempotency-Key: $(uuidgen)" \
  -H "Content-Type: application/json" \
  -d '{
    "name": "Hello World Pro",
    "description": "Quickstart product for first-charge validation.",
    "sku": "hello-world-pro",
    "requires_shipping": false,
    "pricing": {
      "amount": 2999,
      "currency": "usd"
    }
  }'
```

Required fields: `name` (3–80), `description` (3–2000), `sku` (3–30,
lowercase letters, digits, `-` and `_` only, unique per account),
`requires_shipping` (boolean), `pricing.amount` (integer cents, ≥1),
`pricing.currency` (ISO 4217 lowercase). A second run with the same `sku`
fails with `sku_already_exists` — change it. Save the returned `id` as
`PRODUCT_ID`.

## Step 6 — Charge the always-succeeds card

```bash
curl -s https://api.epd.com/v1/orders \
  -X POST \
  -H "Authorization: Bearer $EPD_API_KEY" \
  -H "EPD-Version: 2026-02-11" \
  -H "X-EPD-Idempotency-Key: $(uuidgen)" \
  -H "Content-Type: application/json" \
  -d "{
    \"customer_id\": \"$CUSTOMER_ID\",
    \"payment_method_id\": \"$PAYMENT_METHOD_ID\",
    \"items\": [{\"product_id\": \"$PRODUCT_ID\", \"quantity\": 1}],
    \"currency\": \"usd\",
    \"description\": \"My first EPD Commerce charge\"
  }"
```

Expect HTTP `201` and `status: "succeeded"` in the response. The
dashboard's Orders view will show this as a test charge.

## Step 7 — Confirm the decline path

The headless `secure.epd.com` path has no card number that declines in
sandbox — `4000 0000 0000 0002` was accepted and charged successfully when
this was last checked (18 September 2026). So the decline path uses the
sandbox-only legacy tokens instead: attach `card_visa_declined` as a
`billing_id` to a **new** customer (create one as in step 3 and save it as
`DECLINE_CUSTOMER_ID`):

```bash
curl -s "https://api.epd.com/v1/customers/$DECLINE_CUSTOMER_ID/payment_methods" \
  -X POST \
  -H "Authorization: Bearer $EPD_API_KEY" \
  -H "EPD-Version: 2026-02-11" \
  -H "X-EPD-Idempotency-Key: $(uuidgen)" \
  -H "Content-Type: application/json" \
  -d '{ "billing_id": "card_visa_declined" }'
```

Save the returned `id` as `DECLINE_PAYMENT_METHOD_ID`, then run step 6 again
with `$DECLINE_CUSTOMER_ID`, `$DECLINE_PAYMENT_METHOD_ID` and a fresh
idempotency key. Use a separate customer: in sandbox, a customer who has just
had several declines was seen to decline even on a succeeding test card.

Expected response:

```json
{
  "id": "...",
  "status": "failed",
  "failure_code": "processor_declined",
  "failure_reason": "processor decline",
  ...
}
```

The HTTP status is **201**, not 4xx — the order was created; the payment
wasn't taken. **Branch on `status`, not on HTTP status**, then on
`failure_code`, which is the machine value; `failure_reason` is prose for
humans. Every sandbox decline token returns `processor_declined` — see
`epd-best-practices/references/testing.md` — so this proves your decline
branch runs, not which decline it was. Worth confirming once before you build
out — treating a declined order as a success is a common foundational
mistake.

## What you've validated

- Authentication, version pinning, and idempotency headers all wired up.
- Customer, payment method, product, and order creation against the sandbox.
- Both success and decline paths return the expected shapes.

## Next

- `epd-best-practices` — reusable HTTP wrapper, subscriptions, refunds,
  pagination, filtering, production key handling.
- `epd-webhooks` — wire up event handlers and signature verification.
- `epd-mcp-operator` — if the next step is an agent operating the account
  over MCP rather than code calling the REST API.

## One thing not to copy from this skill

The curl examples generate a fresh UUID per call (`$(uuidgen)`). In real
code, **persist the idempotency key** as part of your operation's state so
you can retry with the same key on failure. A key that only exists in a
local variable is gone on the next process start — useless for actual
deduplication.
