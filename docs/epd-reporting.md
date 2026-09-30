---
skill: epd-reporting
surface: workflow
guide_version: 1.1.0
api_version: "2026-02-11"
---

# epd-reporting — guide

**Skill:** [`workflows/epd-reporting/SKILL.md`](../workflows/epd-reporting/SKILL.md) ·
**Policy:** [`SAFETY.md`](../SAFETY.md) ·
**Safety layer:** [`epd-mcp-operator`](./epd-mcp-operator.md)

Revenue totals for a period, financial history for one customer, and the
reconciliation that ties them to the underlying transactions. Read-only by
construction: every tool it names is annotated `readOnlyHint`, and no write tool
is reachable from it.

## What it does

Three tools of its own, and `list_orders`, a read it shares with
[`epd-transaction-triage`](./epd-transaction-triage.md).

| Tool | Purpose |
|---|---|
| `get_revenue_summary` | Aggregate totals for a date range |
| `get_customer_financial_summary` | One customer's profile, orders, transactions and lifetime value — but not their subscriptions, whatever its description says |
| `list_transactions` | The underlying rows, for reconciliation and any breakdown the summary does not give |
| `list_orders` | Chargeback outcomes, and refunds of a period's sales — both live on the order |

### What the totals exclude — the reason reconciliations disagree

```json
{
  "period": { "from": "2026-07-01T00:00:00Z", "to": "2026-08-01T00:00:00Z" },
  "gross_cents": 53356800,
  "refunded_cents": 2169273,
  "net_cents": 51187527,
  "transaction_count": 425,
  "refund_count": 17,
  "truncated": false
}
```

`gross_cents` and `transaction_count` count **succeeded sales only**.
`refunded_cents` counts **succeeded** refunds, reported as a positive number.
`net_cents` is exactly `gross_cents - refunded_cents`. Failed, pending, voided
and chargeback transactions are counted **nowhere** — nor is a refund still
`pending`, although its order already reads `refunded`.

Measured on the sandbox for July 2026 — and re-measured unchanged, every figure
in this guide, on 29 September: the account holds **546** transactions in that
window and `transaction_count` reports **425**. The 121 difference:

| | Count | Why it is not in `gross_cents` |
|---|---|---|
| refunds | 17 | succeeded, but the wrong **type** |
| failed | 60 | wrong **status** |
| pending | 15 | wrong status |
| voided | 12 | wrong status |
| chargeback | 17 | wrong status |

Those are two different reasons. Refunds are excluded from gross for being
refunds, and they *are* reflected in `net_cents`. The other 104 never succeeded
and appear in no total at all. "The difference is the failed ones" is the easy
answer and it is wrong by 17.

**Chargebacks are already out of net — never subtract them.** A chargeback is
not a row of its own: it changes the original sale's status from `succeeded` to
`chargeback`, so the sale drops out of `gross_cents` and therefore out of
`net_cents`. Measured on August 2026, the 429 succeeded sales alone sum exactly to
`gross_cents`, and the 16 charged-back sales are separate rows. "Net minus
chargebacks" takes the same money off twice.

Version 1.0.0 of this guide said the opposite — that chargebacks sit in neither
total, so net overstates what was kept — and offered net-minus-chargebacks as a
figure to consider. Both were wrong; running the month-end recipe found it.

What no total tells you is how each dispute ended. The transaction reads
`chargeback` whether it is open, lost or won; only the **order** says:

| Order `status` | Dispute | In `net_cents`? |
|---|---|---|
| `chargeback` | open | no — outcome unknown |
| `chargeback_accepted` | lost | no — correctly |
| `chargeback_dismissed` | **won** | no — so net **understates** what was kept |

`list_orders` accepts all three as filters, though its schema names only the
first. And because a chargeback changes a row dated in the month of the sale,
one that lands after close takes the sale out of that closed month when it is
re-run. A close is a snapshot.

### Reconciliation, verified

The summary and the transaction list agree exactly once the list is filtered the
way the summary filters. Verified against July 2026:

