---
name: epd-reporting
description: Use when an operator-agent connected to the EPD Commerce MCP server needs revenue totals, per-customer financial history, or a month-end reconciliation rather than a change to the account. Triggers when the user asks how much revenue was taken over a period, "how much did we bill in July", "what has this customer paid us", asks for gross versus net or refund totals, asks to reconcile or close a month, or asks why a reported total does not match the transaction list. Skip when the question is about one specific failed charge and why it failed - load epd-transaction-triage. Skip when the answer requires changing anything; this skill is read-only and reaches no write tool.
compatibility: Requires an MCP-connected agent authenticated against an EPD Commerce account with a full-access key. Read-only throughout.
metadata:
  version: 1.0.0
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

`list_transactions` and `get_transaction` are shared with
`epd-transaction-triage`. Both are Tier 0, so two skills reading the same data
cannot conflict. Single ownership is a rule for write tools.

## The three tools

| Tool | Purpose |
|---|---|
| `get_revenue_summary` | Aggregate totals for a date range |
| `get_customer_financial_summary` | One customer's profile, orders, transactions and lifetime value |
| `list_transactions` | The underlying rows, for reconciliation and any breakdown the summary does not give |

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
| `refunded_cents` / `refund_count` | refunds, reported as a positive number |
| `net_cents` | all succeeded transactions, sales minus refunds |

Failed, pending, voided and chargeback transactions are counted **nowhere**.

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

**Chargebacks are the sharp edge.** A chargeback is money that left the account,
and it appears in neither `gross_cents` nor `refunded_cents`, so `net_cents`
overstates what the merchant actually kept. If anyone is closing books on these
figures, say so explicitly and pull chargebacks separately:

```
tool: list_transactions
input:
  status: chargeback
  created_after: "2026-07-01T00:00:00Z"
  created_before: "2026-08-01T00:00:00Z"
  limit: 100
```

### Date range rules

`from` is **inclusive**, `to` is **exclusive**. A calendar month is the first of
the month to the first of the next, never to the 31st — ending on the 31st drops
that day.

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
way the summary does. Verified against July 2026:

| `list_transactions` filter | Count | Sum (cents) | Matches |
|---|---|---|---|
| `type=sale`, `status=succeeded` | 425 | 53,356,800 | `transaction_count`, `gross_cents` |
| `type=refund` | 17 | −2,169,273 | `refund_count`, `refunded_cents` |
| `status=succeeded` (all types) | 442 | 51,187,527 | `net_cents` |
| no filter | 546 | 70,382,976 | nothing — includes failures |

Two things to notice. **Refunds are stored as negative amounts** and reported by
the summary as positive, so the sign flips between the two views. And the
unfiltered total matches nothing at all, which is exactly the number someone
reaches for first when a reconciliation looks wrong.

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
`lifetime_value_cents`.

| Argument | Default | Effect |
|---|---|---|
| `include_transactions` | `true` | `false` returns `recent_transactions` as an **empty array** — the key stays present |
| `transaction_limit` | `20` | caps `recent_transactions` only |

`recent_orders` is fixed at 20 and is **not** affected by either argument. There
is no order limit. So `include_transactions: false` narrows the response but
does not make it small.

The `customer` object carries a `payment_methods` array with card brand and last
four. That is the most sensitive thing this skill returns. Include it only when
the question was about payment methods; a lifetime-value question does not need
it.

`lifetime_value_cents` is a single figure with no period attached. It is not
comparable to a `get_revenue_summary` result for a date range, and putting the
two side by side invites exactly that mistake.

## Month-end close

1. `get_revenue_summary` for the month, `from` the 1st **to** the 1st of the
   next month.
2. Check `truncated`. If true, split the range and sum; do not report the
   partial figure.
3. Pull chargebacks separately — they are in neither total.
4. Reconcile against `list_transactions` with `type=sale, status=succeeded` if
   the figure is being signed off by anyone.
5. Report `gross_cents`, `refunded_cents` and `net_cents` in currency, state the
   exact period boundaries, and say plainly that failed and charged-back
   transactions are excluded.

State the key mode when reporting. A number from a sandbox account is not the
month's revenue, and it looks identical to one that is.

## What this skill will not do

- **Write anything.** No refund, no retry, no cancellation. If the report leads
  somewhere, hand off through the routing table.
- **Recompute totals a different way** and present the result as EPD's figure.
  Report what the API returned, or report the reconciliation as a reconciliation.
- **Report a truncated total** as if it were complete.
- **Present `net_cents` as money kept** without saying that chargebacks are
  excluded.
- **Convert currencies.** Amounts come back in the transaction's own currency in
  minor units; mixing currencies in one total is not something these tools do
  and not something to do by hand.
