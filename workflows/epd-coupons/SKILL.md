---
name: epd-coupons
description: Use when an operator-agent connected to the EPD Commerce MCP server needs to create, inspect, validate, mint codes for, or retire a discount. Triggers when the user mentions a coupon, promo code, discount code or voucher, asks to launch or end a promotion, asks to generate a batch of codes, asks whether a code is still valid or why one was rejected, or asks to archive or bring back a coupon. Skip when the task is changing a product's list price rather than discounting it - load epd-catalog. Skip when the question is why a payment failed - load epd-transaction-triage.
compatibility: Requires an MCP-connected agent authenticated against an EPD Commerce account with a full-access key.
metadata:
  version: 1.0.0
  api_version: "2026-02-11"
---

# Coupons on an EPD Commerce account

Nine tools covering the whole life of a discount: create it, mint codes under
it, check whether a code will work, and retire it.

Tiers come from
[`references/tiers.md`](../epd-mcp-operator/references/tiers.md), generated from
the `tools/list` snapshot by `npm run gen:tiers` so it cannot drift. What each
tier requires is defined once in
[SAFETY.md](https://github.com/EPDCommerce/agent-skills/blob/main/SAFETY.md).
Do not hand-maintain a tier list here.

The one worth carrying in your head before reading further: `archive_coupon` is
the only T3 here, because it stops a live promotion.

Every write here takes an optional `idempotency_key`. Pass it anyway.

## Routing

| If the task is | Load |
|---|---|
| Changing a product's list price, not discounting it | `epd-catalog` |
| Why a payment failed | `epd-transaction-triage` |
| What a promotion actually earned | `epd-reporting` |

## The two kinds

Set at creation and not changeable afterwards.

| | `kind: "promo"` | `kind: "generated"` (default) |
|---|---|---|
| Codes | one shared code, minted at create time | many unique codes, minted separately |
| The code is | the normalized name — trimmed and uppercased | random, or supplied by you |
| Name rule | must match `/^[A-Z0-9-]{4,50}$/` | free text |
| `generate_coupon_codes` | **rejected** | the point |
| `max_redemptions_per_code` | rejected — use `max_redemptions` | applies |

A promo name with spaces or lowercase is rejected outright:

```
name: "Summer Sale"  ->  validation_error
"For kind=\"promo\", name must be 4-50 characters: letters, numbers or hyphens."
```

So `SUMMER-SALE` is the promo. `"Summer Sale"` is a generated coupon whose
display name happens to have a space, and whose codes are separate strings.
Picking the wrong kind is not fixable later — confirm which one the user means
before creating.

## Creating a coupon

`name` is the only field the schema marks required. A discount is mandatory in
practice — exactly one of `percentage` or `amount`. Scope is not, but state it
anyway: omitted, it defaults to everything (see below).

```
tool: create_coupon
input:
  name: SUMMER-SALE
  kind: promo
  percentage: 15
  duration: once
  minimum_amount: 5000
  product_scope: all
  plan_scope: all
  expires_at: "2026-09-30T23:59:59Z"
  idempotency_key: <UUID v4>
```

Amounts are **cents**. `minimum_amount: 5000` is a $50 minimum, not $5000.

### What the coupon applies to

`product_scope` and `plan_scope` each take `none`, `all` or `specific`, and the
schema puts the same paired requirement on both:

> At least one of product_scope/plan_scope must be non-"none".

A coupon scoped to neither products nor plans would discount nothing, so the
constraint exists to stop a dead coupon being created.

| Value | Applies to | Also needs |
|---|---|---|
| `none` | nothing in this class | — |
| `all` | every product / every plan — **the default when omitted** | — |
| `specific` | a named subset | `product_ids` / `plan_ids`, non-empty |

`specific` with an empty or missing id list is rejected. Both id fields accept
UUIDs or prefixed IDs.

**Omitting both is accepted, and means everything.** Measured against sandbox: a
`create_coupon` with neither field is created with `product_scope: "all"` and
`plan_scope: "all"` — every product and every subscription plan, the widest
scope there is. The schema does not say so: `kind`, `currency` and `duration`
state their defaults in their descriptions, and these two do not. A coupon meant
for one product, created without a scope, discounts the whole catalog and every
plan. Pass both, every time.

### The rules the server enforces

All observed, with the exact message it returns:

| Attempt | Result |
|---|---|
| Neither `percentage` nor `amount` | `validation_error` — "Exactly one of percentage or amount must be provided." |
| Both `percentage` and `amount` | `validation_error` — same message |
| `percentage: 101` | `value_too_large` — "expected number to be <=100" |
| `max_discount_amount` on an amount-off coupon | `validation_error` — "Max_discount_amount is only applicable to percentage-off coupons." |
| `duration: "repeating"` without `duration_in_cycles` | `validation_error` — "Duration_in_cycles is required when duration is 'repeating'." |
| `product_scope: "none"` and `plan_scope: "none"` | `validation_error` — "At least one of product_scope or plan_scope must be non-"none"." |
| Neither `product_scope` nor `plan_scope` | **accepted** — both stored as `"all"` |

`duration` is about **subscriptions**, not calendar time: `once` discounts the
first charge, `repeating` the first N cycles, `forever` every cycle. A user
saying "runs until the end of the month" means `expires_at`, not `duration`.
Getting that backwards produces a coupon that discounts one charge instead of
every charge for a month, or the reverse.

`max_discount_amount` caps a percentage discount per redemption — 20% off but
never more than $50. Worth suggesting on any large percentage.

## Minting codes

`kind: "generated"` only. Two paths, and **never both in one call**:

```
count: 250                 server-generated random codes
codes: ["SAVE-ALPHA", …]   your own literal strings
```

| Constraint | Measured |
|---|---|
| `count` range | **1 to 500** per call |
| `codes` array | 1 to 500 entries |
| Code format | `/^[A-Z0-9-]{8,50}$/i` — letters, numbers, hyphens |
| Case | input is trimmed and **uppercased** on save |
| `prefix` / `length` | `count` path only, rejected with `codes` |
| `length` | 8–32, must leave at least 4 random characters after the prefix |

Observed rejections:

```
count: 501       -> value_too_large    "expected number to be <=500"
count: 0         -> value_too_small    "expected number to be >=1"
count AND codes  -> validation_error   "Provide only one of count or codes, not both."
codes: ["SHORT"] -> validation_error   "Codes must be 8-50 characters: letters, numbers, or hyphens"
```

Read a batch back with `list_coupon_codes`: it pages through the codes minted
under one coupon and filters by `redeemed`, which is how to see what a campaign
has actually used.

### Guardrail on volume

500 per call is a cap, not a target. Minting is a T2 write and each call is one
request against the 60/minute bucket, so 10,000 codes is 20 calls and a
noticeable share of the hourly budget.

Before minting more than a few hundred, confirm the number **and** say it back
in the plan. "Generate codes for the campaign" is not an amount. There is no
bulk delete for minted codes — `archive_coupon` retires the whole coupon, and
there is no tool that removes individual codes — so an over-mint is not
something you can quietly clean up afterwards.

Each batch takes its own `expires_at`, independent of the coupon's. A batch can
expire before the coupon does, which is how you run a limited drop under a
longer-running promotion.

## Validating a code

`validate_coupon` is **T0 and creates nothing**. Redemption happens server-side
when an order or subscription references the code. Validating twice costs
nothing and changes nothing, so check before promising a customer anything.

```
tool: validate_coupon
input:
  code: SUMMER-SALE
  customer_id: <uuid>      # tests per-customer caps and first-time-only
  amount: 7500             # tests minimum_amount, in cents
  plan_id: <uuid>          # tests plan scope
```

Lookup is case-insensitive — the code is trimmed and uppercased before lookup,
so `summer-sale` finds `SUMMER-SALE`.

Success returns the terms alongside the flag, so you can quote the discount
without a second call:

```json
{ "valid": true, "coupon_id": "…", "coupon_name": "…", "kind": "…" }
```

Failure gives a machine-readable reason. Observed:

| `reason` | Means |
|---|---|
| `code_not_found` | no such code, or a typo |
| `coupon_expired` | past `expires_at` |
| `coupon_not_yet_active` | before `starts_at` |
| `coupon_inactive` | `active: false` — see below, this one is usually self-inflicted |

Report the reason rather than "the code didn't work". Expired and not-yet-active
look identical to a customer and need opposite responses.

Pass the context you actually have. Validating bare `code` only proves the code
exists and is live; it does not prove *this* customer can use it on *this*
order. If the user is about to promise a discount, validate with `customer_id`
and `amount`.

## Archive is not delete, and unarchive is not undo

There is no delete. `archive_coupon` is the retirement path, and it is a soft
archive:

- existing redemptions are preserved
- the coupon stops accepting new ones
- it drops out of the default `list_coupons` result
- archiving twice succeeds — naturally idempotent, so a retry is safe

**The trap.** Archiving sets `active: false`. Unarchiving clears the archive flag
but **leaves `active: false`**. Measured end to end:

| Step | `active` | `validate_coupon` |
|---|---|---|
| created | `true` | `valid: true` |
| after `archive_coupon` | `false` | — |
| after `unarchive_coupon` | **`false`** | `valid: false, reason: coupon_inactive` |
| after `update_coupon {active: true}` | `true` | `valid: true` |

So bringing a coupon back is **two calls**, not one. An agent that unarchives and
reports success has left the customer with a code that still fails, and the
failure looks like a customer problem rather than an operator one.

When asked to restore a coupon, do both, then `validate_coupon` to confirm — the
validation is free and it is the only thing that proves the code actually works
again. In between, `retrieve_coupon` shows `active` and `archived_at`, which is
how to tell which of the two calls has landed.

## Terms lock after the first redemption

Edits go through `update_coupon`. `percentage`, `amount` and `duration` become
immutable once the coupon has been redeemed once, and attempts return **422** —
so check `total_redemptions` with `retrieve_coupon` first; above zero, the
terms are already locked.

Scope and limit fields — `max_redemptions`, `max_redemptions_per_customer`,
product and plan scope, `expires_at` — stay editable.

The practical consequence: **the discount rate is a decision, not a draft.**
Before creating, confirm the percentage or amount explicitly. "Set up 20% off"
should be echoed back as a plan showing 20, because after the first customer
redeems it, changing it means a new coupon and a new code for everyone.

Ending a promotion early is still possible: set `expires_at`, or archive it.

## What this skill will not do

- **Delete a coupon or a minted code.** Neither tool exists. Archive is the
  retirement path and it is reversible in two steps.
- **Mint a large batch on a vague instruction.** Confirm the count first.
- **Change discount terms after a redemption.** The server refuses; do not
  attempt it repeatedly or work around it by creating a near-duplicate without
  saying so.
- **Report a coupon as restored** after `unarchive_coupon` alone.
- **Guess the kind.** Promo and generated are not interchangeable and the choice
  is permanent.
- **Charge anything.** Applying a coupon to an order is `epd-catalog`; what a
  promotion earned is `epd-reporting`.