| `list_transactions` filter | Count | Sum (minor units) | Matches |
|---|---|---|---|
| `type=sale`, `status=succeeded` | 425 | 53,356,800 | `transaction_count`, `gross_cents` |
| `type=refund`, `status=succeeded` | 17 | −2,169,273 | `refund_count`, `refunded_cents` |
| `status=succeeded` (all types) | 442 | 51,187,527 | `net_cents` |
| no filter | 546 | 70,382,976 | **nothing** |

Two things worth carrying: refunds are stored as negative amounts and reported
by the summary as positive, so the sign flips between views; and the unfiltered
total matches nothing at all, which is exactly the number someone reaches for
first when a reconciliation looks wrong. When a total is disputed, check the
filter before suspecting the numbers.

### The month has a timezone

Measured on August 2026: 1 August to 1 September in UTC was $489,658.41 across
429 sales; at `-07:00` it was $486,908.44 across 428. The skill uses the
merchant's reporting timezone, writes the offset into both ends, and states it
beside the figure. The whole close, with every class the totals leave out, is
the [month-end reconciliation recipe](../recipes/month-end-reconciliation.md).

### Date range rules

`from` is inclusive, `to` is exclusive. A calendar month runs first-to-first,
never to the 31st — ending on the 31st drops that day. Both must be ISO 8601
**with a timezone**; a bare `"2026-07-01"` returns `invalid_format`, "Invalid
ISO datetime". An inverted range returns `invalid_date_range` rather than
silently returning zero. A range with no activity returns zeros with
`truncated: false`, which is a real answer.

### Truncation

The tool paginates up to **10,000 transactions per side** (sales and refunds).
Beyond that it sets `truncated: true` and the totals are incomplete.

> Not reproducible in this sandbox: the widest range available — 2020 to 2027,
> on 29 September 2026 — counts 4,961 succeeded sales and 231 refunds with
> `truncated: false`, so the flag has been read from the schema and the
> documented limit rather than observed. The handling is required regardless.

## When it fires

- *"How much revenue did we take over this period?"* · *"How much did we bill in
  July?"*
- *"What has this customer paid us?"* · a customer's lifetime value.
- Gross versus net, refund totals.
- Reconciling or closing a month.
- *"Why doesn't this total match the transaction list?"*

### What it must not answer

| Near miss | Goes to |
|---|---|
| Why **this** charge failed | [`epd-transaction-triage`](./epd-transaction-triage.md) |
| Recovering a past-due subscription | [`epd-subscriptions`](./epd-subscriptions.md) |
| Issuing a refund off the back of a report | [`epd-refunds`](./epd-refunds.md) |
| Anything requiring a write | its owning skill — never here |

`list_transactions` and `get_transaction` are shared with triage. Both are T0,
so two skills reading the same data cannot conflict; single ownership is a rule
for write tools.

> One live judgment call worth flagging to reviewers: *"why is this $40 charge
> missing from July?"* reads as a triage question on the skill map, but this
> skill's trigger list includes "why a reported total does not match the
> transaction list", and a fresh agent chose reporting for it. Either the map
> row or that trigger should move. It is recorded here because it is exactly the
> kind of collision that is invisible until someone runs it.

## What it refuses to do, and why

| Refusal | Why |
|---|---|
| **Write anything.** | The constraint is structural, not stylistic: no write tool is reachable. A reporting agent that can also refund has the blast radius of a refunding agent, and on this surface there is no read-only key to fall back on. |
| **Recompute a total a different way** and present it as EPD's figure. | `net_cents` is `gross_cents - refunded_cents`. A number that was derived rather than returned should be presented as a reconciliation, not as the API's answer. |
| **Report a truncated total** as if complete. | A wrong number delivered with confidence is worse than a refusal. If the flag is set, narrow the range and sum the parts. |
| **Subtract chargebacks from `net_cents`.** | They are already out of it. A board pack carrying net-minus-chargebacks understates the month by every charged-back sale. |
| **Present a closed month's figure as final.** | A pending sale that settles raises it; a chargeback that lands later lowers it. Both change rows dated in that month. |
| **Convert currencies.** | Amounts come back in the transaction's own currency in minor units. Mixing currencies in one total is not something these tools do and not something to do by hand. |
| **Print payment-method data on a revenue question.** | The only T0 obligation is not to copy more customer data into the reply than the question needed. `get_customer_financial_summary` returns a `payment_methods` array with brand, last four and expiry, and its orders carry the card's first six digits (`bin`). A lifetime-value question needs none of it, and the `bin` is never repeated. |

