---
skill: epd-transaction-triage
surface: workflow
guide_version: 1.0.0
api_version: "2026-02-11"
---

# epd-transaction-triage — guide

**Skill:** [`workflows/epd-transaction-triage/SKILL.md`](../workflows/epd-transaction-triage/SKILL.md) ·
**Policy:** [`SAFETY.md`](../SAFETY.md) ·
**Safety layer:** [`epd-mcp-operator`](./epd-mcp-operator.md)

Works out why a charge failed and whether retrying it is safe — then hands the
action to someone else. It is one of two workflow skills that are read-only *by
construction* rather than by convention — [`epd-reporting`](./epd-reporting.md)
is the other — and that is the point: it is safe to run before anyone has
decided anything.

## What it does

Sorts a failure into one of three classes and says which one it is and why.

**Class first, code second.** A decline code on its own is not useful to the
person reading it. *"`do_not_honor` — the issuer refused and declined to say
why"* is actionable. *"`do_not_honor`"* is not.

| Class | Codes | What it means | Where it goes |
|---|---|---|---|
| **Soft** | `insufficient_funds`, `issuer_unavailable`, `card_limit_exceeded` | The card is fine, the moment was wrong. | Retry on a schedule. `issuer_unavailable` is the only one where soon is reasonable. |
| **Hard** | `expired_card`, `lost_stolen_card`, `transaction_not_allowed` | The card itself is the problem. | New payment method. No retry schedule fixes an expired card. |
| **Ambiguous** | `do_not_honor`, `incorrect_cvv`, `processor_declined` | Needs a human. | At most one more attempt, later — except `incorrect_cvv`, which needs the card re-entered. |

Those nine codes are the complete observed set across the sandbox account's
**678** failed transactions, last measured 11 September 2026. The skill treats
it as an observed set rather than a closed one: an unfamiliar code is reported
as unrecognised, with the class it most resembles and the reasoning, and no
retry decision is asserted from it.

### Four things it does that a bare code lookup does not

**1. Branches on `status` before `failure_code`.** `failure_code` is null unless
`status` is `"failed"`. The sandbox holds 148 chargebacks, 145 voided and 151
pending transactions, none carrying a code. A chargeback is the one most often
misread: the money arrived and was then clawed back, so "retry it" is
meaningless and the customer has already disputed. Different status, different
problem, different team.

**2. Reads the order, not just the transaction.** The order carries five things
the transaction does not:

- **`status`, which need not match the transaction's.** An order that failed on
  one attempt and succeeded on a retry reads `succeeded` while the failed
  transaction row persists underneath it. **A failed transaction is not a failed
  order.** This follows from `transactions[]` being an attempt history — if an
  order can hold several attempts, it can hold attempts that disagree — and it
  is the one that flips a verdict: diagnosing from the transaction alone reports
  a charge as lost that was actually taken the next day. The skill's own
  order-versus-transaction section does not yet say this; it is the first thing
  to read off the order.
- `next_retry_at` — a retry may already be scheduled. A manual retry on top of
  it is two charges.
- `attempt_count` — a third `do_not_honor` on the same card is not ambiguous any
  more.
- `subscription_id` / `subscription_cycle` — this is a dunning failure, not a
  one-off, which changes both the tool and the owning skill.
- `transactions[]` — the attempt history in order. A card that moved from
  `insufficient_funds` to `expired_card` tells a different story than three
  identical failures.

**3. Names the right retry tool without calling it.** `retry_order` reconciles
the subscription cycle so the dunning cron will not charge again;
`retry_failed_charge` reconstructs the order from the transaction and can leave
the scheduled retry armed. For a subscription cycle, `retry_order` is the safer
tool, and that difference is the difference between one charge and two.

**4. Distinguishes a pattern from an incident.** A configuration problem wearing
a decline's clothes shows up as a pattern, not a code: every transaction
failing, all with the same code, starting at the same moment. One customer's
`do_not_honor` is a decline. The whole account's `do_not_honor` since Tuesday is
not.

## When it fires

- A payment failed, was declined, or "didn't go through".
- Someone asks what a decline code means, or pastes one.
- Someone asks whether to retry a charge.
- A customer's card "keeps getting rejected".

### What it must not answer

| Near miss | Goes to |
|---|---|
| The decision is made and money must move | [`epd-refunds`](./epd-refunds.md) to refund |
| The failure is on a **subscription renewal** | [`epd-subscriptions`](./epd-subscriptions.md) — that is the dunning loop |
| Totals over a period rather than one failure | [`epd-reporting`](./epd-reporting.md) |
| Retrying a one-off order's charge | [`epd-catalog`](./epd-catalog.md), which owns `retry_order` |

