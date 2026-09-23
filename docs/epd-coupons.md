---
skill: epd-coupons
surface: workflow
guide_version: 1.0.0
api_version: "2026-02-11"
---

# epd-coupons — guide

**Skill:** [`workflows/epd-coupons/SKILL.md`](../workflows/epd-coupons/SKILL.md) ·
**Policy:** [`SAFETY.md`](../SAFETY.md) ·
**Safety layer:** [`epd-mcp-operator`](./epd-mcp-operator.md)

Nine tools covering the whole life of a discount: create it, mint codes under
it, check whether a code will work, and retire it. Only one is T3 —
`archive_coupon`, because it stops a live promotion.

## What it does

### The two kinds, chosen once and permanently

| | `kind: "promo"` | `kind: "generated"` (the default) |
|---|---|---|
| Codes | one shared code, minted at create time | many unique codes, minted separately |
| The code is | the normalized name — trimmed and uppercased | random, or supplied by you |
| Name rule | must match `/^[A-Z0-9-]{4,50}$/` | free text |
| `generate_coupon_codes` | rejected | the point |
| `max_redemptions_per_code` | rejected — use `max_redemptions` | applies |

`SUMMER-SALE` is a promo. `"Summer Sale"` is rejected as a promo name and is
only valid as a generated coupon's display name. The choice is not fixable
afterwards, so the skill requires it confirmed before creating.

### Scope defaults to everything, and the schema does not say so

`product_scope` and `plan_scope` each take `none`, `all` or `specific`, with the
constraint that at least one must be non-`none` — a coupon scoped to neither
would discount nothing.

**Omitting both is accepted and means everything.** Measured against sandbox: a
`create_coupon` with neither field is stored with `product_scope: "all"` and
`plan_scope: "all"` — every product and every plan, the widest scope there is.
Other fields (`kind`, `currency`, `duration`) state their defaults in their
descriptions; these two do not. A coupon meant for one product, created without
a scope, discounts the whole catalog. Pass both, every time.

### `duration` is about subscriptions, not the calendar

`once` discounts the first charge, `repeating` the first N cycles, `forever`
every cycle. A user saying "runs until the end of the month" means `expires_at`.
Getting it backwards produces a coupon that discounts one charge instead of
every charge for a month, or the reverse.

### Minting codes

`generated` only. Either `count` (server-generated) or `codes` (your own
literals) — **never both in one call**.

| Constraint | Measured |
|---|---|
| `count` | 1 to 500 per call |
| `codes` | 1 to 500 entries |
| Code format | `/^[A-Z0-9-]{8,50}$/i`, trimmed and uppercased on save |
| `prefix` / `length` | `count` path only; `length` 8–32 and must leave ≥4 random characters after the prefix |

Each batch takes its own `expires_at`, independent of the coupon's — which is
how you run a limited drop under a longer-running promotion.

### Validation is free

`validate_coupon` is T0 and creates nothing. Redemption happens server-side when
an order or subscription references the code, so validating twice costs nothing
and changes nothing. Failure gives a machine-readable reason:

| `reason` | Means |
|---|---|
| `code_not_found` | no such code, or a typo |
| `coupon_expired` | past `expires_at` |
| `coupon_not_yet_active` | before `starts_at` |
| `coupon_inactive` | `active: false` — usually self-inflicted, see below |

Expired and not-yet-active look identical to a customer and need opposite
responses, which is why the skill reports the reason rather than "the code
didn't work".

## When it fires

- Any mention of a coupon, promo code, discount code or voucher.
- Launching or ending a promotion; generating a batch of codes.
- *"Is this code still valid?"* · *"Why was this one rejected?"*
- Archiving or bringing back a coupon.

### What it must not answer

| Near miss | Goes to |
|---|---|
| Changing a product's **list price** rather than discounting it | [`epd-catalog`](./epd-catalog.md) |
| Applying a coupon to an actual order | [`epd-catalog`](./epd-catalog.md) |
| Why a payment failed | [`epd-transaction-triage`](./epd-transaction-triage.md) |
| What a promotion actually earned | [`epd-reporting`](./epd-reporting.md) |

