# Contributing

Thanks for taking the time to improve `epd-skills`. This repo is the
canonical home of the agent skills that ship with EPD Commerce. Everything
in here is consumed by AI coding agents and operator agents at runtime —
small wording changes can change real behavior.

## Local setup

```bash
git clone https://github.com/EPDCommerce/AgentSkills.git epd-skills
cd epd-skills
npm install
npm run check     # validate manifest + run tests
```

Requires Node ≥ 20.

## Repository layout

```
.well-known/skills/
  index.json                       manifest of all published skills
  schema.json                      JSON Schema for the manifest
  skill-frontmatter.schema.json    JSON Schema for SKILL.md frontmatter

integration/<skill>/
  SKILL.md                         entry point — small, links to references
  references/*.md                  on-demand domain references
  scripts/*.{js,py,php}            reusable verifier / wrapper scripts

workflows/<skill>/
  SKILL.md                         operator-agent workflow

scripts/
  validate.js                      manifest + frontmatter validator
  __tests__/                       node:test specs
```

## Adding a new skill

1. **Pick the surface.**
   - `integration/` — dev-facing, IDE-loaded, generates code (REST/SDK).
   - `workflows/` — operator-agent-facing, MCP-loaded, runs against a live
     account.
2. **Create `SKILL.md`** with the frontmatter below. Keep the body small;
   put domain detail in `references/<topic>.md` and link to it.
3. **Add to `.well-known/skills/index.json`** with every file the skill
   references.
4. **Run `npm run check`** before pushing.

### Required frontmatter

```yaml
---
name: <kebab-case-name>
description: >
  Use when <user intent>.
  Triggers when <concrete signals — env vars, imports, error shapes>.
  Skip when <surface this skill is not for>.
compatibility: <one-line scope statement>
metadata:
  version: 1.0.0
  api_version: "2026-02-11"
---
```

**`description`** is the primary discovery signal — agents decide whether
to load a skill from this string alone. Follow the **"Use when … Triggers
when … Skip when …"** pattern; concrete triggers (env vars, key prefixes,
header names) outperform vague intent.

**`compatibility`** is a one-line statement of the runtime / auth surface
the skill applies to. It tells the agent (and a reviewing human) whether
this skill is even relevant to the current environment before they read
further. Examples from the existing skills:

- `Requires an HTTP client + JSON parser in any backend language.
  Server-side only — secret keys must never reach a browser.`
- `Server-side, any backend with HMAC-SHA256 + access to the raw HTTP
  body before JSON parsing.`
- `Requires an MCP-connected agent authenticated against an EPD Commerce
  account; not for direct REST integration.`

Aim for one line that names the runtime/transport and any hard
prerequisites. Don't restate the description.

**`metadata.version`** is semver for the **skill itself**, not the API.
**`metadata.api_version`** is the EPD Commerce dated API version the
skill targets — keep it in sync with the manifest's `api_version`.

## Style

- **Honest over impressive.** If a feature isn't shipped, say so. We delete
  fabricated endpoints, fake SDK package names, and unverified behavior on
  sight.
- **Concrete over generic.** "Returns 400 with `code: invalid_payment_method_id`
  when prefixed" beats "validation may fail in some cases."
- **One source of truth per fact.** Cross-link references; don't duplicate
  explanations across SKILL.md files.
- **No marketing.** No emojis (unless explicitly requested), no
  "powerful/seamless/blazing-fast." Skills are technical artifacts.

## Validation

`npm run validate` checks:

1. `index.json` validates against `schema.json`.
2. Every file the manifest lists exists.
3. Every `SKILL.md` frontmatter validates against
   `skill-frontmatter.schema.json`.
4. Frontmatter `name` matches the manifest entry's `name`.
5. No `SKILL.md` on disk is missing from the manifest.

`npm test` runs `node:test` specs in `scripts/__tests__/`.

## Pull requests

- Branch from `main`. Rebase, don't merge upstream.
- One logical change per PR. Skill content + tooling changes go in
  separate PRs.
- Update `CHANGELOG.md` under `## [Unreleased]`.
- The CI gate runs on every PR; please verify it's green before requesting
  review.

## Reporting issues

For documentation bugs (broken links, factual errors in a skill), open a
GitHub issue using the **Bug report** template.

For security issues affecting skill content (e.g. examples that leak
secrets), see [SECURITY.md](./SECURITY.md) — do not open a public issue.
