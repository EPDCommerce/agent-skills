---
name: epd-transaction-triage
description: Use when an operator-agent connected to the EPD Commerce MCP server needs to work out why a charge failed and whether retrying it is safe. Triggers when the user says a payment failed, was declined or did not go through, asks what a decline code means, asks whether to retry a charge, pastes a failure code such as do_not_honor or insufficient_funds, or asks why a customer's card keeps getting rejected. Skip when the decision is already made and money must move - load epd-refunds to refund, or epd-subscriptions to work a past_due dunning cycle. Skip when the question is about totals over a period rather than one failure - load epd-reporting.
compatibility: Requires an MCP-connected agent authenticated against an EPD Commerce account. Read-only; performs no retry and moves no money.
metadata:
  version: 1.0.0
  api_version: "2026-02-11"
---

# Diagnosing a failed EPD Commerce charge

Sorts a failure into one that is safe to retry, one that never is, and one that
needs a human decision — then hands the action off.

**Read-only by construction.** This skill uses `list_transactions`,
`get_transaction`, `list_orders` and `get_order`, all annotated
`readOnlyHint: true` and Tier 0 under
[SAFETY.md](https://github.com/EPDCommerce/agent-skills/blob/main/SAFETY.md). It
does not retry, refund, or cancel. Diagnosis that can also spend money is a
different risk profile, and the whole point of this skill is to be safe to run
before anyone has decided anything.

> The Phase A skill map assigns `retry_order` to this skill. That conflicts with
> read-only, so the retry is documented here as a handoff and is **not called**
> from this skill. Open question for EPD.

Never echo a card number, CVV, or anything beyond the `card_last_four` and
`card_brand` the API already returns for display.

## Routing — where the answer goes next

| Once diagnosed | Load |
|---|---|
| Retry a one-off order's charge | `epd-catalog` (owns `retry_order`) |
| Retry a subscription's failed cycle | `epd-subscriptions` |
| Money going back to the customer | `epd-refunds` |
| Totals over a period, not one failure | `epd-reporting` |

## Start with `status`, not the code

`failure_code` is **null unless `status` is `"failed"`**. Measured across the
whole account: 148 chargebacks, 145 voided and 151 pending transactions, none
carrying a code.

So branch on status first, or you will read a chargeback as an undiagnosable
decline:

| `status` | What it is | Triage |
|---|---|---|
| `failed` | the charge was refused | this skill |
| `chargeback` | a **succeeded** charge later clawed back | not a decline; a dispute |
| `voided` | cancelled before settlement | not a decline |
| `pending` | not resolved yet | wait; do not retry |
| `succeeded` | worked | — |

A chargeback is the one most often misread. The money arrived and was taken
back, so "retry it" is meaningless and the customer has already disputed.

## The eight failure codes

Every one of the account's **673** failed transactions carries one of these
eight. There are no others.

`failure_reason` is human prose — "a bank restriction". `failure_code` is the
machine value — `do_not_honor`. **Branch on `failure_code`.** Some EPD docs and
the older REST error reference show codes in the `failure_reason` position;
that is not what this API returns.

| Code | Count | Class |
|---|---|---|
| `insufficient_funds` | 184 | soft |
| `do_not_honor` | 157 | ambiguous |
| `expired_card` | 117 | hard |
| `issuer_unavailable` | 65 | soft |
| `incorrect_cvv` | 59 | ambiguous |
| `transaction_not_allowed` | 54 | hard |
| `card_limit_exceeded` | 19 | soft |
| `lost_stolen_card` | 18 | hard |

### Soft — the card is fine, the moment was wrong

`insufficient_funds`, `issuer_unavailable`, `card_limit_exceeded`

The same card may well work later. These are the dunning candidates: retry on a
schedule, not immediately. Retrying `insufficient_funds` sixty seconds later
fails for the same reason and burns a retry attempt.

`issuer_unavailable` is the only one where a prompt retry is reasonable — the
issuer was unreachable, which is often brief.

### Hard — retrying the same card cannot work

`expired_card`, `lost_stolen_card`, `transaction_not_allowed`

The card itself is the problem. No retry schedule fixes an expired card. These
need a **new payment method** from the customer, which is an
`epd-onboard-customer` job, not a retry.

`lost_stolen_card` deserves its own handling: do not retry, and do not suggest
retrying. The issuer has flagged the card. Repeated attempts against a card
reported lost or stolen is exactly the pattern fraud monitoring looks for, and
it can affect the merchant's standing rather than just failing.

### Ambiguous — needs a human

**`do_not_honor`** is the second most common code and carries the least
information. The issuer refused and declined to say why. It can be fraud
suspicion, a spending control, or a temporary block. One retry on a later
schedule is defensible; a pattern of them is not.

**`incorrect_cvv`** looks soft and behaves hard. The submitted CVV did not
match. Retrying **the same stored card sends the same data and fails
identically** — so `retry_order`, which has no payment-method switch, cannot fix
it. It needs the card re-entered, which means a new payment method.

Say which class a code falls into and why, rather than only reporting the code.
"`do_not_honor` — the issuer refused without giving a reason" is useful.
"`do_not_honor`" alone is not.

## What the order tells you that the transaction does not

Always read the order as well. `get_order` carries the retry state:

```json
{
  "status": "failed",
  "attempt_count": 1,
  "next_retry_at": "2026-09-25T10:00:00.000Z",
  "failure_code": "do_not_honor",
  "subscription_id": "…",
  "subscription_cycle": 3,
  "total": 3999
}
```

Four things the transaction alone will not tell you:

- **`next_retry_at`** — a retry may already be scheduled. Retrying manually on
  top of it risks charging twice. Check this before recommending any retry.
- **`attempt_count`** — how many times this has already failed. A third
  `do_not_honor` on the same card is not ambiguous any more.
- **`subscription_id` / `subscription_cycle`** — this is a dunning failure, not
  a one-off. That changes both the tool and the owning skill.
- **`transactions[]`** — the full attempt history in order, so you can see
  whether the code changed between attempts. A card that moved from
  `insufficient_funds` to `expired_card` tells a different story than three
  identical failures.

## Gateway rejection versus issuer decline

The distinction matters — a gateway rejection is a configuration problem on the
merchant's side, an issuer decline is the customer's bank — and **you cannot
make it on this account today.**

`processor_response` is present on every failed transaction but only
`transaction_id` is populated. Measured across all 673:

| Field | Populated |
|---|---|
| `transaction_id` | 673 / 673 |
| `authorization_code` | 0 / 673 |
| `avs_result` | 0 / 673 |
| `cvv_result` | 0 / 673 |
| `response_code` | 0 / 673 |
| `response_text` | 0 / 673 |

`risk_trigger_code` and `risk_trigger_description` are likewise null on all 673.

So in sandbox, triage bottoms out at `failure_code`. In live mode these fields
are expected to carry the gateway's own response, and `avs_result` / `cvv_result`
are what separate an address or CVV mismatch from a funds decline. **Say so
rather than inferring.** If asked to distinguish gateway from issuer on this
account, the honest answer is that the data is not there.

A configuration problem wearing a decline's clothes usually shows up as a
*pattern* rather than a code: every transaction failing, all with the same code,
starting at the same moment. One customer's `do_not_honor` is a decline; the
whole account's `do_not_honor` since Tuesday is not.

## Choosing the retry tool — for the skill you hand off to

Both retries are **T3**. Neither is called from here. The choice matters, so
state which one applies when handing off.

| | `retry_order` | `retry_failed_charge` |
|---|---|---|
| Takes | `order_id` | `transaction_id` |
| Card | order's card-on-file, **no switch** | same, or a specified `payment_method_id` |
| Dunning | **reconciles the cycle so the dunning cron will not charge again** | reconstructs the order from the transaction |

**For a subscription cycle, `retry_order` is the safer tool** — it reconciles
the cycle, so the scheduled retry will not fire on top of your manual one. That
is the difference between one charge and two.

Because `retry_order` cannot switch cards, it is only useful for **soft**
failures. For `expired_card`, `incorrect_cvv` or `lost_stolen_card`, a retry on
the same card is guaranteed to fail — the customer needs to supply a new card
first.

## What this skill will not do

- **Retry, refund, void or cancel anything.** It reads and reports. Every action
  goes through the routing table.
- **Recommend retrying a hard decline.** `expired_card`, `lost_stolen_card` and
  `transaction_not_allowed` need a new payment method, not another attempt.
- **Recommend a retry without checking `next_retry_at`.** A scheduled retry plus
  a manual one is two charges.
- **Claim a gateway-versus-issuer distinction** the data does not support on
  this account.
- **Echo card data.** `card_last_four` and `card_brand` only.
- **Treat a chargeback as a decline.** Different status, different problem,
  different team.