## What to check afterwards

- [ ] **`truncated` was read.** Every time, not just on big ranges.
- [ ] **The period boundaries were stated exactly**, and the range is
      first-to-first rather than first-to-31st.
- [ ] **Amounts were divided by 100 exactly once.** `53356800` is $533,568.00 —
      the reporting error that gets noticed fastest.
- [ ] **Chargebacks were reported by outcome** — open, lost, won — from the
      orders, and **not subtracted** from net.
- [ ] **The timezone was stated** with the period, and used at both ends.
- [ ] **Pending refunds were counted separately.** They are in no total while
      their orders already read `refunded`.
- [ ] **The key mode was stated.** A number from a sandbox account is not the
      month's revenue and looks identical to one that is.
- [ ] If the figure is being signed off, **it was reconciled** against
      `list_transactions` with `type=sale, status=succeeded`.
- [ ] `lifetime_value_cents` was not placed beside a period total.  It carries no
      period and is not comparable.
- [ ] `lifetime_value_cents` was not described as what the customer paid. It is
      built from order status, so it counts open disputes and orders whose
      sales all failed.

## A worked transcript

Illustrative. The July figures, the 425-of-546 breakdown and the reconciliation
table are the sandbox measurements the skill records; the rest is placeholder.

---

**Finance:** What did we take in July? I need it for the board pack.

**Agent:** Before I quote a figure for a board pack, let me confirm which
account this is. A sandbox total looks exactly like a real one on a slide, and
I am not willing to assert the mode from memory.

```
tool: ping
input: {}
```

```json
{ "merchant_id": "3fa85f64-5717-4562-b3fc-2c963f66afa6",
  "name": "Demo Company", "environment": "test", "is_sandbox": true }
```

**Connected to Demo Company in test mode.** So everything below is sandbox
data. If the board pack needs live figures, stop me here.

**Finance:** Understood, it's the process I'm checking. Carry on.

```
tool: get_revenue_summary
input:
  from: "2026-07-01T00:00:00Z"
  to: "2026-08-01T00:00:00Z"
```

```json
{
  "period": { "from": "2026-07-01T00:00:00Z", "to": "2026-08-01T00:00:00Z" },
  "gross_cents": 53356800,
  "refunded_cents": 2169273,
  "net_cents": 51187527,
  "transaction_count": 425,
  "refund_count": 17,
  "truncated": false
}
```

**July 2026 (test mode):**

| | |
|---|---|
| Gross | **$533,568.00** across 425 succeeded sales |
| Refunds | **$21,692.73** across 17 refunds |
| Net | **$511,875.27** |

`truncated: false`, so those totals are complete for the period. The range is
1 July to 1 August because `to` is exclusive — ending on the 31st would have
dropped the last day.

**Two things the board pack needs said out loud.**

**Chargebacks are already out of those figures — do not take them off again.**
A chargeback changes the original sale's status, so a charged-back sale is not
in gross and therefore not in net. What the board should see is how the
disputes ended, and that lives on the orders:

```
tool: list_orders
input:
  status: chargeback,chargeback_accepted,chargeback_dismissed
  created_after: "2026-07-01T00:00:00Z"
  created_before: "2026-08-01T00:00:00Z"
  limit: 100
```

**17 disputed July sales, $36,955.36, none of it in the lines above:**

