# Contributing

Thanks for taking the time to improve `epd-skills`. This repo is the
canonical home of the agent skills that ship with EPD Commerce. Everything
in here is consumed by AI coding agents and operator agents at runtime —
small wording changes can change real behavior.

## Local setup

```bash
git clone https://github.com/EPDCommerce/agent-skills.git epd-skills
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

docs/
  README.md                        guide index + the shared template
  <skill>.md                       one human-facing guide per skill

scripts/
  validate.js                      manifest + frontmatter validator
  check-docs.js                    guide + Markdown link validator
  __tests__/                       node:test specs
```

`SKILL.md` files are written for an agent to load at runtime. `docs/` is written
for the humans who have to decide whether to trust what the agent did. Guides
are deliberately **not** listed in the manifest — an agent should never be
loading one.

## Adding a new skill

1. **Pick the surface.**
   - `integration/` — dev-facing, IDE-loaded, generates code (REST/SDK).
   - `workflows/` — operator-agent-facing, MCP-loaded, runs against a live
     account.
2. **Create `SKILL.md`** with the frontmatter below. Keep the body small;
   put domain detail in `references/<topic>.md` and link to it.
3. **Add to `.well-known/skills/index.json`** with every file the skill
   references.
4. **Write its guide** at `docs/<skill-name>.md` — see below. `npm run
   validate:docs` fails if a skill has no guide.
5. **Run `npm run check`** before pushing.

## Adding or changing a guide

Every skill has exactly one guide at `docs/<skill-name>.md`. They all answer the
same questions in the same order, so someone who has read one can skim the rest
— which means the template is a contract, not a suggestion, and the validator
enforces it.

```yaml
---
skill: <must match the manifest name and the file name>
surface: integration | workflow      # must match the manifest `kind`
guide_version: 1.0.0                 # semver for the guide
api_version: "2026-02-11"            # must match the manifest
---
```

Then, in this order, as `##` headings:

| Section | What goes in it |
|---|---|
| `## What it does` | The job, and the boundary with the skills either side. |
| `## When it fires` | Triggers, plus a "what it must not answer" table of the near misses. |
| `## What it refuses to do, and why` | Every refusal with the failure it prevents. The *why* is the point — a refusal without one reads as timidity and gets argued away. |
| `## What to check afterwards` | A checklist someone can actually run against a transcript. |
| `## A worked transcript` | One session end to end, confirmations shown in full. |
| `## Where it hands off` | Routing table to the neighbouring guides. |

Two rules for the content:

- **Transcripts are illustrative, and say so.** Tool names, argument shapes,
  error codes and refusal messages must be the ones the skill documents; names,
  IDs and amounts are placeholders. Do not present a composed transcript as a
  capture.
- **Never restate policy.** Tier requirements live in `SAFETY.md` and per-tool
  tiers in the generated `references/tiers.md`. A guide says how a skill
  *applies* them. If a guide and `SAFETY.md` disagree, `SAFETY.md` wins and the
  guide is a bug.

Add the new guide to the table in `docs/README.md` — the validator checks that
too.

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

`npm run check` runs all three of the following.

`npm run validate` checks:

1. `index.json` validates against `schema.json`.
2. Every file the manifest lists exists.
3. Every `SKILL.md` frontmatter validates against
   `skill-frontmatter.schema.json`.
4. Frontmatter `name` matches the manifest entry's `name`.
5. No `SKILL.md` on disk is missing from the manifest.

`npm run validate:docs` checks:

1. Every manifest skill has exactly one guide, and every guide a skill.
2. Guide frontmatter agrees with the manifest — `skill`, `surface`,
   `api_version` — and `guide_version` is semver.
3. Every guide carries all six template sections and links to its `SKILL.md`.
4. Every guide is linked from `docs/README.md`.
5. Every relative Markdown link in the repository resolves, **including its
   anchor** where it names one. A table of contents pointing at a heading
   somebody renamed is the way these rot.

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
