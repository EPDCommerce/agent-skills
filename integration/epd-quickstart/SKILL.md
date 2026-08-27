---
name: epd-quickstart
description: Use when a developer is integrating EPD Commerce for the first time and needs the minimal end-to-end path — getting a sandbox API key, creating a customer, attaching a payment method, creating a product, and making the first test charge. Triggers when the user says "first time", "getting started", "set up EPD", "make my first charge", or asks for a quickstart / hello-world flow against EPD Commerce. Skip when the user is past first-charge and is asking general integration questions — load epd-best-practices for that.
compatibility: Any backend with HTTP + JSON; curl examples shown but applicable to any language.
metadata:
  version: 1.0.0
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

Expect `200 OK` with the account JSON. `401 missing_api_key` /
`401 invalid_api_key` means the key didn't paste correctly — repeat step 1.

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

This quickstart is pure curl, with no browser to run the EPD Elements SDK,
so it uses the sandbox's legacy **test card token** shortcut — a string
starting with `card_` passed as `billing_id`. The always-succeeds Visa token
is `card_visa`. The full list lives in
`epd-best-practices/references/testing.md`.

```bash
curl -s "https://api.epd.com/v1/customers/$CUSTOMER_ID/payment_methods" \
  -X POST \
  -H "Authorization: Bearer $EPD_API_KEY" \
  -H "EPD-Version: 2026-02-11" \
  -H "X-EPD-Idempotency-Key: $(uuidgen)" \
  -H "Content-Type: application/json" \
  -d '{
    "billing_id": "card_visa",
    "set_as_default": true
  }'
```

Save the returned `id` as `PAYMENT_METHOD_ID`. **It is a bare UUID — never
prefix it with `pm_` on input.**

For the decline path used in step 7, save a second payment method with
`billing_id: "card_visa_declined"` as `DECLINE_PAYMENT_METHOD_ID`.

> **Beyond this quickstart:** `billing_id` (and its `card_` sandbox tokens)
> is the legacy way to get a card on file. Current integrations use either
> a browser-captured `card_token` from the **EPD Elements** SDK (with a
> publishable key), or — for a headless backend like this one — POST the
> card straight to `https://secure.epd.com` with your secret key, which
> creates the payment method in one call. See
> `epd-best-practices/references/security.md` for both flows.

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
URL-safe), `requires_shipping` (boolean), `pricing.amount` (integer cents,
≥1), `pricing.currency` (ISO 4217 lowercase). Save the returned `id` as
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

Expect `status: "succeeded"` in the response. The dashboard's Orders view
will show this as a test charge.

## Step 7 — Confirm the decline path

Run step 6 again, replacing `$PAYMENT_METHOD_ID` with
`$DECLINE_PAYMENT_METHOD_ID` and a fresh idempotency key.

Expected response:

```json
{
  "id": "...",
  "object": "order",
  "status": "failed",
  "failure_reason": "transaction_not_allowed",
  ...
}
```

The HTTP status is **200**, not 4xx — the request succeeded; the payment
didn't. **Branch on `status`, not on HTTP status.** Worth confirming live
once before you build out — it's a common foundational mistake.

## What you've validated

- Authentication, version pinning, and idempotency headers all wired up.
- Customer, payment method, product, and order creation against the sandbox.
- Both success and decline paths return the expected shapes.

## Next

- `epd-best-practices` — reusable HTTP wrapper, subscriptions, refunds,
  pagination, filtering, production key handling.
- `epd-webhooks` — wire up event handlers and signature verification.

## One thing not to copy from this skill

The curl examples generate a fresh UUID per call (`$(uuidgen)`). In real
code, **persist the idempotency key** as part of your operation's state so
you can retry with the same key on failure. A key that only exists in a
local variable is gone on the next process start — useless for actual
deduplication.
