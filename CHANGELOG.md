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
- `scripts/__tests__/webhook-verifier.test.js` — runs the Node verifier against
  every rejection reason, and fails if an `epd-webhooks` example tests the
  verifier's result object for truthiness instead of reading `valid`.
- `audit/skill-map.mjs` — checks the shipped `SKILL.md` descriptions against
  the map's planned routes, and computes the status of the Phase A notes
  against the six original skills instead of hard-coding them.

### Changed

Phase D — revisions to the six original skills. Each now routes through
`epd-mcp-operator` for tiers, confirmation and idempotency instead of restating
them, and names the Phase C skills it hands off to.

- `epd-onboard-customer` 1.1.0 — narrowed to the customer and its cards, and
  now documents the five tools no skill covered: `list_customers`,
  `get_customer`, `update_customer`, `delete_customer` and
  `delete_payment_method`, plus `list_payment_methods`. Behaviour checked in
  sandbox: duplicate email or phone refused, the default card needs a
  replacement, a customer with active subscriptions cannot be deleted, and a
  delete is soft only when the customer has orders.
- `epd-subscriptions` 1.1.0 — dunning rewritten around what the server does: a
  failed renewal stays `active` with `attempt_count` and `next_retry_at`, so
  that is how to find one; the retry defaults to the scheduled attempt or
  `retry_order`, which reconciles the cycle, and warns that
  `retry_failed_charge` does not. Decline classes now come from
  `epd-transaction-triage` instead of a disagreeing inline list. Documents
  `cancellation_reason` / `cancellation_notes` and re-cancel behaviour.
- `epd-refunds` 1.1.0 — the "refund the last charge" lookup is a validated
  call; `refund_and_cancel` preconditions match the server. The opening no
  longer says every tool it uses is destructive: the three refund tools are,
  and the three lookups are read-only.
  Its description now guards the code-vs-operate boundary the operator skill
  calls the easiest routing mistake to make: "how do I refund an order" is
  `epd-best-practices`, "refund order A1B2C3D4" is this skill.
- `epd-transaction-triage` 1.0.0 — its description now routes a card that keeps
  failing on a subscription renewal to `epd-subscriptions`. `audit/SKILL-MAP.md`
  claimed triage "explicitly routes recurring failures here"; its only route to
  subscriptions was conditioned on money having to move, so a diagnosis question
  about a repeating renewal failure stayed in triage. The map's claim is now true.
- `epd-best-practices` 1.2.0 — routes to `epd-quickstart` and `epd-webhooks`
  as well as `epd-mcp-operator`; rate limiting documents the three buckets.
- `epd-quickstart` 1.1.0 — routes MCP operators away; the decline step uses a
  sandbox input that actually declines.
- `epd-webhooks` 1.1.0 — routes MCP endpoint operations to `epd-webhook-ops`,
  which inherits the safety layer from `epd-mcp-operator`.
- `epd-mcp-operator` 1.0.1 — drops the note that five tools were uncovered,
  and the cross-references that described the pre-revision skills. The
  description is trimmed from 1088 to 1020 characters, inside the Agent Skills
  limit of 1024, with every trigger kept.
- Skill frontmatter schema — `description` is capped at 1024 characters, the
  Agent Skills limit, instead of 2048, so `npm run check` fails on an
  over-length description.
- CI — the webhook verifier self-tests no longer run with
  `continue-on-error`, so a failing Node, Python or PHP verifier fails the
  build. All three pass locally (Node 24, Python 3.13, PHP 8.3).

### Fixed

- `epd-best-practices` — REST idempotency codes corrected to what the API
  returns: `idempotency_key_conflict` (409) and `request_in_progress` (409),
  not `idempotency_key_mismatch` (422) and `idempotency_key_in_use`, in the
  skill, the error and debugging references, and all three SDK wrappers. The
  wrappers now retry 429 after `Retry-After` and no longer spin on
  `request_in_progress`, which in sandbox does not clear and never replays.
- `epd-best-practices` — decline codes are read from `failure_code`, not
  `failure_reason`, and classed the same way as `epd-transaction-triage`;
  every sandbox decline token returns `processor_declined`, now documented.
- `epd-best-practices` — the REST subscription reference no longer filters on
  `status=past_due` (silently ignored; returns every subscription) and points
  to `POST /v1/orders/{id}/retry`, which it said did not exist.
- `epd-best-practices` — refund responses, over-refund errors, order response
  fields and `refund_transaction` semantics corrected against sandbox.
- `epd-quickstart` — the decline test PAN `4000 0000 0000 0002` does not
  decline in sandbox; step 7 now uses `card_visa_declined`, and expects HTTP
  201 and `failure_code: "processor_declined"`.
- `epd-webhooks` — REST examples used `events` instead of `enabled_events`,
  a `secret` field instead of `signing_secret`, `transaction.*` event types
  that do not exist, and preview, compare, replay and upgrade routes and
  bodies the API rejects. All checked against the published spec and sandbox.
- `epd-webhooks` — secret rotation overlap is 24 hours by default (1–72 on
  REST), not "brief".
- `epd-webhooks` scripts — the Node verifier's hex check was a dead
  `try/catch`; malformed hex now gets its own reason. PHP now accepts
  uppercase hex like Node and Python. All three self-tests assert and exit
  non-zero on failure.
- `epd-webhooks` scripts — the three verifiers disagreed on an empty `v1=`
  signature: Node called it `malformed_signature_header`, Python let it reach
  the comparison and reported `signature_mismatch`, PHP called it
  `malformed_signature_hex`. All three now return `malformed_signature_hex`,
  and each self-test covers the case so CI holds them to the same answer. All
  three already rejected the payload, so this changes the reason, not the
  verdict.

- `audit/coverage.mjs` — exclude generated inventory files from the coverage
  scan. `references/tiers.md` lists every tool by design, which the scanner was
  counting as documentation and reporting zero uncovered tools.
- `audit/coverage.mjs` — record the snapshot's capture time instead of the run
  time, so `coverage.json` regenerates byte-identically and can be drift-checked.
- `audit/` — `retry_order` counted under `epd-catalog`, which documents it,
  rather than the read-only `epd-transaction-triage`, in both the matrix and the
  skill map.

### Security

- `epd-webhooks` — the Express, FastAPI and Laravel examples accepted forged
  webhooks. The verifier scripts return a result object; the examples tested
  that object for truthiness (`if (!verifyWebhook(...))`), and an object, a
  dataclass instance and a non-empty array are always truthy, so the 401
  branch never ran. They now read `valid`, import the verifier they call, and
  the skill states the return contract. Integrations that copied the old
  examples should make the same one-line change.

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