The renewal boundary was a real routing defect, found by behavioural testing in
Phase D and fixed there: the skill named the right neighbour but under the wrong
condition, so a repeat renewal failure stayed here instead of going to dunning.
Worth knowing because it is the failure mode of trigger writing in general —
naming the correct skill is not the same as firing on the correct condition, and
a checker that verifies a skip *names* the right target will pass both.

## What it refuses to do, and why

| Refusal | Why |
|---|---|
| **Retry, refund, void or cancel anything.** | Diagnosis that can also spend money is a different risk profile. The whole value of this skill is that it can be run before anyone has decided anything, which is only true if running it cannot change anything. |
| **Recommend retrying a hard decline.** | `expired_card`, `lost_stolen_card` and `transaction_not_allowed` fail identically every time. The customer needs to supply a new card; another attempt is a delay dressed as an action. |
| **Suggest retrying `lost_stolen_card` at all.** | The issuer has flagged the card. Repeated attempts against a card reported lost or stolen is exactly the pattern fraud monitoring looks for, and it can affect the merchant's standing rather than just failing. |
| **Recommend a retry without checking `next_retry_at`.** | A scheduled retry plus a manual one is two charges to a customer whose card already failed once. |
| **Claim a gateway-versus-issuer distinction the data does not support.** | See below. This one is worth reading in full. |
| **Echo card data.** | `card_last_four` and `card_brand` only — what the API already returns for display. |
| **Treat a chargeback as a decline.** | Money that arrived and was taken back is a dispute, not a refusal. |

### The distinction it will not fake

Gateway rejection versus issuer decline matters — a gateway rejection is a
configuration problem on the merchant's side, an issuer decline is the
customer's bank — and **on this account the data is not there to make it.**

`processor_response` is present on every failed transaction. Measured across all
678 in sandbox:

| Field | Populated |
|---|---|
| `transaction_id` | 678 / 678 |
| `authorization_code` | 0 / 678 |
| `avs_result` | 5 / 678 |
| `cvv_result` | 5 / 678 |
| `response_code` | 0 / 678 |
| `response_text` | 0 / 678 |

`risk_trigger_code` and `risk_trigger_description` are null on all 678. The five
with AVS and CVV results are the test-card declines, and both read `N`.

So triage bottoms out at `failure_code` here. In live mode these fields are
expected to carry the gateway's own response, and `avs_result` / `cvv_result`
are what separate an address or CVV mismatch from a funds decline. The skill
says that rather than inferring it. An agent that confidently reports "gateway
rejection" from an empty `response_code` has invented the most consequential
word in the sentence.

## What to check afterwards

Triage produces a recommendation, not a change, so the check is on the
reasoning:

- [ ] **The status was named before the code.** If the answer starts with a
      `failure_code` and the transaction was a chargeback, the diagnosis is
      already wrong.
- [ ] **A class was stated, with a reason** — not just the code.
- [ ] **`next_retry_at` was read and reported.** If a retry is already scheduled,
      that fact belongs in the recommendation, not in a footnote.
- [ ] **`attempt_count` was considered.** Repeat failures change an ambiguous
      code into a hard one in practice.
- [ ] **If it is a subscription cycle**, the handoff went to
      [`epd-subscriptions`](./epd-subscriptions.md), not to a one-off retry.
- [ ] **No card data beyond brand and last four** appears anywhere in the
      output.
- [ ] **Nothing was retried.** If the transcript contains a write call, the wrong
      skill was driving.

## A worked transcript

Illustrative. Codes, counts and field-population figures are the sandbox
measurements the skill records; names and IDs are placeholders.

---

**Support lead:** Alice Liddell says her payment bounced this morning and she's
sure the card is fine. Can you check and retry it?

**Agent:** I can check. I will not retry — this skill is read-only, and I want
to know what failed before anything moves.

"Alice Liddell" is not something I can query on, though. Her email or customer
ID, and I will start.

**Support lead:** alice@example.com.

**Agent:**

```
tool: list_customers
input:
  email: alice@example.com
```

One match — `7c5a3d0b-9e42-4b2f-8e10-9f8c2e114d6a`.

```
tool: list_transactions
input:
  customer_id: 7c5a3d0b-9e42-4b2f-8e10-9f8c2e114d6a
  limit: 10
```

```json
{
  "data": [
    { "id": "4d6a4b2f-8e10-7c5a-3d0b-9e429f8c2e11",
      "type": "sale", "status": "failed", "amount": 3999,
      "created_at": "2026-09-23T07:41:02Z" },
    { "id": "…", "type": "sale", "status": "succeeded", "amount": 3999,
      "created_at": "2026-08-23T07:40:55Z" },
    { "id": "…", "type": "sale", "status": "chargeback", "amount": 3999,
      "created_at": "2026-03-19T11:02:14Z" },
    { "id": "…", "type": "sale", "status": "chargeback", "amount": 3999,
      "created_at": "2026-03-04T09:55:31Z" }
  ]
}
```

