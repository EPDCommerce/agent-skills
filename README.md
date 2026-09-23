# EPD Commerce Skills

**EPD Commerce** (EasyPayDirect) is a payments API. This repo ships **agent
skills** — Markdown files (`SKILL.md` plus on-demand `references/`) that an AI
agent loads when it detects relevant context, then uses to generate correct code
or run correct workflows.

Twelve skills across two surfaces: writing EPD Commerce into your own backend
over the v1 REST API, and operating a live merchant account through the EPD
Commerce MCP server.

---

## Test mode and live mode

**This is stated first because it is the distinction that costs money.**

EPD Commerce accounts have two modes, and the same skills, the same tools and
the same code paths work in both. What changes is whether the money is real.

| | Test / sandbox | Live |
|---|---|---|
| Secret key | `epd_test_sk_…` | `epd_live_sk_…` |
| Publishable key | `epd_test_pk_…` | `epd_live_pk_…` |
| Account check | `GET /v1/account` returns `"is_sandbox": true` | `false` |
| MCP check | `ping` returns `"environment": "test"` | `"environment": "live"` |
| Response headers | `x-epd-environment: test`, `x-epd-test-mode: true` | no test-mode notice |
| Cards | deterministic test cards | real cards, real money |

Three rules follow, and every workflow skill in this repo enforces them:

1. **Mode is established before the first write**, by calling `ping` — not
   inferred from a key the agent was never shown. The MCP client holds the
   credential; it does not appear in tool results.
2. **The agent states the mode in words** before writing anything. *"Connected
   to Acme Ltd in LIVE mode. Writes from here move real money."* The failure
   this prevents is not an agent in the wrong environment — it is a human who
   assumes the session is sandbox because the conversation started as an
   experiment.
3. **Test mode is the default** for anything being tried for the first time. A
   sandbox success is not evidence that the same call will succeed live:
   sandbox has its own data, its own rate limits and its own deterministic
   cards.

Start in test mode. Read [`SAFETY.md`](./SAFETY.md) before you point any of this
at a live account.

---

## Two surfaces, one repo

```
integration/    IDE-loaded. Building EPD Commerce into your own backend
                via the v1 REST API. These skills generate code.

workflows/      MCP-loaded. Operating a live EPD Commerce merchant account
                through the EPD Commerce MCP server. These skills invoke
                tools against a real account.
```

The two do not overlap, and the boundary is the single most important routing
decision in the repo — because the vocabulary is nearly identical on both sides.
*"How do I refund an order"* is a code question. *"Refund order A1B2C3D4"* is an
account action. Guessing wrong means generating a snippet for someone who wanted
money moved, or moving money for someone who wanted a snippet.

## The twelve skills

Every skill has a human-facing guide in [`docs/`](./docs/README.md): what it
does, when it fires, what it refuses to do and why, what to check afterwards,
and one worked transcript.

### Integration — writing the code

| Skill | Purpose | Guide |
|---|---|---|
| [`epd-quickstart`](./integration/epd-quickstart/SKILL.md) | First integration — sandbox key to first test charge. | [guide](./docs/epd-quickstart.md) |
| [`epd-best-practices`](./integration/epd-best-practices/SKILL.md) | Master router. Auth, idempotency, errors, pagination, filters, IDs. | [guide](./docs/epd-best-practices.md) |
| [`epd-webhooks`](./integration/epd-webhooks/SKILL.md) | Webhook receivers — HMAC verification (Node/Python/PHP), raw body, replay. | [guide](./docs/epd-webhooks.md) |

### Workflows — operating the account

| Skill | Purpose | Guide |
|---|---|---|
| [`epd-mcp-operator`](./workflows/epd-mcp-operator/SKILL.md) | **Start here.** Safety layer and router: mode, tiers, idempotency, rate limits, errors. | [guide](./docs/epd-mcp-operator.md) |
| [`epd-onboard-customer`](./workflows/epd-onboard-customer/SKILL.md) | Customer lifecycle and cards on file. | [guide](./docs/epd-onboard-customer.md) |
| [`epd-catalog`](./workflows/epd-catalog/SKILL.md) | Products, plans, one-off orders, retrying a failed charge. | [guide](./docs/epd-catalog.md) |
| [`epd-subscriptions`](./workflows/epd-subscriptions/SKILL.md) | Start, change, cancel, and recover a failed renewal. | [guide](./docs/epd-subscriptions.md) |
| [`epd-transaction-triage`](./workflows/epd-transaction-triage/SKILL.md) | Read-only diagnosis of a failed charge. Retries nothing. | [guide](./docs/epd-transaction-triage.md) |
| [`epd-refunds`](./workflows/epd-refunds/SKILL.md) | Refunds — full, partial, order or transaction, with or without cancel. | [guide](./docs/epd-refunds.md) |
| [`epd-coupons`](./workflows/epd-coupons/SKILL.md) | Discounts end to end: create, mint, validate, archive. | [guide](./docs/epd-coupons.md) |
| [`epd-webhook-ops`](./workflows/epd-webhook-ops/SKILL.md) | Endpoints on the account: registration, rotation, replay, versions. | [guide](./docs/epd-webhook-ops.md) |
| [`epd-reporting`](./workflows/epd-reporting/SKILL.md) | Revenue, per-customer history, month-end. Read-only throughout. | [guide](./docs/epd-reporting.md) |

