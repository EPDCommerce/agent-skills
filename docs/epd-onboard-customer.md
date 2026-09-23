---
skill: epd-onboard-customer
surface: workflow
guide_version: 1.0.0
api_version: "2026-02-11"
---

# epd-onboard-customer — guide

**Skill:** [`workflows/epd-onboard-customer/SKILL.md`](../workflows/epd-onboard-customer/SKILL.md) ·
**Policy:** [`SAFETY.md`](../SAFETY.md) ·
**Safety layer:** [`epd-mcp-operator`](./epd-mcp-operator.md)

The customer record and the cards attached to it: create, look up, update,
delete, attach, remove. It also owns the two composites that bundle a first
charge or a first subscription into the signup call — but only for a genuinely
new customer.

## What it does

**The customer lifecycle**, end to end: `create_customer`, `list_customers`,
`get_customer`, `update_customer`, `delete_customer`, plus
`list_payment_methods`, `add_payment_method` and `delete_payment_method`.

**`create_customer` requires four fields, and `phone` is the one that catches
people.** `email`, `first_name`, `last_name` and `phone` are all required, and
`phone` must be E.164 — `+14155551234`. Most signup forms treat a phone number
as optional, so it is the field a back-office or phone-line onboarding is most
likely to be missing. Under [`SAFETY.md`](../SAFETY.md) rule 5 that is a stop,
not a guess: ask for it rather than filling a plausible number to see what
happens. Both composites require the same four, plus `card_token` and their own
arguments.

**The two signup composites**, `create_customer_and_charge` and
`create_customer_and_subscribe`. Both are T3, both take one idempotency key
covering the whole chain, and both attempt to roll the customer back if the
charge or subscription half fails.

### Getting a card on file: two paths, and only one works headlessly

This is the single most consequential thing in the skill, because the obvious
route is closed to an agent.

`add_payment_method` and both composites accept **`card_token` only** — a
single-use `cct_…` value that expires 15 minutes after capture and can only be
produced by a browser running the EPD Elements SDK with a publishable key. An
agent with no browser cannot mint one. There is no fixture value and no
server-side way to produce one.

| | Browser in the loop | Headless |
|---|---|---|
| Capture | EPD Elements SDK, publishable key | `POST https://secure.epd.com`, secret key |
| Yields | `card_token` — `^cct_[0-9a-f]{48}$`, single use, 15 min | `payment_method_id` — bare UUID, durable |
| Then | `add_payment_method`, or either composite | `create_order` / `create_subscription` |

The headless chain is three steps, and step 2 is the only place in this entire
repository where a card number is handled and the only step that leaves the MCP
surface:

```
1. create_customer             (MCP)   -> customer_id
2. POST https://secure.epd.com (REST)  -> payment_method_id
3. create_order | create_subscription  (MCP, with payment_method_id)
```

**Step 2 cannot be safely retried.** `secure.epd.com` does not replay: the same
idempotency key with a byte-identical body returned `409 idempotency_key_conflict`
across three attempts (verified with a `sha256`-checked body, 25–27 August
2026), and a fresh key can vault the card a second time. On a timeout, call
`list_payment_methods` for the customer — the first attempt may well have
succeeded.

### The four lifecycle behaviours that surprise people

All measured in sandbox on 18 September 2026.

**Duplicates are refused, not merged.** `create_customer` returns
`email_already_exists` or `phone_already_exists`. So `list_customers` filtered
by email comes first, and the record you find gets updated rather than
duplicated.

**`get_customer` with `expand: subscriptions` returns nothing** — not even an
empty list — for a customer with an active subscription. Use
`list_subscriptions` with `customer_id` instead. `expand: payment_methods` does
work.

**The default card needs a replacement to remove.** `delete_payment_method`
refuses with `replacement_required`, and so does a card that active
subscriptions bill. The replacement becomes the new default, which is why the
skill requires the human to pick it.

**Deleting a customer is final either way.** A customer with order history is
soft-deleted: the record and orders are kept, `get_customer` then returns
`resource_not_found`, and only `list_customers` with `deleted: true` finds them.
A customer with no orders was removed outright — not even `deleted: true` found
them afterwards — despite the tool describing itself as a soft delete.

