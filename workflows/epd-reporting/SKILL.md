---
name: epd-reporting
description: Use when an operator-agent connected to the EPD Commerce MCP server needs revenue totals, per-customer financial history, or a month-end reconciliation rather than a change to the account. Triggers when the user asks how much revenue was taken over a period, "how much did we bill in July", "what has this customer paid us", asks for gross versus net or refund totals, asks to reconcile or close a month, or asks why a reported total does not match the transaction list. Skip when the question is about one specific failed charge and why it failed - load epd-transaction-triage. Skip when the answer requires changing anything; this skill is read-only and reaches no write tool.
compatibility: Requires an MCP-connected agent authenticated against an EPD Commerce account with a full-access key. Read-only throughout.
metadata:
  version: 1.1.0
  api_version: "2026-02-11"
---

# Reporting on an EPD Commerce account

Revenue totals for a period, financial history for one customer, and the
reconciliation that reconciles them against the underlying transactions.

**Read-only by construction.** Every tool named here is annotated
`readOnlyHint: true`, which is Tier 0 in
[SAFETY.md](https://github.com/EPDCommerce/agent-skills/blob/main/SAFETY.md) —
no confirmation, no prompt. No write tool is reachable from this skill. If
answering a question would require changing something, that is a different
skill's job.

The one obligation Tier 0 does carry: do not copy more customer data into the
reply than the question needed. These tools return payment-method metadata, and
a revenue question is not a licence to print it.

## Routing

| If the task is | Load |
|---|---|
| Why did *this* charge fail | `epd-transaction-triage` |
| Recovering a past-due subscription | `epd-subscriptions` |
| Issuing a refund off the back of a report | `epd-refunds` |
| Anything requiring a write | its owning skill — never here |

`list_transactions`, `get_transaction` and `list_orders` are shared with
`epd-transaction-triage`, and `list_subscriptions` with `epd-subscriptions`. All
are Tier 0, so two skills reading the same data cannot conflict. Single
ownership is a rule for write tools.

## The tools

| Tool | Purpose |
|---|---|
| `get_revenue_summary` | Aggregate totals for a date range |
| `get_customer_financial_summary` | One customer's profile, orders, transactions and lifetime value |
| `list_transactions` | The underlying rows, for reconciliation and any breakdown the summary does not give |
| `list_orders` | Chargeback outcomes, and refunds of a period's sales — both live on the order |

## `get_revenue_summary`

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

All amounts are integer minor units. `53356800` is $533,568.00, not $53,356,800.
Dividing by 100 is the reporting error that gets noticed fastest.

`net_cents` is exactly `gross_cents - refunded_cents`. Do not recompute it a
different way and do not present a number the response did not give you.

### What the totals exclude

This is the part that makes reconciliations disagree, so state it before anyone
asks.

| Field | Counts |
|---|---|
| `gross_cents` / `transaction_count` | **succeeded sales only** |
| `refunded_cents` / `refund_count` | **succeeded** refunds, reported as a positive number |
| `net_cents` | all succeeded transactions, sales minus refunds |

Failed, pending, voided and chargeback transactions are counted **nowhere** — and
neither is a refund whose transaction is still `pending`. Its order already reads
`refunded`; measured on 28 September 2026, a day with four pending refunds had a
`refunded_cents` of 0. Count pending refunds separately, and do not call them
"not refunded".

Measured on the sandbox for July 2026: the account holds **546** transactions in
that window, and `transaction_count` reports **425**. The 121 difference breaks
down as:

| | Count | Why it is not in `gross_cents` |
|---|---|---|
| refunds | 17 | succeeded, but the wrong **type** |
| failed | 60 | wrong **status** |
| pending | 15 | wrong status |
| voided | 12 | wrong status |
| chargeback | 17 | wrong status |

Worth separating those two reasons. Refunds are excluded from gross for being
refunds, and they *are* reflected in `net_cents`. The other 104 are excluded for
never having succeeded, and appear in no total at all. Saying "the difference is
the failed ones" is the easy mistake and it is wrong by 17.

Both numbers are correct; they answer different questions.

**Chargebacks are already out of the totals — never subtract them again.** A
chargeback is not a row of its own. It changes the status of the original sale
from `succeeded` to `chargeback`, so a charged-back sale is in no total: not in
`gross_cents`, and therefore not in `net_cents`. Measured on August 2026: the 429
succeeded sales alone sum exactly to `gross_cents`, and the 16 charged-back sales
are separate rows. "Net minus chargebacks" deducts the same money twice.

What the totals cannot say is how each dispute ended. The transaction reads
`chargeback` whether the dispute is open, lost or won, so `list_transactions`
cannot tell them apart. The outcome lives only on the order:

| Order `status` | Dispute | What `net_cents` does with it |
|---|---|---|
| `chargeback` | open | excludes it; the outcome is not known yet |
| `chargeback_accepted` | lost | excludes it — correctly, the money is gone |
| `chargeback_dismissed` | **won** | excludes it — so `net_cents` **understates** what was kept by this amount |

`list_orders` accepts all three as `status` values, although its schema lists
only `chargeback`:

```
tool: list_orders
input:
  status: chargeback,chargeback_accepted,chargeback_dismissed
  created_after: "2026-08-01T00:00:00Z"
  created_before: "2026-09-01T00:00:00Z"
  limit: 100
```

August 2026 held 8 open ($6,028.90), 7 lost ($4,622.87) and 1 won ($89.97).
Report them by outcome; the won ones are money the merchant kept that no total
shows.

And because a chargeback rewrites the sale's own status, one that lands after a
month has closed takes that sale out of the month when it is re-run — and
records the loss in no other month. See "Month-end close".

### Date range rules

`from` is **inclusive**, `to` is **exclusive**. A calendar month is the first of
the month to the first of the next, never to the 31st — ending on the 31st drops
that day.

**The month is in a timezone, and the choice moves the number.** Measured on
August 2026: 1 August to 1 September in UTC was $489,658.41 across 429 sales;
the same dates at `-07:00` were $486,908.44 across 428. Use the merchant's
reporting timezone, write the offset into both ends, and use the offset in force
at each boundary — a daylight-saving change can put the two ends an hour apart.
State the timezone next to the figure.

Both must be ISO 8601 **with a timezone**. Bare dates are rejected:

```
"2026-07-01"  ->  invalid_format, "Invalid ISO datetime."
```

An inverted range is rejected rather than silently returning zero:

```
from later than to  ->  invalid_date_range, "\"from\" must be earlier than \"to\"."
```

A range with no activity is not an error. It returns zeros with
`truncated: false`, which is a real answer and should be reported as one.

### Truncation

The tool paginates up to **10,000 transactions per side** (sales and refunds).
Beyond that it sets `"truncated": true` and **the totals are incomplete**.

Always read the flag. If it is set, narrow the range — week by week, or day by
day — and sum the parts. Reporting a truncated total as the period's revenue is
a wrong number delivered with confidence, which is worse than refusing.

> Not reproducible in this sandbox: the widest range available returns 4,556
> transactions with `truncated: false`, so the flag has been read from the
> schema and the documented limit, not observed. Treat the handling above as
> required regardless.

## Reconciling against `list_transactions`

The summary and the transaction list agree exactly, once you filter the list the
way the summary does. The call that reproduces `gross_cents`:

```
tool: list_transactions
input:
  type: sale
  status: succeeded
  created_after: "2026-07-01T00:00:00Z"
  created_before: "2026-08-01T00:00:00Z"
  limit: 100
```

Verified against July 2026:

| `list_transactions` filter | Count | Sum (cents) | Matches |
|---|---|---|---|
| `type=sale`, `status=succeeded` | 425 | 53,356,800 | `transaction_count`, `gross_cents` |
| `type=refund`, `status=succeeded` | 17 | −2,169,273 | `refund_count`, `refunded_cents` |
| `status=succeeded` (all types) | 442 | 51,187,527 | `net_cents` |
| no filter | 546 | 70,382,976 | nothing — includes failures |

Two things to notice. **Refunds are stored as negative amounts** and reported by
the summary as positive, so the sign flips between the two views. And the
unfiltered total matches nothing at all, which is exactly the number someone
reaches for first when a reconciliation looks wrong. Every July refund had
succeeded, so `type=refund` alone matched then; with a refund pending, only the
`status=succeeded` filter does.

Check the `currency` on every row while paging. The summary carries no currency
field, so a second currency would be added in silently; this is the only place
it would show. Compare case-insensitively — transactions say `USD` where the
catalog says `usd`.

**Refunds "in August" are two questions.** `refunded_cents` is refunds *issued*
in the window. Refunds *of* the window's sales can be issued weeks later, and
`list_orders` with `status: refunded,partially_refunded` and
`expand: transactions` gives them, with their dates, in one page. On August 2026
the 16 refunds issued in August split 11 on August sales and 5 on July's; the 25
August sales later refunded split 11 refunded in August and 14 in September.
Report the one that was asked for, labelled.

When a total is disputed, reconcile in that order: check the filter before
suspecting the numbers.

`list_transactions` pages at 100. Follow `cursors.next` with `starting_after`
until `has_more` is false, and remember every page costs one call against the
60/minute bucket — a full month is five or six calls, a full year closer to
sixty. See `epd-mcp-operator` for the rate-limit rules.

## `get_customer_financial_summary`

One call replacing four. Returns the customer profile, recent orders, recent
transactions and lifetime value together.

```
tool: get_customer_financial_summary
input:
  customer_id: <uuid>
```

Top-level keys: `customer`, `recent_orders`, `recent_transactions`,
`lifetime_value_cents` — and nothing else. The tool's description promises
subscriptions; the response has no such key, measured on 28 September 2026, and
`get_customer` with `expand: subscriptions` omits them too. For a customer's
subscriptions, `list_subscriptions` with `customer_id` is the call — it is owned
by `epd-subscriptions`, and it is a read.

`lifetime_value_cents` is built from **order status**, not from what was paid:
the totals of orders reading `succeeded`, `refunded`, `chargeback` or
`chargeback_dismissed`, less every refund, pending ones included. That rule
matched all 101 customers tested on 29 September 2026; "succeeded sales minus
refunds" matched 76. So it counts an **open** dispute as value, and a cycle
order that reads `succeeded` although every sale on it failed — the two in
dunning on the sandbox are counted. A lost dispute (`chargeback_accepted`) and
failed, pending and voided orders are left out. It is not what the customer
has paid; for that, read the succeeded sales on their orders.

It also disagrees with `get_revenue_summary` on purpose, in two ways: it nets
pending refunds, which the revenue summary leaves out, and it counts open and
won disputes, whose sales the revenue summary has already dropped from gross.
Neither figure is wrong; they answer different questions.

| Argument | Default | Effect |
|---|---|---|
| `include_transactions` | `true` | `false` returns `recent_transactions` as an **empty array** — the key stays present |
| `transaction_limit` | `20` | caps `recent_transactions` only |

`recent_orders` is fixed at 20 and is **not** affected by either argument. There
is no order limit. So `include_transactions: false` narrows the response but
does not make it small.

The `customer` object carries a `payment_methods` array with card brand, last
four and expiry. Each of `recent_orders` carries a `payment_method` with
**`bin`, the card's first six digits** — on every order created through the API,
measured on 29 September 2026. The `bin` is the most sensitive thing this skill
returns: never repeat it. Include card details only when the question was about
payment methods, and then brand and last four; a lifetime-value question needs
none of it.

`lifetime_value_cents` is a single figure with no period attached. It is not
comparable to a `get_revenue_summary` result for a date range, and putting the
two side by side invites exactly that mistake.

## Month-end close

1. `get_revenue_summary` for the month, `from` the 1st **to** the 1st of the
   next month, in the merchant's timezone.
2. Check `truncated`. If true, split the range and sum; do not report the
   partial figure.
3. Reconcile against `list_transactions` with `type=sale, status=succeeded`, and
   refunds with `status=succeeded`, if the figure is being signed off by anyone.
4. Size what no total holds: failed, voided, pending sales, pending refunds, and
   chargebacks by outcome from the orders — reported, never subtracted.
5. Report `gross_cents`, `refunded_cents` and `net_cents` in currency, with the
   exact period boundaries and timezone.

State the key mode when reporting. A number from a sandbox account is not the
month's revenue, and it looks identical to one that is.

**A close is a snapshot.** Record when the figures were pulled. Re-run later,
the same month can move: a pending sale that succeeds raises its gross, and a
chargeback lowers it, because both change a row dated in that month. A refund
does not — it is a new row, dated when it was issued. When a closed month's
figure changes, those three are the explanations to check first.

## What this skill will not do

- **Write anything.** No refund, no retry, no cancellation. If the report leads
  somewhere, hand off through the routing table.
- **Recompute totals a different way** and present the result as EPD's figure.
  Report what the API returned, or report the reconciliation as a reconciliation.
- **Report a truncated total** as if it were complete.
- **Subtract chargebacks from `net_cents`.** They are already out of it. Report
  them by outcome instead, and say that won disputes are money no total shows.
- **Present a closed month's figure as final.** Pending sales and later
  chargebacks can still move it.
- **Convert currencies.** Amounts come back in the transaction's own currency in
  minor units; mixing currencies in one total is not something these tools do
  and not something to do by hand.
