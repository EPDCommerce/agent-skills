---
name: epd-catalog
description: Use when an operator-agent connected to the EPD Commerce MCP server needs to manage what is for sale or place a one-off order against it. Triggers when the user asks to create or update a product, change a price, manage product images, asks what plans exist or what a plan contains, asks to place or charge an order for a customer, or hits a shipping-address or line-item error while ordering. Skip when the task is recurring billing on a subscription - load epd-subscriptions. Skip when the task is discounting rather than pricing - load epd-coupons.
compatibility: Requires an MCP-connected agent authenticated against an EPD Commerce account with a full-access key.
metadata:
  version: 1.0.0
  api_version: "2026-02-11"
---

# Products, plans and orders

The catalog and the one-off purchase against it. Eleven tools: seven for
products, two read-only for plans, and `create_order` / `process_order`.

Tiers per
[SAFETY.md](https://github.com/EPDCommerce/agent-skills/blob/main/SAFETY.md):
`list_products`, `get_product`, `list_plans` and `get_plan` are **T0**.
`create_product`, `update_product`, `reorder_product_images` and `create_order`
are **T2**. `delete_product`, `delete_product_image` and `process_order` are
**T3** — the deletes are irreversible and `process_order` charges a card.

`reorder_product_images` has **no `idempotency_key` parameter**, so it cannot be
safely retried on a timeout. Read the product back with `get_product` instead.

## Routing

| If the task is | Load |
|---|---|
| Recurring billing, changing or cancelling a subscription | `epd-subscriptions` |
| Creating a discount rather than setting a price | `epd-coupons` |
| Money going back to a customer | `epd-refunds` |
| Why a charge failed | `epd-transaction-triage` |

## Creating a product

Five fields are required, not the two you would guess:

```
tool: create_product
input:
  name: Data Export Add-on
  description: CSV and JSON export capability
  pricing:
    amount: 2999
    currency: usd
  requires_shipping: false
  sku: data-export-addon
  idempotency_key: <UUID v4>
```

`description` and `requires_shipping` are both required. Omitting `description`
returns `invalid_type` — "expected string, received undefined" — which reads
like a type bug rather than a missing field. Do not guess a description to get
past it; ask.

**`requires_shipping` is the most consequential field on the form**, and it is a
permanent property of the product from the ordering side. Set it wrong and every
future order for that product is wrong. See the shipping constraint below.

| Field | Rule |
|---|---|
| `pricing.amount` | cents, minimum **1**. `0` returns `value_too_small`. `2999` is $29.99. |
| `pricing.currency` | documented as lowercase ISO 4217; `"USD"` is also accepted |
| `sku` | must match `/^[a-z0-9_-]+$/`. Uppercase or spaces return `invalid_format` |
| `metadata` | up to 50 pairs, 40-char keys, 500-char values |

A SKU is not a display name. `"Data Export Add-on"` is rejected;
`data-export-addon` is fine.

Price changes go through `update_product`. There is no price history and no
scheduled change — the new price applies to the next order. Existing orders keep
what they were charged.

## Product images

`delete_product_image` is **T3** and irreversible; `reorder_product_images` is
T2 with no idempotency key.

Reordering replaces the whole ordering, so read the current images with
`get_product` first and send the full sequence. Sending a partial list is how an
image silently drops out of position.

## Plans are read-only here

`list_plans` and `get_plan` only. Plans are created elsewhere; this skill looks
them up so an order or a subscription can reference one.

A plan carries more than a price:

```json
{
  "name": "SMS Pack Monthly",
  "type": "product_based",
  "plan_code": "sbx-plan-sms-mo",
  "amount": 3999,
  "one_time_amount": 0,
  "currency": "usd",
  "billing_cycle": { "interval": "day", "interval_count": 30, "anchor_day": 1 },
  "billing_cycles": 0,
  "products": [ … ],
  "pricing_tiers": [ … ]
}
```

Two things that catch people. `billing_cycle` can be `{interval: "day",
interval_count: 30}` — that is a 30-**day** cycle, not a calendar month, and the
two drift apart over a year. And a plan wraps `products`, so a plan's price and
its product's price are separate numbers that can disagree.

Starting a subscription against a plan is `epd-subscriptions`, not this skill.

## Placing an order

```
tool: create_order
input:
  customer_id: <uuid>
  payment_method_id: <uuid>
  items:
    - product_id: <uuid>
      quantity: 1
  idempotency_key: <UUID v4>
```

**Price always comes from the catalog.** There is no amount field on an order
line — you cannot charge a different price for a product without changing the
product or applying a coupon. If a user asks to "just charge them $50", that is
either a new product, a coupon, or a conversation.

`idempotency_key` is **required** here, unlike most writes. It is a money-moving
call and the server insists.

Line-item rules, all observed:

| Attempt | Result |
|---|---|
| `quantity: 0` | `value_too_small` — minimum 1 |
| `quantity: 10000` | `value_too_large` — maximum 9999 |
| `items: []` | `value_too_small` — "expected array to have >=1 items" |
| unknown `product_id` | `resource_not_found`, naming the id |

`create_order` is T2 and supports coupons and shipping. `process_order` is T3,
supports neither, and leaves a failed order row behind with no rollback. Prefer
`create_order` unless you specifically want the customer-validation step — see
`epd-mcp-operator`'s composites section.

## The shipping constraint

This is the ordering rule that most often rejects an order, and the mixed-cart
case is the one nobody predicts.

An order needs a shipping address if **any** line item has
`requires_shipping: true`. Not most items. Not the majority of the value. One.

Measured:

| Cart | Address | Result |
|---|---|---|
| physical only | none | `shipping_address_required` |
| physical only | provided | order created |
| digital only | none | order created |
| **one digital + one physical** | none | **`shipping_address_required`** |

```
shipping_address_required
"A shipping address is required when ordering products that require shipping.
 Provide either shipping_address_id or shipping_address."
```

So a cart of nine downloads and one T-shirt is a physical order. When an order
is rejected this way, do not remove the address requirement — find which item
requires shipping. `get_product` on each line item answers it.

Supply the address one of two ways, **never both**:

```
shipping_address_id: <uuid>       an address already saved on the customer
shipping_address: { … }           inline: first_name, last_name, address_line1,
                                  city, state, postal_code, country
```

Sending both returns `validation_error` — "Provide either shipping_address_id or
shipping_address, not both."

## Coupons on an order

Pass `coupon_code` on `create_order`. Lookup is case-insensitive.

**A bad coupon fails the whole order.** The order is not created and no money
moves:

```
coupon_code: "NOSUCH-CODE"  ->  code_not_found, "Coupon code does not exist."
```

That is the safe behaviour, but it means a typo in a code looks like an ordering
failure. Validate first with `validate_coupon` — it is T0, creates nothing, and
tells you *why* a code will not work. See `epd-coupons`.

A successful application shows in the response:

```json
{ "subtotal": 1500, "discount_amount": 375, "total": 1125,
  "applied_coupon": { "code": "…", "percentage": 25, "discount_amount": 375 } }
```

`subtotal` is before discount, `total` after. Quote `total` as the charge.

**Watch the per-customer cap.** `max_redemptions_per_customer` defaults to **1**
on a promo coupon. A second order for the same customer with the same code
returns:

```
customer_limit_reached
"Customer has already used this coupon the maximum number of times."
```

That default is not stated at creation time, so a promotion intended as "use it
whenever" is one-per-customer unless someone set the field. If a customer says a
code worked once and now does not, this is the first thing to check.

## What this skill will not do

- **Charge an arbitrary amount.** Price comes from the catalog. A different
  price means a different product or a coupon.
- **Set `requires_shipping` by inference.** Ask. It changes every future order
  for that product.
- **Remove a shipping address to make an order go through.** Find the item that
  requires it.
- **Retry `reorder_product_images` on a timeout.** No idempotency key — read the
  product back instead.
- **Create or change a plan.** Read-only here.
- **Start a subscription.** That is `epd-subscriptions`, even when the plan was
  looked up here.
- **Delete a product to fix a pricing mistake.** `delete_product` is T3 and
  irreversible; `update_product` changes the price.