## What it refuses to do, and why

| Refusal | Why |
|---|---|
| **Mint a large batch on a vague instruction.** | "Generate codes for the campaign" is not an amount. 500 per call is a cap, not a target, and there is **no bulk delete for minted codes** — no tool removes individual codes, and `archive_coupon` retires the whole coupon. An over-mint cannot be quietly cleaned up. |
| **Report a coupon as restored after `unarchive_coupon` alone.** | See below. This is the trap in this skill. |
| **Guess the kind.** | Promo and generated are not interchangeable and the choice is permanent. |
| **Change discount terms after a redemption.** | `percentage`, `amount` and `duration` become immutable once redeemed once; attempts return **422**. Nor will it work around the refusal by creating a near-duplicate without saying so. |
| **Delete a coupon or a code.** | Neither tool exists. Archive is the retirement path. |
| **Charge anything.** | Applying a coupon to an order is `epd-catalog`. |

### Archive is not delete, and unarchive is not undo

`archive_coupon` is a soft archive: existing redemptions are preserved, the
coupon stops accepting new ones, it drops out of the default `list_coupons`
result, and archiving twice succeeds — naturally idempotent, so a retry is safe.

**The trap.** Archiving sets `active: false`. Unarchiving clears the archive
flag but **leaves `active: false`**. Measured end to end:

| Step | `active` | `validate_coupon` |
|---|---|---|
| created | `true` | `valid: true` |
| after `archive_coupon` | `false` | — |
| after `unarchive_coupon` | **`false`** | `valid: false, reason: coupon_inactive` |
| after `update_coupon {active: true}` | `true` | `valid: true` |

So bringing a coupon back is **two calls, not one**. An agent that unarchives
and reports success has left the customer with a code that still fails — and the
failure looks like a customer problem rather than an operator one, which is how
it survives for a week.

## What to check afterwards

After creating a coupon:

- [ ] **Both scopes were set explicitly.** If neither appears in the call, the
      coupon covers the entire catalog and every plan.
- [ ] **The discount was echoed as a number** before creating. The rate is a
      decision, not a draft: after the first redemption it is immutable, and
      changing it means a new coupon and a new code for everyone.
- [ ] `max_redemptions_per_customer` was considered. It defaults to **1** on a
      promo coupon, and that default is not stated at creation time.
- [ ] On a large percentage, `max_discount_amount` was at least offered — 20%
      off but never more than $50.

After minting:

- [ ] **The count was confirmed out loud** and matches what was minted.
- [ ] `list_coupon_codes` shows the batch, and its `expires_at` is the one
      intended — a batch can expire before its coupon.

After restoring:

- [ ] **Both calls ran** — `unarchive_coupon` and `update_coupon {active: true}`.
- [ ] **`validate_coupon` confirms it.** It is free, and it is the only thing
      that proves the code works again. `retrieve_coupon` showing `active` and
      `archived_at` tells you which of the two calls has landed.

## A worked transcript

Illustrative. Constraints, error messages and the archive behaviour are as the
skill documents them from sandbox; names and IDs are placeholders.

---

**Marketing:** Bring back SPRING-LAUNCH, we're running it again this week.

**Agent:** Reading its current state first, because restoring an archived coupon
is two calls and I want to know which one it needs.

```
tool: retrieve_coupon
input:
  id: 9e2d5c8a-1b7d-4e3f-8f9a-4d2e7b1c4f3a
```

```json
{
  "id": "9e2d5c8a-1b7d-4e3f-8f9a-4d2e7b1c4f3a",
  "name": "SPRING-LAUNCH",
  "kind": "promo",
  "percentage": 25,
  "active": false,
  "archived_at": "2026-06-30T23:59:59Z",
  "expires_at": "2026-06-30T23:59:59Z",
  "total_redemptions": 412,
  "max_redemptions_per_customer": 1
}
```

Four things in there change what "bring it back" means.