## Install

```bash
npx skills add EPDCommerce/agent-skills
```

That's it. The [`skills`](https://github.com/vercel-labs/skills) CLI (Vercel
Labs) discovers every `SKILL.md` in this repo and routes the files into the
right directory for your agent — **Claude Code**, **Codex**, **Cursor**,
**Gemini CLI**, **Cline**, **Goose**, **Continue**, **GitHub Copilot**,
**Windsurf**, and
[45+ more](https://github.com/vercel-labs/skills#supported-agents).

### Common variations

```bash
# Just one skill
npx skills add EPDCommerce/agent-skills --skill epd-quickstart

# Several at once
npx skills add EPDCommerce/agent-skills --skill epd-quickstart --skill epd-webhooks

# All skills, all agents, no prompts (CI/CD-friendly)
npx skills add EPDCommerce/agent-skills --all -y

# Globally — available across every project
npx skills add EPDCommerce/agent-skills -g

# Restrict to a specific agent
npx skills add EPDCommerce/agent-skills -a claude-code

# List available skills without installing
npx skills add EPDCommerce/agent-skills --list
```

### Per-agent notes

**Claude Code** — skills live in `.claude/skills/` (project) or
`~/.claude/skills/` (user). The CLI puts them there; the manual equivalent is
below. Skills load automatically when their `description` triggers match.

**OpenAI Codex CLI** — auto-discovers skills under `$CODEX_HOME/skills/`
(defaults to `~/.codex/skills/`). Invoke one explicitly with `$<skill-name>` in
a prompt (e.g. `$epd-best-practices help me wire a refund`); Codex also
auto-triggers off the same `description` frontmatter Claude Code uses.

**Cursor** — does not yet support filesystem skills natively. Point **Settings →
Rules → Project Rules** at a cloned skill's `SKILL.md` and Cursor inlines it as
a project rule. References are **not** lazy-loaded there, so link only the
`SKILL.md` of the skill you actually use rather than the whole tree — otherwise
you pay for all nine of `epd-best-practices`'s references on every prompt.

<details>
<summary><strong>Manual install (no CLI)</strong></summary>

The skills are plain Markdown — no registry required. Clone once, then symlink
the directories you want.

```bash
git clone https://github.com/EPDCommerce/agent-skills.git ~/src/epd-skills
```

**Claude Code (project-level)** — use `~/.claude/skills/` for user-level:

```bash
mkdir -p .claude/skills

# All skills:
for dir in ~/src/epd-skills/integration/* ~/src/epd-skills/workflows/*; do
  ln -s "$dir" ".claude/skills/$(basename "$dir")"
done

# Just one:
ln -s ~/src/epd-skills/integration/epd-best-practices .claude/skills/
```

**Claude Code (git submodule)** — if you want the skills tracked alongside your
project:

```bash
git submodule add https://github.com/EPDCommerce/agent-skills.git vendor/epd-skills
mkdir -p .claude/skills
ln -s ../../vendor/epd-skills/integration/epd-best-practices .claude/skills/
```

**OpenAI Codex CLI:**

```bash
mkdir -p "${CODEX_HOME:-$HOME/.codex}/skills"
for dir in ~/src/epd-skills/integration/* ~/src/epd-skills/workflows/*; do
  ln -s "$dir" "${CODEX_HOME:-$HOME/.codex}/skills/$(basename "$dir")"
done
```

**Custom agent** — read [`.well-known/skills/index.json`](./.well-known/skills/index.json)
to enumerate skills and their files. The manifest schema is
[`schema.json`](./.well-known/skills/schema.json); the `SKILL.md` frontmatter
schema is
[`skill-frontmatter.schema.json`](./.well-known/skills/skill-frontmatter.schema.json).
Both are JSON Schema 2020-12. The guides in [`docs/`](./docs/README.md) are for
humans and are deliberately **not** in the manifest — an agent should not be
loading them at runtime.

</details>

### Verify the install

Ask the agent something like *"how do I make a one-time charge against EPD
Commerce?"* — it should load `epd-best-practices`, then routing-load
`references/payments.md`. For the workflow side, *"am I in test or live?"*
should load `epd-mcp-operator` and produce a `ping`.

## Keys and API setup

### Which key is which

| Prefix | Where it may go | What it can do |
|---|---|---|
| `epd_test_sk_` / `epd_live_sk_` | **Server-side only** | Everything. Never commit, never log, never ship to a browser. |
| `epd_test_pk_` / `epd_live_pk_` | Browser-safe | **Capture only** — tokenizes a card through the EPD Elements SDK and nothing else. It carries none of the API's read/write authority. |
| `epd_restricted_sk_test_` / `_live_` | Server-side | Scoped subsets over REST. **Refused outright by the MCP endpoint** — see below. |

Get a sandbox key from the dashboard: **Developers → API keys → Create secret
key**, with the environment toggle on **Test mode**. The value is shown once.

```bash
# .env  — and check this is in .gitignore
EPD_API_KEY=epd_test_sk_...
EPD_WEBHOOK_SECRET=whsec_...
```

Rotate by issuing the new key, deploying it, then revoking the old one. Never
the other way around.

### REST

```
Base URL:   https://api.epd.com
Auth:       Authorization: Bearer epd_test_sk_...
Version:    EPD-Version: 2026-02-11
Idempotency: X-EPD-Idempotency-Key: <uuid v4>   (on every write)
```

Pin the version on every request. Without it you get the merchant's
account-default version, which changes when they upgrade and not when you
deploy. Full walkthrough: [`epd-quickstart`](./docs/epd-quickstart.md).

### MCP server

The workflow skills operate the account through EPD's MCP server over
streamable HTTP:

```
Endpoint:   POST https://api.epd.com/mcp
Auth:       Authorization: Bearer epd_test_sk_...
Version:    epd-version: 2026-02-11
Accept:     application/json, text/event-stream
```

Most MCP clients take this as an HTTP-transport server entry. The config key
differs per client; the parameters do not:

```json
{
  "mcpServers": {
    "epd-commerce": {
      "type": "http",
      "url": "https://api.epd.com/mcp",
      "headers": {
        "Authorization": "Bearer ${EPD_API_KEY}",
        "epd-version": "2026-02-11"
      }
    }
  }
}
```

Confirm the connection with the `ping` tool: it takes no arguments and returns
`merchant_id`, `name`, `environment`, `is_sandbox` and the account's
`api_version`.

**Two things to know before you connect a live key.**

**Restricted keys cannot use this surface at all.** They return zero tools and
cannot even call `ping`, while honouring their scopes correctly over REST. This
was measured against two restricted sandbox keys on 27 August 2026 and is
re-checkable with `node audit/key-matrix.mjs`. So there is no read-only
credential: a reporting agent and a refunding agent hold the same full-access
key.

**That makes the confirmation policy the only control.** Not defence in depth —
the defence. Read [`SAFETY.md`](./SAFETY.md) before connecting anything to a
live account.

## Safety

[`SAFETY.md`](./SAFETY.md) defines what an agent may do against a live account
and what it must refuse: four confirmation tiers derived from the server's own
tool annotations, the cross-cutting rules (idempotency, read-before-write, card
data, rate limits), and the policy for unattended runs.

Every workflow skill inherits it through `epd-mcp-operator` rather than
restating it, so **it is the single place the policy changes.** It encodes a
risk tolerance, and that is the merchant's call — it is meant to be edited.

> Not to be confused with [`SECURITY.md`](./SECURITY.md), which covers reporting
> vulnerabilities in this repository.

## Documentation

- **[`docs/`](./docs/README.md)** — one guide per skill, twelve in total, same
  template throughout.
- **[`SAFETY.md`](./SAFETY.md)** — agent conduct against a merchant account.
- **[`audit/`](./audit/COVERAGE.md)** — the tool-by-tool coverage matrix, the
  skill map and routing, and the measured key-permission matrix.
- **Full EPD Commerce API reference:** <https://docs.api.epd.com/>

This repo encodes the **non-obvious patterns** that sit above the reference —
auth idiosyncrasies, idempotency rules, error envelopes, what the validator
silently ignores. The reference is authoritative for shape; these skills are
authoritative for how to use it without losing money.

## Versioning

Each skill ships two versions in its frontmatter `metadata` block:

- `version` — semver of the skill itself, bumped on content changes.
- `api_version` — the dated EPD Commerce API version the skill targets
  (currently `2026-02-11`).

The manifest at [`.well-known/skills/index.json`](./.well-known/skills/index.json)
carries a top-level `api_version` that all skills should agree on; `npm run
validate` warns on drift, and `npm run validate:docs` fails if a guide disagrees
with the manifest.

## Contributing

See [CONTRIBUTING.md](./CONTRIBUTING.md). The short version:

```bash
npm install
npm run check          # validate manifest + guides, run tests
```

`npm run check` runs three things:

| Command | Checks |
|---|---|
| `npm run validate` | Manifest against its schema, every listed file exists, every `SKILL.md`'s frontmatter validates and its `name` matches, no skill missing from the manifest. |
| `npm run validate:docs` | Every skill has exactly one guide, guide frontmatter agrees with the manifest, every guide carries all six template sections, and every relative Markdown link in the repo resolves. |
| `npm test` | `node:test` specs, including the webhook verifier's rejection reasons and a guard against the `epd-webhooks` examples regressing to a truthiness check. |

## Security

To report a vulnerability in the skill content or tooling, see
[SECURITY.md](./SECURITY.md). Do not open public issues for security reports.

## License

[MIT](./LICENSE) — fork, modify, redistribute. Attribution appreciated.
