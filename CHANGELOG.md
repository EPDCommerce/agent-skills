# Changelog

All notable changes to this project will be documented in this file.

The format is based on [Keep a Changelog](https://keepachangelog.com/en/1.1.0/),
and this project adheres to [Semantic Versioning](https://semver.org/spec/v2.0.0.html).

## [Unreleased]

### Added

- `epd-transaction-triage` — workflow skill. Read-only diagnosis of a failed
  charge, sorting the nine observed decline codes into safe-to-retry,
  never-retry, and needs-a-human. Hands the retry off rather than performing it.
- `epd-webhook-ops` — workflow skill. Endpoint registration, secret rotation
  with its 24-hour overlap window, delivery-log inspection, event replay, and
  schema version migration with preview and compare before the bump.
- `epd-catalog` — workflow skill. Products, plans and one-off orders, including
  the shipping-address rule that applies when any single line item requires
  shipping. Owns `retry_order`, which re-attempts a failed charge on the card
  already on file and reconciles a subscription cycle so dunning will not
  charge again.
- `epd-coupons` — workflow skill. Promo and generated coupons, code minting
  within the 500-per-call cap, validation, and the archive lifecycle where
  unarchiving does not by itself restore redeemability.
- `epd-reporting` — workflow skill. Revenue totals, per-customer financial
  history, and month-end reconciliation against the transaction list. Read-only;
  no write tool is reachable from it.
- `epd-mcp-operator` — workflow skill. Safety layer and router for the MCP
  surface: mode detection, confirmation tiers, idempotency, rate limiting,
  error envelopes, composite-tool guidance, and routing to the domain skills.
  References cover the per-tool tier table, observed error codes, and all 11
  composite tools.
- `SAFETY.md` — agent behaviour policy. Four confirmation tiers derived from
  the server's own annotations, cross-cutting rules, unattended-run policy, and
  the stated limits of what the policy can enforce.
- `scripts/gen-tiers.mjs` (`npm run gen:tiers`) — generates the per-tool tier
  reference from the `tools/list` snapshot so it cannot drift from the server.
- `audit/` — Phase A coverage audit. Live `tools/list` snapshot, tool-by-tool
  coverage matrix, proposed 12-skill map with routing, and measured API key
  permissions. Analysis only; no skill content changes.

### Fixed

- `audit/coverage.mjs` — exclude generated inventory files from the coverage
  scan. `references/tiers.md` lists every tool by design, which the scanner was
  counting as documentation and reporting zero uncovered tools.
- `audit/coverage.mjs` — record the snapshot's capture time instead of the run
  time, so `coverage.json` regenerates byte-identically and can be drift-checked.
- `audit/` — `retry_order` counted under `epd-catalog`, which documents it,
  rather than the read-only `epd-transaction-triage`, in both the matrix and the
  skill map.

## [0.1.0] - 2026-05-12

Initial public release. Six agent skills for EPD Commerce, targeting API
version `2026-02-11`.

### Added

- **Integration skills** (filesystem-loaded by coding agents)
  - `epd-best-practices` — REST integration master router: auth, idempotency,
    error envelope, pagination, filtering, IDs, money, rate limits. Routes to
    per-domain references for payments, subscriptions, refunds, errors,
    debugging, security, testing, versioning, and the SDK-wrapper pattern.
  - `epd-webhooks` — endpoint setup and HMAC-SHA256 verification with
    Node/Python/PHP reference scripts and a debugging tree.
  - `epd-quickstart` — sandbox key to first test charge in ~15 minutes,
    decline path explicitly validated.
- **Workflow skills** (MCP-loaded for operator agents)
  - `epd-onboard-customer` — vault card → create customer → attach payment
    method → optional first charge or subscription start.
  - `epd-subscriptions` — start, change, cancel; recover `past_due` via dunning.
  - `epd-refunds` — decision tree across `refund_order`, `refund_transaction`,
    `refund_and_cancel`.
- **Schema lookup protocol** in `epd-best-practices` — on-demand fetch of
  `https://docs.api.epd.com/openapi.yaml` for long-tail endpoints, with an
  explicit negative list and a version-drift check.
- **Manifest, schemas, and validator** — `.well-known/skills/index.json`,
  JSON Schemas for the manifest and `SKILL.md` frontmatter, a validator
  (`scripts/validate.js`) wired to `npm run check`, and a `node:test` spec.
- **Community files and CI** — `CONTRIBUTING.md`, `CODE_OF_CONDUCT.md`,
  `SECURITY.md`, GitHub Actions CI workflow, issue and PR templates.
