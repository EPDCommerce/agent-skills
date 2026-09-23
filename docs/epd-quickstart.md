---
skill: epd-quickstart
surface: integration
guide_version: 1.0.0
api_version: "2026-02-11"
---

# epd-quickstart — guide

**Skill:** [`integration/epd-quickstart/SKILL.md`](../integration/epd-quickstart/SKILL.md) ·
**Next:** [`epd-best-practices`](./epd-best-practices.md)

Zero to a successful test charge in about fifteen minutes. It is the only skill
in the repository written to be followed once and then left behind.

## What it does

Seven steps, each producing a value the next one needs:

| Step | Produces |
|---|---|
| 1. Get a sandbox key from the dashboard | `epd_test_sk_…` in `.env` |
| 2. Verify it against `GET /v1/account` | `200` with `"is_sandbox": true` |
| 3. Create a test customer | `CUSTOMER_ID` |
| 4. Attach a sandbox card via `secure.epd.com` | `PAYMENT_METHOD_ID` (bare UUID) |
| 5. Create a product | `PRODUCT_ID` |
| 6. Charge the always-succeeds card | `201`, `status: "succeeded"` |
| 7. Confirm the decline path | `201`, `status: "failed"` |

Everything is curl, so it applies in any language. Three details in it are the
reason the skill exists rather than a link to the docs.

**Step 4 uses the headless path deliberately.** There is no browser in a curl
walkthrough, so there is no way to mint a `card_token`. The card goes to
`secure.epd.com` — a PCI-scoped proxy — with the secret key, and the returned
`payment_method_id` is a **bare UUID** that must never be prefixed with `pm_` on
input.

**Step 5 exists because you cannot price an order inline.** Order amounts come
from product pricing. A developer who skips product creation has nothing to
charge for. The skill lists the exact field constraints, including the ones that
reject on a second run: `sku` is 3–30 lowercase characters and unique per
account, so a repeat returns `sku_already_exists`.

**Step 7 is the step people skip, and it is the most valuable one.** A declined
order returns HTTP **201**, not a 4xx — the order was created, the payment was
not taken. The instruction is: **branch on `status`, not on HTTP status**, then
on `failure_code` (the machine value) rather than `failure_reason` (prose).
Treating a declined order as a success is the foundational mistake this step
catches while it is still cheap.

### Two sandbox facts that changed the walkthrough

Both measured 18 September 2026, and both are why the decline step looks odd:

- **`4000 0000 0000 0002` does not decline through `secure.epd.com`.** It was
  accepted and charged successfully. So the decline path uses a sandbox-only
  legacy token — `card_visa_declined` attached as a `billing_id` — rather than a
  PAN that fails.
- **Use a fresh customer for the decline test.** A customer who has just had
  several declines was seen to decline even on a succeeding test card.

Every sandbox decline token returns `processor_declined`, so step 7 proves your
decline branch runs — not which decline it was.

## When it fires

- *"First time"*, *"getting started"*, *"set up EPD"*, *"make my first charge"*.
- A request for a quickstart or hello-world flow against EPD Commerce.

### What it must not answer

| Near miss | Goes to |
|---|---|
| Past the first charge, asking general integration questions | [`epd-best-practices`](./epd-best-practices.md) |
| An MCP-connected agent onboarding a **real** customer on an account | [`epd-onboard-customer`](./epd-onboard-customer.md), via [`epd-mcp-operator`](./epd-mcp-operator.md) |
| Writing the webhook receiver | [`epd-webhooks`](./epd-webhooks.md) |

That second row is the code-versus-operate boundary at its sharpest: this skill
creates a fake customer to prove a pipe works. An operator agent creating a
customer is acting on someone's real account.

## What it refuses to do, and why

| Refusal | Why |
|---|---|
| **Present a sandbox success as production readiness.** | Sandbox has its own data, its own rate limits and deterministic test cards. What step 6 proves is that your auth, versioning and idempotency headers are wired correctly — not that a real card will clear. |
| **Let the decline step be skipped.** | The decline path returns 201. A developer who never sees that shape writes the bug into the foundation. |
| **Be copied verbatim into production code.** | The skill says this outright about its own examples, and it is the most useful line in it. See below. |
| **Reach for the dashboard's convenience paths.** | `billing_id` with a `card_` test token works, and the skill marks it deprecated and sandbox-only rather than presenting it as an equal option. |

### The one thing not to copy

The curl examples generate a fresh UUID per call with `$(uuidgen)`. In real
code, **persist the idempotency key as part of the operation's state** so a
retry can use the same one. A key that exists only in a local variable is gone
on the next process start, which makes it useless for deduplication — it looks
like idempotency and is not.

This is the single most common way an integration ships with idempotency
"handled" and still double-charges on a retry.

## What to check afterwards

By the end of the walkthrough you should have proved all of:

- [ ] **Auth works** — `GET /v1/account` returns 200 with `"is_sandbox": true`.
      A 401 distinguishes three cases: `missing_api_key` (no header),
      `invalid_api_key_format` (not an `epd_…_sk_` key at all), `invalid_api_key`
      (right shape, wrong value).
