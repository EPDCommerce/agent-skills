---
skill: epd-reporting
surface: workflow
guide_version: 1.0.0
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

Three tools.

| Tool | Purpose |
|---|---|
| `get_revenue_summary` | Aggregate totals for a date range |
| `get_customer_financial_summary` | One customer's profile, orders, transactions and lifetime value |
| `list_transactions` | The underlying rows, for reconciliation and any breakdown the summary does not give |

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
`refunded_cents` counts refunds, reported as a positive number. `net_cents` is
exactly `gross_cents - refunded_cents`. Failed, pending, voided and chargeback
transactions are counted **nowhere**.

Measured on the sandbox for July 2026: the account holds **546** transactions in
that window and `transaction_count` reports **425**. The 121 difference:

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

**Chargebacks are the sharp edge.** A chargeback is money that left the account
and it appears in neither `gross_cents` nor `refunded_cents`, so `net_cents`
overstates what the merchant actually kept. Anyone closing books on these
figures needs to be told, and chargebacks pulled separately with
`list_transactions`.

### Reconciliation, verified

The summary and the transaction list agree exactly once the list is filtered the
way the summary filters. Verified against July 2026:

| `list_transactions` filter | Count | Sum (minor units) | Matches |
|---|---|---|---|
| `type=sale`, `status=succeeded` | 425 | 53,356,800 | `transaction_count`, `gross_cents` |
| `type=refund` | 17 | −2,169,273 | `refund_count`, `refunded_cents` |
| `status=succeeded` (all types) | 442 | 51,187,527 | `net_cents` |
| no filter | 546 | 70,382,976 | **nothing** |

Two things worth carrying: refunds are stored as negative amounts and reported
by the summary as positive, so the sign flips between views; and the unfiltered
total matches nothing at all, which is exactly the number someone reaches for
first when a reconciliation looks wrong. When a total is disputed, check the
filter before suspecting the numbers.

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

> Not reproducible in this sandbox: the widest range available returns 4,556
> transactions with `truncated: false`, so the flag has been read from the
> schema and the documented limit rather than observed. The handling is required
> regardless.

## When it fires

- *"How much revenue did we take over this period?"* · *"How much did we bill in
  July?"*
- *"What has this customer paid us?"*
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
| **Present `net_cents` as money kept** without saying chargebacks are excluded. | It is the figure most likely to end up in a board pack. |
| **Convert currencies.** | Amounts come back in the transaction's own currency in minor units. Mixing currencies in one total is not something these tools do and not something to do by hand. |
| **Print payment-method data on a revenue question.** | The only T0 obligation is not to copy more customer data into the reply than the question needed. `get_customer_financial_summary` returns a `payment_methods` array with brand and last four; a lifetime-value question does not need it. |

## What to check afterwards

- [ ] **`truncated` was read.** Every time, not just on big ranges.
- [ ] **The period boundaries were stated exactly**, and the range is
      first-to-first rather than first-to-31st.
- [ ] **Amounts were divided by 100 exactly once.** `53356800` is $533,568.00 —
      the reporting error that gets noticed fastest.
- [ ] **Chargebacks were mentioned** if anyone is closing books on the figure.
- [ ] **The key mode was stated.** A number from a sandbox account is not the
      month's revenue and looks identical to one that is.
- [ ] If the figure is being signed off, **it was reconciled** against
      `list_transactions` with `type=sale, status=succeeded`.
- [ ] `lifetime_value_cents` was not placed beside a period total.  It carries no
      period and is not comparable.

## A worked transcript

Illustrative. The July figures, the 425-of-546 breakdown and the reconciliation
table are the sandbox measurements the skill records; the rest is placeholder.

---

**Finance:** What did we take in July? I need it for the board pack.

**Agent:** One note before the number: this session is connected in **test**
mode, so what follows is sandbox data. If the board pack needs live figures,
stop me here — a sandbox total looks exactly like a real one on a slide.

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

**Net is not money kept.** Chargebacks appear in neither total, so `net_cents`
overstates what the account actually retained. Let me pull them:

```
tool: list_transactions
input:
  status: chargeback
  created_after: "2026-07-01T00:00:00Z"
  created_before: "2026-08-01T00:00:00Z"
  limit: 100
```

**17 chargebacks in July.** They are money that arrived and was clawed back, and
they are in no line above. Whether they belong in the board figure is an
accounting decision and yours to make — but net-minus-chargebacks is a different
number from net, and the summary will never show you the difference.

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

**Agent:** Then reconcile it before they do, in this order — filter first,
numbers second:

| Filter on `list_transactions` | Count | Sum |
|---|---|---|
| `type=sale`, `status=succeeded` | 425 | 53,356,800 → matches gross |
| `type=refund` | 17 | −2,169,273 → matches refunds, sign flipped |
| `status=succeeded`, all types | 442 | 51,187,527 → matches net |
| **no filter** | 546 | 70,382,976 → **matches nothing** |

That last row is the one an export usually produces, and it is the one that
starts the argument. Both numbers are correct; they answer different questions.

Refunds are stored negative and reported positive, which is the other sign
people trip over when they sum an export by hand.

One pacing note: that reconciliation was five pages at 100 rows each, so five
calls against the 60-per-minute data bucket. A full year would be closer to
sixty and worth pacing against the 1000-per-hour limit.

---

### What the transcript demonstrates

- **The mode was stated before the number**, because a sandbox figure on a board
  slide is the failure this prevents.
- **`truncated` was read and reported**, not skipped because the range looked
  small.
- **Chargebacks were raised unprompted**, with the accounting decision left to
  the human.
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
