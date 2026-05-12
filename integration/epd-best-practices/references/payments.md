# Payments — one-time charges and orders

The EPD Commerce primary payment object is the **Order**. An order represents an attempt
to charge a customer for one or more items at the moment of creation —
creating an order processes the charge synchronously.

For recurring billing, see `subscriptions.md`. For composite flows that create
a customer and charge in one call, see "Composite endpoints" in `SKILL.md`
(MCP only — REST integrations chain primitives).

## Minimal one-time charge — REST flow

The end-to-end REST integration is three steps:

1. **Customer exists**: `POST /v1/customers` (or look up by email).
2. **Card is on file**: `POST /v1/customers/{id}/payment_methods` —
   the body is a **vault `billing_id`**, not raw card data. See
   `security.md` for how the card reaches the vault.
3. **Process the charge**: `POST /v1/orders`.

### Create the customer (if you don't have one)

```http
POST /v1/customers HTTP/1.1
Authorization: Bearer epd_test_sk_...
EPD-Version: 2026-02-11
X-EPD-Idempotency-Key: <uuid v4>
Content-Type: application/json

{
  "email": "alice@example.com",
  "first_name": "Alice",
  "last_name": "Liddell",
  "phone": "+14155551234"
}
```

Response: `{ "id": "<bare uuid>", "object": "customer", ... }`. Store the ID.

### Attach a payment method

The dev's frontend tokenizes the card via the EPD Commerce Gateway vault (separate
from the API — see `security.md`). The vault returns a numeric `billing_id`.

```http
POST /v1/customers/{customer_id}/payment_methods HTTP/1.1
Authorization: Bearer epd_test_sk_...
EPD-Version: 2026-02-11
X-EPD-Idempotency-Key: <uuid v4>
Content-Type: application/json

{
  "billing_id": "12345678",
  "set_as_default": true
}
```

Response: `{ "id": "<bare uuid>", "card": { "brand": "visa", "last4": "4242", ... } }`.

> **`payment_method_id` is the only ID that requires a bare UUID on input.**
> Don't prefix it with `pm_` — that returns 400 `invalid_payment_method_id`.

### Create the order

```http
POST /v1/orders HTTP/1.1
Authorization: Bearer epd_test_sk_...
EPD-Version: 2026-02-11
X-EPD-Idempotency-Key: <uuid v4>
Content-Type: application/json

{
  "customer_id": "<bare uuid or cus_<uuid>>",
  "payment_method_id": "<bare uuid only>",
  "items": [
    { "product_id": "prod_<uuid>", "quantity": 1 }
  ],
  "currency": "usd",
  "description": "Pro plan — May 2026"
}
```

The price is taken from the product catalog — you don't (and can't) set it
inline on the order. Update the product's price first if you need a custom
amount.

### Accepted fields on `POST /v1/orders`

Anything outside this list is **rejected** with a per-field validation error
(unknown properties are not silently ignored — the validator runs in
`forbidNonWhitelisted` mode):

| Field                  | Required           | Type / Constraint                                                                      | Notes                                                                                       |
|------------------------|--------------------|----------------------------------------------------------------------------------------|---------------------------------------------------------------------------------------------|
| `customer_id`          | yes                | string, `cus_<uuid>` or bare UUID                                                      | Must exist for this merchant and not be soft-deleted.                                       |
| `payment_method_id`    | yes                | string, **bare UUID only** (no `pm_` prefix)                                           | Must belong to the same `customer_id`.                                                      |
| `items`                | yes                | array, min length 1                                                                    | At least one line item.                                                                     |
| `items[].product_id`   | yes                | string, `prod_<uuid>` or bare UUID                                                     | Must exist for this merchant and not be soft-deleted.                                       |
| `items[].quantity`     | yes                | integer, 1–9999                                                                        |                                                                                             |
| `currency`             | no (default `usd`) | 3 letters, lowercase ISO 4217                                                          | Stored uppercased internally.                                                               |
| `description`          | no                 | string, max 500 chars, no HTML                                                          |                                                                                             |
| `shipping_address_id`  | conditional        | string                                                                                 | Use this **or** `shipping_address`, never both. Must belong to `customer_id`.               |
| `shipping_address`     | conditional        | object — see below                                                                     | Mutually exclusive with `shipping_address_id`.                                              |
| `metadata`             | no                 | object — max 50 keys, keys ≤ 40 chars, values ≤ 500 chars, no HTML                     |                                                                                             |
| `source`               | no                 | enum: `hosted`, `vpt`, `subscription`, `woocommerce`, `api`                            | Public source label; defaults to `hosted`.                                                  |

