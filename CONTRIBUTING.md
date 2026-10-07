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

recipes/
  README.md                        recipe index, template and conventions
  <recipe>.md                      one end-to-end chain across several skills

scripts/
  validate.js                      manifest + frontmatter validator
  check-docs.js                    guide, recipe, tool-call + link validator
  gen-tiers.mjs                    generates the per-tool tier table
  tier-overrides.json              SAFETY.md decision 1: tools held above their annotations
  __tests__/                       node:test specs

audit/
  tools-YYYY-MM-DD.json            committed tools/list snapshot every check reads
  *.mjs                            audit generators; see "Generated files" below

testing/
  prompts.json                     three prompt sets per skill (see TESTING.md)
  run.mjs                          runs them as agent sessions against sandbox
  lib.cjs                          grading and rendering, shared with check-docs
  results/YYYY-MM-DD.json          each full run, redacted; the newest is published
```

`SKILL.md` files are written for an agent to load at runtime. `docs/` and
`recipes/` are written for the humans who have to decide whether to trust what
the agent did. Neither is listed in the manifest — an agent should never be
loading one at runtime.

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
5. **Write its prompt sets** in `testing/prompts.json`: at least three
   `fire`, three `collide` and three `refuse` cases. A new skill also changes
   what its neighbours should stay out of, so check their `collide` cases.
   Then do a full run and `--render`; `npm run validate:docs` fails until the
   published results cover every case. See [`TESTING.md`](./TESTING.md).
6. **Run `npm run gen`, then `npm run check`** before pushing. `gen`
   regenerates the audit and tier files the new skill changes; see
   [Generated files](#generated-files).

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

## Adding or changing a recipe

A recipe chains several skills to one outcome. The template is in
[`recipes/README.md`](./recipes/README.md): seven sections, in order — Outcome,
Before you start, The chain, Steps, Where it can stop, Running it unattended,
What was verified.

```yaml
---
recipe: <must match the file name>
recipe_version: 1.0.0
api_version: "2026-02-11"          # must match the manifest
skills:                             # every skill that owns a tool it calls
  - epd-mcp-operator
highest_tier: T0 | T2 | T3          # derived from its calls; the validator checks
unattended: runs | refuses          # runs only if highest_tier is T0
verified: 2026-09-28                # when the chain was last run in sandbox
---
```

Every step is a `### N. Title` under `## Steps`, with a `**Checkpoint.**` and,
if it calls anything, an `**If it fails**` table. Identifiers in calls are
placeholders that name their source — `<step 3: customer.id>` or
`<human: …>` — never literal UUIDs.

Run the chain against sandbox before changing `verified`. The "What was
verified" section says what was measured and what was not; a recipe that has
not been run says so.

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
2. The manifest's `name` and `version` match `package.json`'s, so a release
   bumps both or neither.
3. Every file the manifest lists exists and lives inside its own skill's
   directory, and every file in a skill's directory is listed — an installer
   that reads the manifest never copies a file it omits.
4. Each skill lives at `integration/<name>/` or `workflows/<name>/`, matching
   its manifest `kind`.
5. Every `SKILL.md` frontmatter validates against
   `skill-frontmatter.schema.json`, its `name` matches the manifest entry, and
   its `metadata.api_version` matches the manifest's.
6. No `SKILL.md` on disk is missing from the manifest.
7. Every pinned API version in the repository — an `epd-version` header in an
   example, or an `API_VERSION` constant in code — is the manifest's
   `api_version`. Webhook payload schema versions are a separate thing and are
   not checked, and neither is what an agent said in a prompt-set run
   (`testing/results/`): that is a record, and its run's `api_version` is
   checked by `validate:docs` instead.

`npm run validate:docs` checks:

1. Every manifest skill has exactly one guide, and every guide a skill.
2. Guide frontmatter agrees with the manifest — `skill`, `surface`,
   `api_version` — and `guide_version` is semver.
3. Every guide carries all six template sections and links to its `SKILL.md`.
4. Every guide is linked from `docs/README.md`.
5. Every relative Markdown link in the repository resolves, **including its
   anchor** where it names one. A table of contents pointing at a heading
   somebody renamed is the way these rot.
6. Every `tool:` block anywhere names a tool in the committed `tools/list`
   snapshot, passes only parameters it declares, and passes all it requires.
7. Every recipe carries the seven sections and is indexed; its `highest_tier`
   and `unattended` match the tools it calls; every tool it calls is owned by a
   skill it lists, per `audit/COVERAGE.md`; every step has a checkpoint and
   every calling step a failure branch; and no call carries a literal UUID or
   a value from a later step.
8. `testing/prompts.json` has at least three `fire`, `collide` and `refuse`
   prompts for every skill, each well formed; the newest
   `testing/results/YYYY-MM-DD.json` ran exactly those prompts, word for word,
   in test mode against the manifest's `api_version`; and `TESTING.md`'s results
   block is that file rendered, not edited.

`npm test` runs `node:test` specs in `scripts/__tests__/`.

### Generated files

Four files are generated from the skills and the committed `tools/list`
snapshot, and are never edited by hand:

| File | Generator |
|---|---|
| `workflows/epd-mcp-operator/references/tiers.md` | `scripts/gen-tiers.mjs` |
| `audit/coverage.json` | `audit/coverage.mjs` |
| `audit/COVERAGE.md` | `audit/matrix.mjs` (reads `coverage.json`, so runs after it) |
| `audit/SKILL-MAP.md` | `audit/skill-map.mjs` |

`npm run gen` runs all four in that order. Run it after changing any
`SKILL.md`, the snapshot, or `scripts/tier-overrides.json`, and commit what it
changes. CI runs it on every PR and fails if anything differs from what is
committed, or if a generator finds a problem in the source: a `tool:` block
passing an argument the server does not declare, or a skill description that
no longer names a skill its planned routes hand off to.

`audit/key-matrix.mjs` is not part of `npm run gen`. It calls the live API with
real keys, so it is re-run by hand when key permissions are in question.

## Pull requests

- Branch from `main`. Rebase, don't merge upstream.
- One logical change per PR. Skill content + tooling changes go in
  separate PRs.
- Update `CHANGELOG.md` under `## [Unreleased]`.
- Changing a skill's `description` or what it refuses changes routing. Re-run
  its prompt sets against the sandbox with `node testing/run.mjs --only
  <skill>` while you work, and a full run before the PR, then `node
  testing/run.mjs --render`. Adding or rewording a prompt needs a full run too —
  `npm run validate:docs` fails while the published results describe different
  prompts. See [`TESTING.md`](./TESTING.md).
- The CI gate runs on every PR; please verify it's green before requesting
  review. It runs `npm run check` on Node 20, 22 and 24, regenerates the
  generated files and diffs them, self-tests the three webhook verifiers
  (Node, Python, PHP), and rejects tab characters in Markdown.

## Reporting issues

For documentation bugs (broken links, factual errors in a skill), open a
GitHub issue using the **Bug report** template.

For security issues affecting skill content (e.g. examples that leak
secrets), see [SECURITY.md](./SECURITY.md) — do not open a public issue.
