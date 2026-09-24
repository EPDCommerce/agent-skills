---
skill: epd-catalog
surface: workflow
guide_version: 1.0.0
api_version: "2026-02-11"
---

# epd-catalog — guide

**Skill:** [`workflows/epd-catalog/SKILL.md`](../workflows/epd-catalog/SKILL.md) ·
**Policy:** [`SAFETY.md`](../SAFETY.md) ·
**Safety layer:** [`epd-mcp-operator`](./epd-mcp-operator.md)

What is for sale, and the one-off purchase against it. Twelve tools: seven for
products, two read-only for plans, and `create_order` / `process_order` /
`retry_order`.

## What it does

**Products** — create, read, list, update, delete, plus image deletion and
reordering. Five fields are required at creation, not the two most people
expect:

| Field | Rule |
|---|---|
| `name` | 3 to 80 characters |
| `description` | 3 to 2000 characters — **required**; omitting it returns `invalid_type`, "expected string, received undefined", which reads like a type bug rather than a missing field |
| `pricing` | one field, two required values: `amount` in minor units, minimum 1 (`0` returns `value_too_small`), and `currency`, documented lowercase ISO 4217 though `"USD"` is also accepted |
| `sku` | 3 to 30 characters matching `/^[a-z0-9_-]+$/` |
| `requires_shipping` | boolean — **required**, and the most consequential field on the form |

A SKU is not a display name: `"Data Export Add-on"` is rejected,
`data-export-addon` is fine. Lowercase and hyphens are easy to remember; the
30-character ceiling is the bound a descriptive SKU hits first, so check the
length before generating one.

**Plans are read-only here.** `list_plans` and `get_plan` only — plans are
created elsewhere. Two things catch people: a `billing_cycle` of
`{interval: "day", interval_count: 30}` is a 30-*day* cycle, not a calendar
month, and the two drift apart over a year; and a plan wraps `products`, so a
plan's price and its product's price are separate numbers that can disagree.

**Orders** — `create_order` (T2) is the default. `process_order` (T3) takes
nearly the same arguments, supports neither coupons nor shipping, and leaves a
failed order row behind with no rollback. `create_order` does more at a lower
tier; reach for `process_order` only when you specifically want its
customer-validation step.

`idempotency_key` is **required** on `create_order`, unlike most writes. It
moves money and the server insists.

### The shipping constraint, which is the rule that most often rejects an order

An order needs a shipping address if **any** line item has
`requires_shipping: true`. Not most items. Not the majority of the value. One.

| Cart | Address | Result |
|---|---|---|
| physical only | none | `shipping_address_required` |
| physical only | provided | order created |
| digital only | none | order created |
| **one digital + one physical** | none | **`shipping_address_required`** |

So a cart of nine downloads and one T-shirt is a physical order. When an order
is rejected this way, the fix is to find which item requires shipping —
`get_product` on each line answers it — not to remove the requirement.

Supply the address as `shipping_address_id` **or** inline `shipping_address`,
never both; sending both returns `validation_error`.

**In practice only one of those two is reachable from here.**
`shipping_address_id` is described as "an address already saved on the
customer", but **none of the 67 tools lists saved addresses** — there is no
shipping group on this surface, and `get_customer` expands `payment_methods`,
not addresses. So unless the human supplies the ID from the dashboard, the
inline `shipping_address` is the only route an agent can actually take. Ask;
do not produce an address ID you have not been given.

### Coupons on an order

Pass `coupon_code` on `create_order`; lookup is case-insensitive. **A bad code
fails the whole order** — nothing is created and no money moves, which is the
safe behaviour but means a typo looks like an ordering failure. Validate first
with `validate_coupon`, which is T0 and creates nothing.

Watch `max_redemptions_per_customer`: it defaults to **1** on a promo coupon and
that default is not stated at creation time. A promotion intended as "use it
whenever" is one-per-customer unless someone set the field. If a customer says a
code worked once and now does not, check this first.

## When it fires

- Create or update a product, change a price, manage product images.
- *"What plans exist?"* · *"What's in this plan?"*
- Place or charge an order for a customer.
- Retry a failed charge on an existing order.
- A shipping-address or line-item error while ordering.

### What it must not answer

| Near miss | Goes to |
|---|---|
| Recurring billing on a subscription | [`epd-subscriptions`](./epd-subscriptions.md) |
| Discounting rather than pricing | [`epd-coupons`](./epd-coupons.md) |
| Money going back to a customer | [`epd-refunds`](./epd-refunds.md) |
| **Why** a charge failed | [`epd-transaction-triage`](./epd-transaction-triage.md) |

This skill owns `retry_order` and performs the retry; triage decides whether
retrying is sane. That split was a deliberate correction — the Phase A map had
assigned `retry_order` to triage, which conflicts with triage being read-only.
It was resolved the other way, and `audit/matrix.mjs` was corrected to match.

## What it refuses to do, and why

