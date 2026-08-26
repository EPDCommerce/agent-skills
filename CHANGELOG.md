# Changelog

All notable changes to this project will be documented in this file.

The format is based on [Keep a Changelog](https://keepachangelog.com/en/1.1.0/),
and this project adheres to [Semantic Versioning](https://semver.org/spec/v2.0.0.html).

## [0.1.0] - 2026-05-12

- `audit/` — Phase A coverage audit. Live `tools/list` snapshot, tool-by-tool coverage matrix, proposed 12-skill map with routing and measured API key permissions. Analysis only; no skill content changes.

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