## When it fires

- *"Onboard a customer."* · *"Sign up a new customer with a card."*
- *"Update the customer record."* · *"Remove their card."*
- Chaining customer creation with a first charge or subscription.

### What it must not answer

| Near miss | Goes to |
|---|---|
| The developer is integrating from their own backend | [`epd-best-practices`](./epd-best-practices.md) |
| Charging a customer who **already exists** | [`epd-catalog`](./epd-catalog.md) |
| Starting a subscription for a customer who already exists | [`epd-subscriptions`](./epd-subscriptions.md) |

The composites are for a genuinely new customer. Reaching for
`create_customer_and_charge` on someone who already exists fails on the
duplicate-email check, having already looked like the efficient choice.

## What it refuses to do, and why

| Refusal | Why |
|---|---|
| **Accept a raw card number on the MCP surface.** | No MCP tool has a field for one. `secure.epd.com` is a PCI-scoped proxy and the MCP surface deliberately is not; routing a PAN through a general tool call quietly widens an audit boundary EPD built this separation to keep narrow. If a human pastes one, the answer is to refuse and route them, not to "handle it just this once". |
| **Echo a card number back**, even one the human pasted. | Once it is in the conversation, repeating it puts it in more logs. Refer to it as "the card you pasted". |
| **Treat `card_token`, `billing_id` or `payment_method_id` as a card number.** | All three are opaque references. If one is missing, say so — do not fabricate one and do not ask for raw card data as a workaround. |
| **Store or reuse a `card_token`.** | Single use, 15-minute expiry. A second attempt fails, and the correct response is to capture again, not retry. |
| **Accept a `billing_id`.** | Not a property of any MCP tool. It is a legacy gateway vault reference; an operator offering one is describing a legacy REST integration. |
| **Create before looking.** | A duplicate is refused after the attempt, not before. `list_customers` by email is one T0 call and it changes what you do next. |
| **Choose the replacement card itself.** | That card becomes the customer's new default. The refusal message says so, which makes it the human's decision. |
| **Cancel subscriptions to get a delete through.** | `customer_has_active_subscriptions` is a stop sign, not a to-do. Ending someone's subscriptions is a decision, never a side effect of a delete. |
| **Swallow `partial_rollback_failed`.** | That code means a chain step failed *and* the automatic rollback failed too. The orphaned `customer_id` is embedded in `error.message` and has to be surfaced, or it is lost. |

## What to check afterwards

- [ ] **The new object's ID was surfaced** so the human can find it in the
      dashboard. In test mode this is a T1 requirement, not a courtesy.
- [ ] **`isError` was checked on composites.** A partial failure arrives as an
      ordinary result with `isError: true` and the payload JSON inside
      `content[0].text`.
- [ ] After a composite failure: **`error.code` was read.** `no_payment_method`,
      `partial_rollback_failed`, or a bubbled-up primitive error mean three
      different things.
- [ ] After a headless card attach: **`list_payment_methods` confirms one card**,
      not two. This is the check that catches a retried `secure.epd.com` call.
- [ ] After `delete_payment_method`: the response is `{ "id": …, "deleted": true }`,
      and the **replacement is now the default**.
- [ ] After `delete_customer`: a repeat returns the same `deleted: true` payload.
      Confirm which delete happened — soft, with history kept, or outright.

## A worked transcript

Illustrative. Tool names, error codes and the measured behaviours are as the
skill documents them; names and IDs are placeholders.

---

**Ops:** New customer from the phone line — Alice Liddell, alice@example.com.
Card is 4111 1111 1111 1111, 12/30, CVV 123. Set her up on the $29.99 Pro plan.

**Agent:** Stopping on the card before anything else.

**I can't take a card number here, and I'm not going to repeat the one you
pasted.** No tool on this MCP surface has a field for a PAN — that separation is
what keeps the surface outside the merchant's PCI scope, and routing one through
a tool call would widen that boundary quietly.

There are exactly two ways a card gets on file, and which applies depends on
whether a browser is in the loop:

- **If Alice is on the phone and you are keying it in**, the card goes to
  `secure.epd.com` — a PCI-scoped proxy, separate from this API — with the
  secret key. That is the headless path and it is a REST call, not one of my
  tools.
- **If there is a web form**, EPD Elements captures it in the browser and hands
  back a `cct_…` token I can use.

I will do everything either side of that step. Starting with whether she
already exists, since a duplicate email is refused rather than merged:

```
tool: list_customers
input:
  email: alice@example.com
  limit: 10
```

No match, so this is a genuine signup.

One thing I am missing before I can create her: **`phone` is required on
`create_customer`**, in E.164 — `+14155551234`. You gave me a name, an email and
a card. I am not going to invent a number or leave it out to see what happens;
what is hers?

**Ops:** +447700900123.

**Agent:**

> I'm about to call **`create_customer`** for **Alice Liddell**
> (alice@example.com, +447700900123) in **LIVE** mode. This creates the customer
> record and nothing else — no card, no subscription. Proceed?

**Ops:** Yes.

```
tool: create_customer
input:
  email: alice@example.com
  first_name: Alice
  last_name: Liddell
  phone: "+447700900123"
  idempotency_key: 8f9a4d2e-7b1c-4f3a-9e2d-5c8a1b7d9e3f
```

Created: `7c5a3d0b-9e42-4b2f-8e10-9f8c2e114d6a`.

Now the card, which is your step, not mine. POST that card to
`https://secure.epd.com` with the secret key and `customer_id` set to the ID
above, and it returns a `payment_method_id` — a bare UUID.

One warning before you run it: **if that call times out, do not send it again.**
It does not replay on a repeated idempotency key, and a fresh key can vault the
card twice. Tell me instead and I will call `list_payment_methods` — the first
attempt often succeeded.

**Ops:** Done. payment_method_id is `4d6a4b2f-8e10-7c5a-3d0b-9e429f8c2e11`.

**Agent:** Confirming it landed once and only once:

```
tool: list_payment_methods
input:
  customer_id: 7c5a3d0b-9e42-4b2f-8e10-9f8c2e114d6a
```

One card: Visa ending **1111**, expires 12/2030, `is_default: true`. Good — one
row, so nothing was double-vaulted.

For the subscription itself I hand over to
[`epd-subscriptions`](./epd-subscriptions.md), which owns `create_subscription`.
It will want the plan ID and will quote you the amount and cadence before it
runs. What I will not do is reach for `create_customer_and_subscribe`: that
composite needs a browser-captured `card_token`, Alice already exists now, and
the card is already vaulted — all three reasons make the primitive the right
call here.

---

### What the transcript demonstrates

- **The card was refused in the first line**, with the reason and both legitimate
  routes, rather than after several steps of setup.
- **The pasted PAN was never echoed.**
- **A lookup preceded the create**, because duplicates are refused after the
  fact.
- **A missing required field stopped the work.** `phone` is required and Ops had
  not supplied one. `SAFETY.md` rule 5 calls filling it with a plausible guess
  the single most common agent failure on structured input, and the cost of
  asking is one message.
- **The confirmation named the tool**, not just the intent. T2 and T3 both
  require the tool name in the plan, because "create the customer" and "create
  the customer and charge her" read almost identically and are `create_customer`
  and `create_customer_and_charge`.
- **The un-retryable step was flagged before it ran**, not diagnosed afterwards.
- **The result was verified by reading the cards back** — the one check that
  catches a double-vault.
- **The composite was declined with three independent reasons**, none of which
  was "it felt risky".

## Where it hands off

| If the task is | Load |
|---|---|
| Selling something to this customer, one-off order | [`epd-catalog`](./epd-catalog.md) |
| Subscription lifecycle | [`epd-subscriptions`](./epd-subscriptions.md) |
| Refunds | [`epd-refunds`](./epd-refunds.md) |
| Customer financial summary, revenue reports | [`epd-reporting`](./epd-reporting.md) |
| Writing signup code against `api.epd.com/v1` | [`epd-best-practices`](./epd-best-practices.md) |