| Refusal | Why |
|---|---|
| **Charge an arbitrary amount.** | There is no amount field on an order line; price always comes from the catalog. "Just charge them $50" is a new product, a coupon, or a conversation — and silently creating a product to satisfy it is the worst of the three. |
| **Set `requires_shipping` by inference.** | It is a permanent property from the ordering side. Set it wrong and every future order for that product is wrong. |
| **Remove a shipping address to make an order go through.** | The rejection is the system working. Find the item that requires shipping. |
| **Retry `reorder_product_images` on a timeout.** | It has no `idempotency_key` parameter, so a retry is a fresh side effect. Read the product back with `get_product` instead. |
| **Send a partial image order.** | Reordering replaces the whole sequence, so a partial list silently drops an image out of position. |
| **Switch the card on `retry_order`.** | There is no such parameter. A different card means a new order — which is exactly why `retry_order` is useless against `expired_card`, `lost_stolen_card`, `transaction_not_allowed` and `incorrect_cvv`. |
| **Decide why a charge failed.** | That is triage, which is read-only and safe to run first. |
| **Create or change a plan.** | Read-only here. |
| **Delete a product to fix a pricing mistake.** | `delete_product` is T3 and irreversible; `update_product` changes the price. There is no price history and no scheduled change — the new price applies to the next order, and existing orders keep what they were charged. |

## What to check afterwards

After creating a product:

- [ ] **`requires_shipping` matches reality.** This is the field to re-read
      aloud, because everything downstream inherits it.
- [ ] The SKU is unique — a repeat returns `sku_already_exists`.
- [ ] The price is in minor units and the confirmation said it in currency.

After an order:

- [ ] **`status` was read, not the HTTP code.** An order can be created and the
      payment declined in the same successful-looking response.
- [ ] If a coupon was applied, **`total` was quoted as the charge**, not
      `subtotal`. The response carries `subtotal`, `discount_amount`, `total`
      and `applied_coupon`.
- [ ] The order ID was surfaced.

After `retry_order` on a subscription cycle:

- [ ] **The cycle reconciled** and the original order's `next_retry_at` is now
      null. That reconciliation is the whole reason to prefer `retry_order`
      here.

## A worked transcript

Illustrative. Constraints, error codes and the measured line-item rules are as
the skill documents them; names, IDs and amounts are placeholders.

---

**Ops:** Add the new onboarding kit — $149, SKU "Onboarding Kit 2026" — and put
through an order for Alice with it plus the data export add-on.

**Agent:** Two things to fix in that before anything is created.

**The SKU will be rejected.** SKUs must match `/^[a-z0-9_-]+$/` and run 3 to 30
characters — uppercase and spaces return `invalid_format`.
`onboarding-kit-2026` is 19 characters and valid. Confirm that is what you want,
because the SKU is the thing your other systems will key on.

**I need `requires_shipping` and I am not going to guess it.** A kit could be a
physical box or a PDF, and the field is permanent from the ordering side — set
it wrong and every future order for the product is wrong. Which is it?

**Ops:** Physical box. And yes, that SKU is fine.

**Agent:**

> I'm about to call **`create_product`** for **Onboarding Kit** at **$149.00
> USD**, SKU `onboarding-kit-2026`, **requires shipping: true**, in **LIVE**
> mode. This creates the catalog entry; nothing is charged. Proceed?

**Ops:** Yes.

```
tool: create_product
input:
  name: Onboarding Kit
  description: Printed onboarding guide, sample pack and quick-start card.
  pricing: { amount: 14900, currency: usd }
  requires_shipping: true
  sku: onboarding-kit-2026
  idempotency_key: 2e7b1c4f-3a9e-4d5c-8a1b-7d9e3f8f9a4d
```

Created: `6f5e4d3c-2b1a-4098-8765-4321fedcba98`.

Now the order. It has two line items and I have an ID for one of them — the kit
I just created. Let me resolve the other by name, and read its shipping flag
while I am there, because that decides whether this order needs an address at
all.

```
tool: list_products
input:
  q: data export
```

```json
{ "data": [
  { "id": "0a1b2c3d-4e5f-4678-89ab-cdef01234567",
    "name": "Data Export Add-on",
    "sku": "data-export-addon",
    "requires_shipping": false,
    "pricing": { "amount": 2999, "currency": "usd" } }
] }
```

One match, at $29.99, and it does **not** require shipping. So this is a mixed
cart — one physical item, one digital — and the rule is that **any** single line
item requiring shipping makes the whole order require an address. Nine downloads
and one T-shirt is a physical order. This one needs an address.

Three more things I need and do not have: Alice's customer ID, the card to
charge, and that address. Two of them I can read.

```
tool: list_customers
input:
  email: alice@example.com
```

One match — `7c5a3d0b-9e42-4b2f-8e10-9f8c2e114d6a`. Now the card, because the
confirmation has to name it and I will not state a brand or last four from
memory:

```
tool: get_customer
input:
  id: 7c5a3d0b-9e42-4b2f-8e10-9f8c2e114d6a
  expand: payment_methods
```

```json
{
  "id": "7c5a3d0b-9e42-4b2f-8e10-9f8c2e114d6a",
  "default_payment_method": "4d6a4b2f-8e10-7c5a-3d0b-9e429f8c2e11",
  "payment_methods": [
    { "id": "4d6a4b2f-8e10-7c5a-3d0b-9e429f8c2e11",
      "card": { "brand": "visa", "last4": "1111", "card_expires": "12/2030" },
      "is_default": true }
  ]
}
```