| Outcome | Orders | Amount |
|---|---|---|
| Lost — `chargeback_accepted` | 12 | $26,723.61 |
| Open — `chargeback` | 2 | $9,283.88 |
| Won — `chargeback_dismissed` | 3 | $947.87 |

The lost ones are correctly absent. The **won** ones are money the account kept
that no total shows, so net understates July by $947.87 — and by up to $9,283.88
more if the open ones go the merchant's way. How to present that is an
accounting decision and yours to make. Subtracting the $36,955.36 from net is
not one of the options: it is already out.

**Failed and pending transactions are in nothing at all.** The account holds 546
transactions in this window and the summary counts 425. The gap is 121, and it
is not all failures:

| | Count | Why it is excluded |
|---|---|---|
| refunds | 17 | right status, wrong type — and they *are* in net |
| failed | 60 | never succeeded |
| pending | 15 | never succeeded |
| voided | 12 | never succeeded |
| chargeback | 17 | never counted anywhere |

Saying "the difference is the failed ones" is the natural summary and it is
wrong by 17.

**Finance:** Someone will ask why it doesn't match our transaction export.

**Agent:** Then reconcile it before they do. The rule is filter first, numbers
second — and the filter that should reproduce gross is the narrow one:

```
tool: list_transactions
input:
  type: sale
  status: succeeded
  created_after: "2026-07-01T00:00:00Z"
  created_before: "2026-08-01T00:00:00Z"
  limit: 100
```

Paged to the end: **425 rows summing to 53,356,800** — exactly
`transaction_count` and `gross_cents`. That is the row that matters, because it
is the one a finance export is trying to reproduce.

The other three filters explain the disagreement rather than resolve it, and
**I have not run them** — each is its own set of pages. Here is what to expect,
from when this account's reconciliation was last measured:

| Filter on `list_transactions` | Expect | Against |
|---|---|---|
| `type=refund`, `status=succeeded` | 17 rows, −2,169,273 | `refund_count` / `refunded_cents`, sign flipped |
| `status=succeeded`, all types | 442 rows, 51,187,527 | `net_cents` |
| **no filter** | 546 rows, 70,382,976 | **nothing** |

Say the word and I will run them against today's data rather than quoting the
last measurement.

That last row is the one an export usually produces, and it is the one that
starts the argument. Both numbers are correct; they answer different questions.

Refunds are stored negative and reported positive, which is the other sign
people trip over when they sum an export by hand.

One pacing note: the query above was five pages at 100 rows each. Running all
four filters is about **seventeen** pages, which is still comfortable against
the 60-per-minute data bucket — but a full year at this volume is closer to
sixty pages per filter, and that is where the 1000-per-hour ceiling starts to
decide how long the job takes.

---

### What the transcript demonstrates

- **The mode was established before the number, not asserted.** `ping` ran
  first. "Stated the mode" and "checked the mode" are different claims, and a
  sandbox figure on a board slide is the failure this prevents.
- **Figures it fetched were separated from figures it was quoting.** The
  reconciliation's first row was run and shown; the other three were labelled
  as the last measurement, with an offer to re-run. Presenting a remembered
  number as this session's result is the same defect as recomputing a total and
  calling it EPD's — the guide refuses that one two sections up.
- **`truncated` was read and reported**, not skipped because the range looked
  small.
- **Chargebacks were raised unprompted, by outcome, and not subtracted.** They
  are already out of net; the useful fact is how many were won, which no total
  shows. The accounting decision stayed with the human.
- **The 121 gap was broken down rather than summarised**, because the natural
  summary is wrong by 17.
- **The reconciliation was given as a filter table**, which is the form that
  settles the disagreement.

## Where it hands off

| If the task is | Load |
|---|---|
| Why one charge failed | [`epd-transaction-triage`](./epd-transaction-triage.md) |
| Recovering a past-due subscription | [`epd-subscriptions`](./epd-subscriptions.md) |
| Issuing a refund from a report | [`epd-refunds`](./epd-refunds.md) |
| What a promotion earned | [`epd-coupons`](./epd-coupons.md) for the coupon, here for the totals |
