---
name: epd-onboard-customer
description: Use when an operator-agent connected to the EPD Commerce MCP server needs to onboard a new customer end-to-end — vault a card, create the customer record, attach the payment method, and optionally make the first charge or start a subscription. References MCP tool names (create_customer, add_payment_method, create_customer_and_charge, create_customer_and_subscribe), not REST endpoints. Triggers when the user says "onboard a customer", "sign up a new customer with a card", or chains together customer creation + payment method + first charge or subscription. Skip when the dev is integrating from their own backend — load the integration skill epd-best-practices instead.
compatibility: Requires an MCP-connected agent authenticated against an EPD Commerce account; not for direct REST integration.
metadata:
  version: 1.0.0
  api_version: "2026-02-11"
---

# Onboarding a customer through the EPD Commerce MCP server

You are operating an EPD Commerce merchant account through the MCP server, not
writing integration code. Tools used here are MCP tool calls, not REST
endpoints. The agent has been authenticated as the merchant — every action
runs against their live (or sandbox) account.

## When to use which tool

EPD Commerce provides composite tools that bundle the end-to-end onboarding into a
single idempotent operation. Prefer them when the workflow matches:

| Scenario                                            | Tool                              |
|-----------------------------------------------------|-----------------------------------|
| Sign up + charge for a one-time purchase            | `create_customer_and_charge`      |
| Sign up + start a recurring subscription            | `create_customer_and_subscribe`   |
| Sign up but no charge yet (e.g. trial gated by email) | Primitives — see below           |
| Customer exists; just add a card                    | `add_payment_method`              |
| Customer exists with card; just charge them         | `create_order` or `process_order` |

Composite tools accept one `idempotency_key` covering the whole chain. On
partial failure (e.g. customer created, charge declined), the response tells
you what was created and whether server-side rollback succeeded — see
"Partial failures" below.

## Composite — `create_customer_and_charge`

Use when the user wants to sign up a customer and immediately bill them.

```
tool: create_customer_and_charge
input:
  email: alice@example.com
  first_name: Alice
  last_name: Liddell
  phone: "+14155551234"
  card_token: "cct_..."         # browser-captured token — see "Getting a card on file"
  items:
    - product_id: <product uuid>
      quantity: 1
  currency: usd
  description: "Signup bonus charge"
  idempotency_key: <UUID v4>    # required on this tool
```

`card_token` is the only card field this tool accepts — no `billing_id`, no
nested `customer` object, no `amount` (the price comes from each item's
product). Because a `card_token` only comes from a browser running EPD
Elements, this composite is for **browser-based** signups. A headless
integration (no browser) can't call it directly — see "Getting a card on
file" below for the alternative chain.

On success, returns the new `customer`, `payment_method`, and `order` objects.

If the customer creation succeeds but the charge fails, the tool attempts to
**roll back the customer creation** so you don't end up with an orphaned
customer record from a failed signup attempt.

## Composite — `create_customer_and_subscribe`

Use when the user wants signup + recurring billing.

```
tool: create_customer_and_subscribe
input:
  email: alice@example.com
  first_name: Alice
  last_name: Liddell
  phone: "+14155551234"
  card_token: "cct_..."
  plan_id: <plan uuid>
  billing_cycle:
    interval: month
    interval_count: 1
    anchor_day: 1
  start_date: "2026-05-15"     # optional — defaults to today
  idempotency_key: <UUID v4>   # required on this tool
```

Same rule as above: `card_token` only, no `billing_id`. Browser-based signups
only — see "Getting a card on file" for the headless alternative.

The `start_date` lets you backdate or future-date the first cycle. Common
patterns:

- **Trial expiring today** → `start_date` = today, but no immediate charge
  (handled by the plan's `trial_period_days` config).
- **Pro-rated mid-month signup** → `start_date` = today, plan's anchor_day
  controls the next cycle.
- **Future activation** → `start_date` in the future, no charge until then.

## Getting a card on file — `card_token` vs the headless path

None of the values below is a card number. `add_payment_method` and the two
composite tools above accept **`card_token` only** — a single-use `cct_...`
token that a browser produces by running the **EPD Elements** SDK with a
publishable key. That token expires 15 minutes after capture. Since it can
only come from a browser, an MCP-connected agent operating headlessly (no
browser in the loop) cannot produce one itself and cannot call
`add_payment_method` or the composites directly.

For a headless onboarding — an agent signing up a customer with a card
supplied out-of-band (phone, back-office, migration) — chain primitives
instead, and get the card on file via `secure.epd.com` rather than
`add_payment_method`:

```
1. create_customer (MCP)                        → customer_id
2. POST https://secure.epd.com (secret key)      → payment_method_id
   body: { customer_id, card: { number, exp_month, exp_year, cvc }, ... }
3. create_order / create_subscription (MCP)      → uses payment_method_id
```

`secure.epd.com` is a PCI-scoped proxy separate from the EPD Commerce API —
the raw card is forwarded straight to it and never reaches your MCP server
or the main API. See `epd-best-practices/references/security.md` for the
full request/response shape and the PCI-scope tradeoff of handling a raw PAN
this way, even briefly.

For a **browser-based** integration (a web or mobile frontend sits between
the customer and you), use the browser flow instead:

```
1. Frontend captures the card with EPD Elements (publishable key).
2. It receives a single-use card_token (cct_...).
3. Frontend sends the card_token to the operator (you).
4. Operator passes card_token to add_payment_method, or to
   create_customer_and_charge / create_customer_and_subscribe.
```

**Never let a raw card number reach you directly** (outside the
`secure.epd.com` call, which is built for exactly that). If you see anything
that looks like a 16-digit card number where a `card_token` or
`payment_method_id` should be, refuse the operation and surface it as an
error — mishandling a PAN puts the merchant into PCI scope they probably
don't want.

Legacy accounts may still reference a numeric `billing_id` from the older
Collect.js / EPD Gateway vault flow — it's still accepted on the REST
`payment_methods` endpoint, but it is **not** available on this MCP surface.
If an operator hands you a `billing_id`, that's a legacy integration; there
is no MCP tool that accepts it directly.

## Primitives — when composites don't fit

If the workflow doesn't match a composite (e.g. signup with no charge, or
multi-step verification before billing), chain primitives. Which primitive
attaches the card depends on whether you have a browser-captured
`card_token` or are going through the headless `secure.epd.com` path:

```
Browser:
1. create_customer                → customer.id
2. add_payment_method              → payment_method.id (with card_token)
3. (optional) create_order         → order.id
   OR
3. (optional) create_subscription  → subscription.id

Headless:
1. create_customer                          → customer.id
2. POST https://secure.epd.com (secret key) → payment_method_id
3. (optional) create_order                  → order.id
   OR
3. (optional) create_subscription           → subscription.id
```

Each MCP step needs its own idempotency key. If the card-attach step fails
after step 1, the
customer exists without a payment method — you need to handle the cleanup
yourself, deciding from context whether to delete the orphaned record or
keep it for retry.

## Partial failures — composite response shape

Composite tools follow the standard MCP tool-result envelope. The single
field that signals failure is `isError: true`; the structured payload lives
in `content[0].text` as a JSON string:

```json
{
  "isError": true,
  "content": [
    {
      "type": "text",
      "text": "{\"error\":{\"code\":\"partial_rollback_failed\",\"message\":\"Charge step failed and rollback of customer cus_<uuid> also failed — manual cleanup required. Original error: <cause>\"}}"
    }
  ]
}
```

Parse `content[0].text` and read `error.code`. Codes you may see from these
composites:

| `error.code`                  | What happened                                                                                       | What to do                                                                            |
|-------------------------------|-----------------------------------------------------------------------------------------------------|---------------------------------------------------------------------------------------|
| `no_payment_method`           | `create_customer_and_charge` was called without `card_token` and the customer has no card on file.   | Pass `card_token`, or attach a card first via `add_payment_method` (browser) or `secure.epd.com` (headless). |
| `partial_rollback_failed`     | A step in the chain failed AND the automatic rollback of earlier-created resources also failed.      | The `message` names the orphaned `cus_<uuid>` (and `pm_<uuid>` where relevant) — surface it and clean up manually. |
| Any underlying primitive code | The chain failed cleanly and the customer (and payment method, where applicable) was rolled back.    | The error from the failing step bubbles up unchanged. Treat as you would the primitive's error. |

The composite does **not** ship a `created_resources` or `rollback`
sub-object in the success-case envelope. If rollback succeeded, the
underlying cause is the only thing surfaced. If rollback failed, the
orphaned ID(s) are embedded inside `error.message` — parse them out of the
message string, or query the customer list to reconcile.

Confirmation rule of thumb: if `error.code === "partial_rollback_failed"`,
you have orphaned state and should escalate to the operator. Never silently
swallow it.

## Idempotency rules — same as REST, with one twist

In MCP, `idempotency_key` is a **body parameter** in the tool input, not an
HTTP header. Generate UUID v4 per logical operation. On retry, use the same
key — the cached response comes back, no double-execution.

Composite tools cache the **whole chain's result** under one key, so a retry
of a half-completed composite returns the partial-failure response, not a
fresh execution.

## Confirming destructive operations

`create_customer_and_charge` is annotated `destructiveHint: true` because it
moves money. Confirm with the user before invoking:

> "This will create customer Alice Liddell and charge $29.99 to the card
> ending in 4242. Proceed?"

For `create_customer_and_subscribe`, confirm the recurring nature:

> "This will create customer Alice Liddell and start a $29.99/month
> subscription billed on the 1st. Proceed?"

After successful execution, surface the order/subscription ID so the user
can find it in the dashboard.

## Common operator mistakes

1. **Treating `card_token`, `billing_id`, or a `payment_method_id` as a card
   number.** All three are opaque references. If you don't have one, say
   so — don't fabricate one or ask the user for raw card data.
2. **Calling `add_payment_method` or a composite tool without a
   browser-captured `card_token`.** These tools have no other card input on
   the MCP surface. For a headless flow, go through `secure.epd.com`
   instead — see "Getting a card on file".
3. **Using a semantic idempotency key like `"signup-alice"`.** Collides
   trivially. Generate a UUID v4 per call.
4. **Re-running a failed composite without the same idempotency key.**
   Risk of duplicate customer or duplicate charge. Use the same key for
   true retries; new key only for genuinely new attempts.
5. **Skipping confirmation on charge tools.** Anything that moves money
   should be confirmed before execution.

## Where to go next for the operator

- Subscription lifecycle (change plan, cancel, recover past_due) → `epd-subscriptions`
- Refunds → `epd-refunds`
- Customer financial summary, revenue reports → individual MCP tools
  (`get_customer_financial_summary`, `get_revenue_summary`)