**The address I cannot look up.** `create_order` takes `shipping_address_id`
for "an address already saved on the customer", but no tool on this surface
lists saved addresses — there is no shipping group among the 67, and the
expansion above returns payment methods, not addresses. So either you give me
the address ID from the dashboard, or I send the address inline. I am not going
to guess a UUID for it.

**Ops:** Send it inline — 12 Rabbit Hole Lane, Oxford, OX1 2JD, GB. Name on it
is Alice Liddell.

**Agent:** Noted. Before I place it — is a discount meant to apply? If a code is
involved I will validate it first, because a bad `coupon_code` fails the entire
order rather than being ignored.

**Ops:** Yes, SUMMER-SALE.

```
tool: validate_coupon
input:
  code: SUMMER-SALE
  customer_id: 7c5a3d0b-9e42-4b2f-8e10-9f8c2e114d6a
  amount: 17899
```

```json
{ "valid": true, "coupon_id": "…", "coupon_name": "Summer Sale", "kind": "promo" }
```

Valid for Alice at this amount. That check was free and it is the difference
between a clean order and a rejection that looks like an ordering bug.

> I'm about to call **`create_order`** for **Alice Liddell**
> (`7c5a3d0b-9e42-4b2f-8e10-9f8c2e114d6a`) in **LIVE** mode: **Onboarding Kit**
> ($149.00) plus **Data Export Add-on** ($29.99), subtotal **$178.99**, coupon
> `SUMMER-SALE` at 15% off, charged to her **Visa ending 1111** (her default
> card), shipping to 12 Rabbit Hole Lane, Oxford OX1 2JD, GB. This charges the
> card. Proceed?

**Ops:** Go.

```
tool: create_order
input:
  customer_id: 7c5a3d0b-9e42-4b2f-8e10-9f8c2e114d6a
  payment_method_id: 4d6a4b2f-8e10-7c5a-3d0b-9e429f8c2e11
  items:
    - { product_id: 6f5e4d3c-2b1a-4098-8765-4321fedcba98, quantity: 1 }
    - { product_id: 0a1b2c3d-4e5f-4678-89ab-cdef01234567, quantity: 1 }
  shipping_address:
    first_name: Alice
    last_name: Liddell
    address_line1: 12 Rabbit Hole Lane
    city: Oxford
    state: Oxfordshire
    postal_code: OX1 2JD
    country: GB
  coupon_code: SUMMER-SALE
  idempotency_key: 4f3a9e2d-5c8a-4b7d-9e3f-8f9a4d2e7b1c
```

```json
{
  "id": "b4c5d6e7-f8a9-4b0c-9d1e-2f3a4b5c6d7e",
  "status": "succeeded",
  "subtotal": 17899,
  "discount_amount": 2684,
  "total": 15215,
  "applied_coupon": { "code": "SUMMER-SALE", "percentage": 15, "discount_amount": 2684 }
}
```

`status: "succeeded"` — and I checked that rather than the response arriving at
all, because an order can be created and the payment declined in the same
otherwise-successful response.

**Alice was charged $152.15**, not $178.99. `total` is the number to quote her;
`subtotal` is before the discount. Order ID
`b4c5d6e7-f8a9-4b0c-9d1e-2f3a4b5c6d7e` for the dashboard.

---

### What the transcript demonstrates

- **Two problems were raised before the first write**, one of which the agent
  refused to resolve itself.
- **`requires_shipping` was asked rather than inferred**, with the reason.
- **The mixed cart was recognised** as a shipping order — after reading the
  second product's `requires_shipping`, not by assuming it from its name.
- **Every value in the confirmation was read first.** The second product's ID
  and price came from `list_products`, the customer ID from `list_customers`,
  and the payment method with the card's brand and last four from
  `get_customer` with `expand: payment_methods`. `SAFETY.md` rule 4 forbids
  inventing any of them, and a confirmation you cannot fill from prior responses
  is one you are not ready to ask.
- **The unobtainable value was named as unobtainable.** There is no tool that
  lists saved shipping addresses, so the agent said so and asked, rather than
  producing a plausible UUID — which is the failure mode rule 4 exists for,
  because a plausible ID is indistinguishable from a real one until it acts on
  the wrong object.
- **The coupon was validated first**, T0 and free, rather than discovering the
  typo as a failed order.
- **`status` was checked on the response**, and `total` rather than `subtotal`
  was quoted as the charge.

## Where it hands off

| If the task is | Load |
|---|---|
| Recurring billing on a plan | [`epd-subscriptions`](./epd-subscriptions.md) |
| Creating or validating the discount itself | [`epd-coupons`](./epd-coupons.md) |
| Money going back | [`epd-refunds`](./epd-refunds.md) |
| Why the charge failed | [`epd-transaction-triage`](./epd-transaction-triage.md) |
| A customer or a card that does not exist yet | [`epd-onboard-customer`](./epd-onboard-customer.md) |
