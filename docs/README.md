# Guides

One guide per skill, twelve in total. Each answers the same five questions in
the same order, so someone who has read one can skim the rest:

1. **What it does** — the job, and the boundary with the skills either side.
2. **When it fires** — the triggers, and the near-misses it must not answer.
3. **What it refuses to do, and why** — every refusal with the failure it
   prevents.
4. **What to check afterwards** — how to tell the run actually worked.
5. **A worked transcript** — one session end to end, confirmations included.

Each guide then closes with **where it hands off**.

These are the human-facing companions to the skills themselves. The `SKILL.md`
files are written for an agent to load at runtime; these are written for the
people who have to decide whether to trust what the agent did.

## Read in this order

**[`SAFETY.md`](../SAFETY.md) first, if an agent will touch a live account.**
It defines the four confirmation tiers every workflow skill inherits. Nothing
below restates it — the guides tell you how a skill applies the policy, not
what the policy says.

### Building EPD Commerce into your own backend

| Guide | Skill | Start here if |
|---|---|---|
| [epd-quickstart](./epd-quickstart.md) | [`epd-quickstart`](../integration/epd-quickstart/SKILL.md) | Nothing is built yet and you want a test charge today. |
| [epd-best-practices](./epd-best-practices.md) | [`epd-best-practices`](../integration/epd-best-practices/SKILL.md) | You are past the first charge and writing real integration code. |
| [epd-webhooks](./epd-webhooks.md) | [`epd-webhooks`](../integration/epd-webhooks/SKILL.md) | You are writing the receiver that verifies EPD's signatures. |

### Operating a live account through the MCP server

| Guide | Skill | Start here if |
|---|---|---|
| [epd-mcp-operator](./epd-mcp-operator.md) | [`epd-mcp-operator`](../workflows/epd-mcp-operator/SKILL.md) | **Read this one first.** Mode, tiers, idempotency, rate limits, routing. |
| [epd-onboard-customer](./epd-onboard-customer.md) | [`epd-onboard-customer`](../workflows/epd-onboard-customer/SKILL.md) | A customer record or a card on file needs creating, changing or removing. |
| [epd-catalog](./epd-catalog.md) | [`epd-catalog`](../workflows/epd-catalog/SKILL.md) | Products, plans, or a one-off order against them. |
| [epd-subscriptions](./epd-subscriptions.md) | [`epd-subscriptions`](../workflows/epd-subscriptions/SKILL.md) | Recurring billing: start, change, cancel, or recover a failed renewal. |
| [epd-transaction-triage](./epd-transaction-triage.md) | [`epd-transaction-triage`](../workflows/epd-transaction-triage/SKILL.md) | A charge failed and nobody has worked out why yet. |
| [epd-refunds](./epd-refunds.md) | [`epd-refunds`](../workflows/epd-refunds/SKILL.md) | Money is going back to a customer. |
| [epd-coupons](./epd-coupons.md) | [`epd-coupons`](../workflows/epd-coupons/SKILL.md) | A discount is being created, minted, validated or retired. |
| [epd-webhook-ops](./epd-webhook-ops.md) | [`epd-webhook-ops`](../workflows/epd-webhook-ops/SKILL.md) | Endpoints on the account: registration, rotation, replay, versions. |
| [epd-reporting](./epd-reporting.md) | [`epd-reporting`](../workflows/epd-reporting/SKILL.md) | Revenue for a period, a customer's history, or a month-end close. |

## What the transcripts are

Every guide carries one worked transcript. They are **illustrative, not
captures**: the tool names, argument shapes, error codes and refusal messages
are the ones the skill documents from sandbox runs against the EPD Commerce
API, while customer names, IDs and amounts are placeholders. Where a transcript
shows a number that was actually measured — the 425-of-546 July reconciliation,
the 24-hour rotation overlap, the nine observed decline codes — the surrounding
guide says so.

Where the work has a confirmation, the transcript shows it in full. Six of the
twelve skills can write, and those six print the exact words — the prompt is the
control, and the only way to review a control is to see the words it uses. The
other six are read-only or generate code, so their transcripts show the
reasoning and the refusals instead.

Every value a transcript puts in a confirmation was read back from a response
shown above it. That is [`SAFETY.md`](../SAFETY.md) rule 4, and it applies to
the guides as much as to the agents: a confirmation whose numbers came from
nowhere teaches the reader that inventing them is acceptable.

## Conventions used throughout

| Convention | Meaning |
|---|---|
| **T0 / T1 / T2 / T3** | Confirmation tiers, defined in [`SAFETY.md`](../SAFETY.md). T0 reads freely. T2 and T3 both print a plan first — **naming the tool**, the arguments, the key mode and the expected effect — and T3 adds the exact amount, currency and object ID. |
| `tool_name` | An MCP tool on the EPD Commerce server. The per-tool tier table is [`references/tiers.md`](../workflows/epd-mcp-operator/references/tiers.md). |
| `POST /v1/...` | A REST endpoint on `https://api.epd.com`. Integration skills generate code against these; workflow skills do not call them. |
| Amounts | Integer minor units throughout. `2999` is $29.99. |
| "Measured" | Observed against the EPD sandbox on the date given, not inferred from documentation. |

## Keeping these honest

A guide that drifts from its skill is worse than no guide, because it reads as
authority. Four things hold them together:

- **`npm run check` fails** if a skill has no guide or a guide names a skill
  that does not exist; if a guide's frontmatter disagrees with the manifest on
  `skill`, `surface` or `api_version`; if a guide is missing one of the six
  sections, does not link to its `SKILL.md`, or is not listed on this page; or
  if any relative Markdown link in the repository — **including its anchor** —
  points at something that is not there.
- **Code in a guide is executed, not just read.** The `epd-webhooks` example is
  covered by `scripts/__tests__/webhook-verifier.test.js`, which fails the build
  if it regresses to the truthiness bug it diagnoses, or stops passing a real
  signing secret.
- **Tier claims are never typed into a guide as facts about the server.** They
  point at the generated table, which regenerates with `npm run gen:tiers`.
- **The confirmation policy lives in [`SAFETY.md`](../SAFETY.md) alone.** If a
  guide and `SAFETY.md` disagree, `SAFETY.md` wins and the guide is a bug.

What none of that catches is a transcript that invents an identifier or quotes a
figure it never fetched. Those are read by a human, and every guide here has
been audited for them once — see the `fix(docs):` commits for what that turned
up.
