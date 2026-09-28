# Recipes

Six end-to-end chains. A skill knows one job; a recipe is the order several
skills run in to reach a real outcome, with a **checkpoint** after every step
and a **failure branch** for every call — not just the happy path.

Like the [guides](../docs/README.md), these are written for people: the
operator running the chain, and whoever has to decide whether to trust what an
agent did along it. They are not in the manifest, and no skill loads them. An
agent can still be handed one and told to follow it; nothing in them relies on
an agent having read anything else.

**Read [`SAFETY.md`](../SAFETY.md) first** if the chain will touch a live
account. No recipe restates it. Each one says where a tier applies, and prints
the confirmation in full where one is needed.

## The six

| Recipe | Skills it chains | Highest tier | Unattended | Start here if |
|---|---|---|---|---|
| [New merchant to first live charge](./new-merchant-first-live-charge.md) | operator, catalog, onboard-customer, triage, webhook-ops, refunds | T3 | refuses | An account has never taken a payment through this surface. |
| [Failed payment recovery](./failed-payment-recovery.md) | operator, triage, catalog, onboard-customer, subscriptions, refunds | T3 | refuses | A payment failed and someone wants it put right. |
| [Launching a promotion](./launch-a-promotion.md) | operator, catalog, coupons, triage | T3 | refuses | A discount is about to go live. |
| [Webhook version migration](./webhook-version-migration.md) | operator, webhook-ops, webhooks | T2 | refuses | An endpoint needs a newer schema version, or its version has a sunset date. |
| [Month-end reconciliation](./month-end-reconciliation.md) | operator, reporting, triage, subscriptions | T0 | **runs** | A month needs closing and someone will sign the figures. |
| [Customer 360 for a support agent](./customer-360.md) | operator, onboard-customer, reporting, subscriptions, triage, coupons | T0 | **runs** | A customer is asking what happened to their money. |

**Unattended** is what [`SAFETY.md`](../SAFETY.md#unattended-runs) allows today,
with no standing authorizations granted. Two of the six are read-only and can run
with nobody present. The other four refuse, and say which confirmation they are
blocked on.

## The template

Every recipe answers the same seven questions in the same order, so reading one
teaches you where to look in the rest:

1. **Outcome** — what is true when it finishes, and what is not this recipe's job.
2. **Before you start** — the inputs a human must supply. A missing one is a
   stop, never a guess.
3. **The chain** — a diagram with the branches, and a table: step, skill, tools,
   tier, checkpoint.
4. **Steps** — each with its calls, a **Checkpoint** that must hold before the
   next step, and an **If it fails** table.
5. **Where it can stop** — what the account holds if the chain ends after each
   step, and how to resume or clean up. Half-finished is its own state, and
   usually a worse one than not started.
6. **Running it unattended** — what `SAFETY.md` allows, and what an unattended
   run reports when it refuses.
7. **What was verified** — what was measured against the sandbox, on which
   date, with what result; and what was not, and why.

## Conventions

| In a recipe | Means |
|---|---|
| `<step 3: customer.id>` | A value read from an **earlier** step's response. Never typed, never guessed — [rule 4](../SAFETY.md#4-never-invent-an-identifier-amount-email-or-endpoint). The step number is the provenance. |
| `<human: price in minor units>` | A value the human supplies in this exchange. |
| `<new UUID v4>` | A fresh idempotency key for this operation. On a timeout, the retry reuses it. |
| `> I'm about to call …` | The confirmation the agent prints for a T2 or T3 step, in full. |
| **Measured** | Observed against the EPD sandbox on the date given, not inferred from documentation. |
| Tier column | The tier in **live** mode. In test mode every write is T1: proceed, then report each object created. |

Amounts are integer minor units throughout. `2999` is $29.99.

## How these were verified

Every step that can run in a sandbox was run there on **28 September 2026**, as
a chain, in the order the recipe gives: 285 calls, creating a product, three
customers, five cards, nine orders, two subscriptions, two coupons and a webhook
endpoint, each reported as it was made. The customers, product and coupons are
named for the run (`recipe-f`); the endpoint was deleted afterwards. Each
recipe's last section lists what it measured and what it could not: live mode,
deliveries to a webhook receiver, a second webhook schema version, and a renewal
failing on the engine's schedule.

Running the chains turned up defects in the skills, as writing the guides did.
The recipes state the measured behaviour, and each skill it contradicted was
corrected in the same change — see the [CHANGELOG](../CHANGELOG.md).

## Keeping these honest

`npm run validate:docs` fails when a recipe:

- is missing one of the seven sections, or is not listed on this page;
- has frontmatter that is malformed or disagrees with the manifest's
  `api_version`, names a skill that does not exist, or does not link to each
  skill it names;
- calls a tool whose owning skill — per [`audit/COVERAGE.md`](../audit/COVERAGE.md)
  — is not in its `skills` list;
- claims a `highest_tier` other than the highest tier of the tools it calls,
  derived from the server's annotations the same way
  [`references/tiers.md`](../workflows/epd-mcp-operator/references/tiers.md) is;
- says it `runs` unattended while calling anything above T0, or says it
  `refuses` while calling nothing above T0;
- has a step with no **Checkpoint**, or a step that calls a tool with no **If it
  fails**;
- passes a literal UUID in a tool call, or a `<step N: …>` value from a step that
  comes later or does not exist.

Like every other Markdown file in the repository, each recipe's tool calls are
also checked against the `tools/list` snapshot, and each link and anchor must
resolve.

What none of that catches is a checkpoint that checks the wrong thing. Those
were read by a human against the sandbox run, and the run is the evidence.