**It is archived *and* inactive.** Unarchiving alone will not restore it —
that clears the archive flag but leaves `active: false`, and the code keeps
failing with `coupon_inactive`. It needs `update_coupon {active: true}` as
well.

**It has also expired.** `expires_at` was 30 June. Even active and unarchived,
`validate_coupon` would return `coupon_expired`. That needs a new date, and I
need you to give me one rather than picking "this week" myself.

**The terms are locked.** 412 redemptions means `percentage`, `amount` and
`duration` are immutable — attempts return 422. So this runs again at **25%** or
it runs as a different coupon with a different code. If 25% is not the number
you wanted, tell me now, because that decision is a new coupon.

**It is one-per-customer.** `max_redemptions_per_customer` is 1, which is the
default on a promo coupon and is easy to miss because it is not stated at
creation. Everyone who used it in spring will be refused. If this is meant as a
returning-customer offer, that field needs raising — and unlike the rate, it is
still editable.

What is the new end date, and should everyone get a second use?

**Marketing:** End of next Friday, 2 October. And yes, let them use it again —
cap it at 2.

**Agent:** Three calls then. Each is a separate object change, so each gets its
own confirmation.

> I'm about to unarchive coupon **SPRING-LAUNCH**
> (`9e2d5c8a-1b7d-4e3f-8f9a-4d2e7b1c4f3a`) in **LIVE** mode. This does not by
> itself make it usable — it stays inactive until the next step. Proceed?

**Marketing:** Yes.

```
tool: unarchive_coupon
input:
  id: 9e2d5c8a-1b7d-4e3f-8f9a-4d2e7b1c4f3a
  idempotency_key: 5c8a1b7d-9e3f-4f9a-8d2e-7b1c4f3a9e2d
```

Archived flag cleared. `active` is still `false`, as expected.

> Next: set **SPRING-LAUNCH** to **active**, `expires_at` to
> **2026-10-02T23:59:59Z**, and `max_redemptions_per_customer` to **2**, in
> **LIVE** mode. The 25% rate is unchanged and cannot be changed. Proceed?

**Marketing:** Yes.

```
tool: update_coupon
input:
  id: 9e2d5c8a-1b7d-4e3f-8f9a-4d2e7b1c4f3a
  active: true
  expires_at: "2026-10-02T23:59:59Z"
  max_redemptions_per_customer: 2
  idempotency_key: 1b7d9e3f-8f9a-4d2e-9b1c-4f3a9e2d5c8a
```

Now the check that actually matters — it is free and it is the only thing that
proves the code works rather than looking like it does:

```
tool: validate_coupon
input:
  code: SPRING-LAUNCH
  customer_id: 7c5a3d0b-9e42-4b2f-8e10-9f8c2e114d6a
  amount: 5000
```

```json
{ "valid": true, "coupon_id": "9e2d5c8a-1b7d-4e3f-8f9a-4d2e7b1c4f3a",
  "coupon_name": "SPRING-LAUNCH", "kind": "promo" }
```

**SPRING-LAUNCH is live again**: 25% off, until 23:59:59Z on 2 October, two uses
per customer. Validated against a customer who has already redeemed it once, so
the raised cap is confirmed working rather than assumed.

---

### What the transcript demonstrates

- **The coupon was read before anything was changed**, and the read changed the
  plan four times over.
- **The two-call restore was named up front**, and the first confirmation says
  explicitly that the coupon will still not work after it.
- **The locked rate was surfaced as a decision for the human**, not worked around
  with a near-duplicate coupon.
- **A default nobody set was caught** — `max_redemptions_per_customer: 1`.
- **The free validation was run at the end**, against a customer who had already
  redeemed, which is what makes it a test rather than a formality.

## Where it hands off

| If the task is | Load |
|---|---|
| Applying the code to an order | [`epd-catalog`](./epd-catalog.md) |
| Applying it to a subscription | [`epd-subscriptions`](./epd-subscriptions.md) |
| Changing a list price instead | [`epd-catalog`](./epd-catalog.md) |
| What the promotion earned | [`epd-reporting`](./epd-reporting.md) |