The most recent is `status: "failed"`, so there will be a code on it. The two
`chargeback` rows from March I am noting and not diagnosing — those are not
declines, and I will come back to them.

```
tool: get_transaction
input:
  id: 4d6a4b2f-8e10-7c5a-3d0b-9e429f8c2e11
```

```json
{
  "type": "sale",
  "status": "failed",
  "amount": 3999,
  "failure_code": "insufficient_funds",
  "failure_reason": "insufficient funds",
  "card_brand": "visa",
  "card_last_four": "1111",
  "order_id": "9f8c2e11-4d6a-4b2f-8e10-7c5a3d0b9e42"
}
```

`insufficient_funds` is a **soft** decline: the card is fine, the moment was
wrong. Alice is right that there is nothing wrong with her card — but "the card
is fine" and "the charge will work now" are different claims, and the second one
is what a retry is betting on.

The transaction alone does not tell me whether a retry is already scheduled, so
I need the order.

```
tool: get_order
input:
  id: 9f8c2e11-4d6a-4b2f-8e10-7c5a3d0b9e42
  expand: transactions
```

```json
{
  "status": "failed",
  "total": 3999,
  "attempt_count": 2,
  "next_retry_at": "2026-09-25T10:00:00.000Z",
  "failure_code": "insufficient_funds",
  "subscription_id": "2c963f66-afa6-3fa8-5f64-57174562b3fc",
  "subscription_cycle": 7
}
```

**First, the order's own `status` is `failed` too.** That is worth checking
rather than assuming: an order that failed once and succeeded on a retry reads
`succeeded` with the failed transaction still sitting underneath it, and
reporting that as a lost payment would be wrong in the customer's favour and
wrong for you. Here it really did fail.

Then three things change the answer.

**This is a subscription renewal, not a one-off.** `subscription_id` is set and
this is cycle 7. That makes it a dunning failure, which is
[`epd-subscriptions`](./epd-subscriptions.md)'s job, not a standalone retry.

**A retry is already scheduled** for 25 September at 10:00 UTC. If I retried now
and it succeeded, the scheduled attempt would still be armed unless the cycle
gets reconciled — which is exactly the difference between `retry_order` and
`retry_failed_charge`, and the reason the first is the right tool here.

**This is the second attempt, not the first.** `attempt_count: 2` on
`insufficient_funds` is still soft, but it is drifting: two failures for funds
in one cycle is a different conversation with the customer than one.

**My recommendation: do nothing today.** The engine will try again on the 25th,
which is two days of additional headroom on the account it is drawing from, and
retrying `insufficient_funds` sixty seconds later fails for the same reason and
burns an attempt.

If you want it attempted sooner anyway, that goes through
[`epd-subscriptions`](./epd-subscriptions.md) using `retry_order`, which
reconciles the cycle so the scheduled attempt does not also fire. It is a T3
call and it will quote you the $39.99 and her card's last four before running.

On the two chargebacks from March: those are not declines. That money arrived
and was then clawed back, and a customer with prior chargebacks plus a
subscription now failing on funds is a collections question rather than a
payments one. I have not looked into them — say the word and I will.

---

### What the transcript demonstrates

- **The retry request was declined without being refused.** The agent explains
  what it would take, who owns it, and what it will cost.
- **A name was turned into an ID first.** "Alice Liddell" is not a handle, and
  the rows the diagnosis rests on are the ones that came back from a query —
  not ones summarised from memory.
- **The order's status was checked, not inferred from the transaction's.** A
  failed transaction can belong to a succeeded order; confirming it is what
  separates "her payment is lost" from "it went through yesterday".
- **The order was read**, and it changed the answer twice over — from one-off to
  subscription, and from "retry" to "a retry is already scheduled".
- **The class was named with its reason.** "Soft — the card is fine, the moment
  was wrong" is what makes the recommendation legible to the support lead.
- **Card data stopped at brand and last four.**
- **The chargebacks were flagged and not diagnosed**, because they are a
  different problem and this skill says so rather than guessing.

## Where it hands off

| Once diagnosed | Load |
|---|---|
| Retry a one-off order's charge | [`epd-catalog`](./epd-catalog.md) (owns `retry_order`) |
| Retry a subscription's failed cycle | [`epd-subscriptions`](./epd-subscriptions.md) |
| Money going back to the customer | [`epd-refunds`](./epd-refunds.md) |
| A new card is needed | [`epd-onboard-customer`](./epd-onboard-customer.md) |
| Totals over a period, not one failure | [`epd-reporting`](./epd-reporting.md) |