- [ ] **`.env` is in `.gitignore`.** Step 1 says so; check it rather than assume.
- [ ] **The version header is pinned** — `EPD-Version: 2026-02-11` on every call.
- [ ] **An idempotency key went on every POST**, and you know where it will live
      in real code.
- [ ] **`payment_method_id` was used bare**, with no `pm_` prefix.
- [ ] **The success path returned `status: "succeeded"`**, read from the body
      rather than inferred from the 201.
- [ ] **The decline path returned 201 with `status: "failed"` and
      `failure_code: "processor_declined"`**, and your branch handled it.
- [ ] Both orders appear in the dashboard's Orders view as test charges.

## A worked transcript

Illustrative. Endpoints, field constraints and error codes are as the skill
documents them; keys and IDs are placeholders.

---

**Developer:** I've got an EPD sandbox key. What's the fastest way to prove the
integration works?

**Agent:** Seven steps, and the last one is the one worth not skipping. Starting
with whether the key is what you think it is:

```bash
curl -s https://api.epd.com/v1/account \
  -H "Authorization: Bearer $EPD_API_KEY" \
  -H "EPD-Version: 2026-02-11"
```

```json
{ "id": "3fa85f64-5717-4562-b3fc-2c963f66afa6",
  "name": "Demo Company", "is_sandbox": true }
```

`is_sandbox: true` — good, this is a test key and nothing below will move real
money. Two things I have already done that are easy to skip: the version header
is pinned on every request, which decouples your release schedule from EPD's
account-default upgrades, and I am reading `is_sandbox` from the body rather
than trusting the key prefix.

Is `.env` in your `.gitignore`?

**Developer:** ...it is now.

**Agent:** Customer next.

```bash
curl -s https://api.epd.com/v1/customers -X POST \
  -H "Authorization: Bearer $EPD_API_KEY" \
  -H "EPD-Version: 2026-02-11" \
  -H "X-EPD-Idempotency-Key: $(uuidgen)" \
  -H "Content-Type: application/json" \
  -d '{"email":"alice@example.com","first_name":"Alice","last_name":"Liddell"}'
```

Save the `id` as `CUSTOMER_ID`.

Now the card. You have no browser in this loop, so there is no way to mint a
`cct_…` token — that needs the EPD Elements SDK. The headless path posts the
card to `secure.epd.com`, a PCI-scoped proxy separate from the main API, with
your secret key:

```bash
curl -s "https://secure.epd.com" -X POST \
  -H "Authorization: Bearer $EPD_API_KEY" \
  -H "Content-Type: application/json" \
  -d '{"customer_id":"'"$CUSTOMER_ID"'",
       "card":{"number":"4111111111111111","exp_month":"12","exp_year":"2030","cvc":"123"},
       "set_as_default":true}'
```

The returned `id` is your `PAYMENT_METHOD_ID`, and it is a **bare UUID** — never
prefix it with `pm_` on input. That one is a real 400.

Then a product, because you cannot price an order inline — order amounts come
from product pricing. `sku` is 3–30 characters, lowercase letters, digits,
hyphens and underscores only, unique per account. A second run of this step with
the same SKU returns `sku_already_exists`, which is not a bug.

**Developer:** Product created. Charging it now — got a 201.

**Agent:** Check the body before you celebrate:

```json
{ "id": "…", "status": "succeeded", "total": 2999 }
```

`status: "succeeded"`. That matters because of what comes next.

**Now the decline path.** Create a *second* customer for this — in sandbox, a
customer who has just had several declines was seen to decline even on a
succeeding card, so reusing Alice muddies the result. Then attach
`card_visa_declined` as a `billing_id` and run the same charge:

```json
{ "id": "…", "status": "failed",
  "failure_code": "processor_declined",
  "failure_reason": "processor decline" }
```

**That came back HTTP 201, not a 4xx.** The order was created; the payment was
not taken. If your code branches on the HTTP status, it just recorded a failed
payment as a successful sale — and it will keep doing that in production, where
the money is real.

Branch on `status`, then on `failure_code`. `failure_reason` is prose for
humans and its wording is not a contract.

One last thing, and it is the thing not to copy out of this walkthrough: every
call above generated a fresh UUID with `$(uuidgen)`. In your code, **persist
that key with the operation** so a retry reuses it. A key in a local variable is
gone on the next process start, which is idempotency that looks correct and
deduplicates nothing.

---

### What the transcript demonstrates

- **The key was verified from the response body**, not from its prefix.
- **The headless card path was explained rather than assumed**, including why
  the browser path is unavailable.
- **The 201 on success was not treated as the answer** — `status` was.
- **The decline step used a fresh customer**, with the measured reason.
- **The one anti-pattern in the skill's own examples was called out** at the
  point the developer was about to copy it.

## Where it hands off

| Next | Load |
|---|---|
| Reusable HTTP wrapper, subscriptions, refunds, pagination, production keys | [`epd-best-practices`](./epd-best-practices.md) |
| Event handlers and signature verification | [`epd-webhooks`](./epd-webhooks.md) |
| An agent operating the account over MCP rather than code calling REST | [`epd-mcp-operator`](./epd-mcp-operator.md) |