A `shipping_address` (when provided) is an object with: `first_name`,
`last_name`, `address_line1`, `address_line2?`, `city`, `state`,
`postal_code`, `country` (ISO 3166-1 alpha-2 uppercase), `phone?` (E.164).

Shipping is **only required** when any product in `items` has
`requires_shipping: true`. Omitting it for digital-only carts is fine.
Missing it for a shippable cart returns 400 with code
`shipping_address_required`.

> **`amount` is not an accepted field.** Sending it returns 400 with
> `field_errors: [{ field: "amount", message: "Property amount should not exist" }]`.
> The order total is computed from the product catalog at request time. To
> change what gets charged, update the product price first.

Response on success:

```json
{
  "id": "<bare uuid>",
  "object": "order",
  "status": "succeeded",
  "amount": 2999,
  "currency": "usd",
  "customer_id": "<bare uuid>",
  "created_at": "2026-05-08T14:32:11Z",
  "transactions": [
    { "id": "<txn uuid>", "status": "succeeded", "amount": 2999 }
  ]
}
```

Response on decline:

```json
{
  "id": "<bare uuid>",
  "object": "order",
  "status": "failed",
  "failure_reason": "transaction_not_allowed",
  "transactions": [
    { "id": "<txn uuid>", "status": "failed", "amount": 2999 }
  ]
}
```

A failed order **still returns 200** with `status: "failed"`. The HTTP layer
succeeded; the payment didn't. Don't retry the order automatically — show the
customer the failure and let them try a different card.

## Idempotency — order-specific guidance

The `X-EPD-Idempotency-Key` rules from `SKILL.md` apply, plus:

- One key covers the entire order lifecycle. If the network drops and you
  retry with the same key, you get the **same order back** — not a second
  charge.
- A new cart attempt (customer adds another item, retries checkout) is a
  **new logical operation** — generate a new key.
- If the order returned `status: "failed"`, the key is "spent" — that key
  represents that failed attempt. To try again with a different card, generate
  a new key.

## Listing & filtering orders

```http
GET /v1/orders?customer_id=<id>&status=succeeded&limit=50&created_at[gte]=2026-05-01T00:00:00Z
```

Filter parameters:

- `customer_id` — exact UUID (with or without prefix).
- `status` — comma-separated list. Values: `succeeded`, `failed`, `pending`,
  `voided`, `partially_refunded`, `refunded`, `chargeback`.
- `created_at[gt]`, `created_at[gte]`, `created_at[lt]`, `created_at[lte]` —
  ISO 8601 strings.
- `amount[gt]`, `amount[gte]`, `amount[lt]`, `amount[lte]` — integer cents.
- `sort` — `created_at` (default desc), prefix with `-` for asc.
- `expand` — comma-separated list of related objects to inline:
  `customer`, `items`, `transactions`.

Pagination as documented in `SKILL.md` — `limit`, `starting_after`,
`ending_before`, response includes `cursors.next`.

## Order vs Transaction

An **order** is the customer-facing record (cart contents, intent, total). A
**transaction** is one charge attempt (an order can have multiple if you
retry, or if the order was partially refunded — each refund is a transaction).

For refund operations, this distinction matters:

- `refund_order` refunds the order's total or a portion of it; EPD Commerce picks the
  underlying transactions to refund against.
- `refund_transaction` refunds a specific transaction directly. Use this when
  you know exactly which transaction to refund (e.g. multi-capture flows).

See `refunds.md` for the decision tree.

## Common bugs to avoid

1. **Sending `amount` on the order body.** Rejected with `Property amount
   should not exist`. Price comes from the product catalog — update the
   product first if you need a different total.
2. **Reusing the same idempotency key for two cart attempts.** First attempt
   succeeded → second attempt returns the cached first response → the
   customer believes the second purchase succeeded too. Generate a new key
   per checkout.
3. **Auto-retrying on a failed order.** A `status: "failed"` order is not a
   retriable condition — it's a customer-action condition. Surface the
   failure, let the customer pick a new card.
4. **Prefixing `payment_method_id`.** Always bare UUID on input. Other IDs
   accept prefixes; this one doesn't.
5. **Forgetting `EPD-Version`.** Without it, the merchant's account-default
   version applies, which changes when they upgrade. Pin yours.
6. **Permuting the body when the error has no `field_errors`.** If the
   response is `validation_error` with no `field_errors` and no `param`,
   the body already passed validation — see `errors.md` "Diagnostic" section
   and `debugging.md`. Stop changing the JSON; check resource state and
   capture the `request_id` for escalation.

## Where to go next

- Recurring billing → `subscriptions.md`
- Refunding this order → `refunds.md`
- Handling `transaction_not_allowed` and other failure reasons → `errors.md`
- Sandbox card numbers for testing → `testing.md`
