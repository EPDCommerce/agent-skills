# EPD Commerce Skills

**EPD Commerce** (EasyPayDirect) is a payments API. This repo
ships **agent skills** — Markdown files (`SKILL.md` + on-demand
`references/`) that an AI coding agent loads when it detects relevant
context, then uses to generate correct code or run correct workflows.

Drop-in for Claude Code, OpenAI Codex CLI, Cursor, and any agent that loads
filesystem-based skills. Covers REST API integration and operator-agent
workflows over the EPD Commerce MCP server.

## Two surfaces, one repo

```
integration/    IDE-loaded. Building EPD Commerce into your own backend
                via the v1 REST API.

workflows/      MCP-loaded. Operating a live EPD Commerce merchant account
                through the EPD Commerce MCP server (onboarding,
                subscription lifecycle, refunds).
```

The two surfaces don't overlap: integration skills generate code; workflow
skills invoke MCP tools against real accounts.

## Skills

### Integration

| Skill                | Purpose                                                              |
|----------------------|----------------------------------------------------------------------|
| `epd-best-practices` | Master router. Auth, idempotency, errors, pagination, filters, IDs. |
| `epd-webhooks`       | Webhook setup, HMAC verification (Node/Python/PHP), debugging.       |
| `epd-quickstart`     | First-integration walkthrough — sandbox key to first charge.         |

### Workflows

| Skill                  | Purpose                                                                |
|------------------------|------------------------------------------------------------------------|
| `epd-onboard-customer` | Vault card → create customer → add payment method → charge or sub.    |
| `epd-subscriptions`    | Lifecycle: start, change, cancel, recover past_due via dunning.        |
| `epd-refunds`          | Decision tree across `refund_order`, `refund_transaction`, etc.        |

## Install

The skills are plain Markdown — no registry, no package manager. Clone the
repo once, then symlink the skill directories you want into your agent's
skills folder. The agent loads each `SKILL.md`'s frontmatter at startup
and pulls in `references/*.md` on demand when a task triggers them.

```bash
git clone https://github.com/EPDCommerce/agent-skills.git ~/src/epd-skills
```

### Claude Code (project-level)

Symlink each skill into the project's `.claude/skills/` directory. The
agent recognizes any directory containing a `SKILL.md`.

```bash
mkdir -p .claude/skills

# Install everything:
for dir in ~/src/epd-skills/integration/* ~/src/epd-skills/workflows/*; do
  ln -s "$dir" ".claude/skills/$(basename "$dir")"
done

# Or just one skill:
ln -s ~/src/epd-skills/integration/epd-best-practices .claude/skills/
```

For user-level (available across all projects), use `~/.claude/skills/`
instead of `.claude/skills/`.

### Claude Code (as a git submodule)

If you want the skills tracked alongside your project:

```bash
git submodule add https://github.com/EPDCommerce/agent-skills.git vendor/epd-skills
mkdir -p .claude/skills
ln -s ../../vendor/epd-skills/integration/epd-best-practices .claude/skills/
```

### OpenAI Codex CLI

Codex CLI auto-discovers skills under `$CODEX_HOME/skills/` (defaults to
`~/.codex/skills/`). The `SKILL.md` anatomy is identical to Claude Code's,
so the same symlink approach works:

```bash
mkdir -p "${CODEX_HOME:-$HOME/.codex}/skills"

# Install everything:
for dir in ~/src/epd-skills/integration/* ~/src/epd-skills/workflows/*; do
  ln -s "$dir" "${CODEX_HOME:-$HOME/.codex}/skills/$(basename "$dir")"
done

# Or just one skill:
ln -s ~/src/epd-skills/integration/epd-best-practices \
  "${CODEX_HOME:-$HOME/.codex}/skills/"
```

Invoke explicitly with `$<skill-name>` in a prompt
(e.g. `$epd-best-practices help me wire a refund`). Codex also
auto-triggers skills off the `description` frontmatter, the same signal
Claude Code uses.

### Cursor

Cursor doesn't yet support filesystem-based skills natively. Point its
**Settings → Rules → Project Rules** at the cloned skill's `SKILL.md` —
Cursor will inline it as a project rule. References are not lazy-loaded,
so prefer linking only the `SKILL.md` of the most-used skill rather than
the whole tree.

### Custom agent

Read `.well-known/skills/index.json` to enumerate skills and their files.
The manifest schema is at `.well-known/skills/schema.json`; the
`SKILL.md` frontmatter schema is at
`.well-known/skills/skill-frontmatter.schema.json`. Both are JSON Schema
2020-12.

### Verify

After installing, the agent should pick the skill up automatically when
its triggers fire (env var names, key prefixes, error shapes — see each
skill's `description` field). To sanity-check the install, ask the agent
something like *"how do I make a one-time charge against EPD Commerce?"*
— it should load `epd-best-practices`, then routing-load
`references/payments.md`.

## Documentation

Full EPD Commerce API reference: <https://docs.api.epd.com/>

This repo encodes the **non-obvious patterns** that sit above the
reference — auth idiosyncrasies, idempotency rules, error envelopes, what
the validator silently ignores. The reference is authoritative for shape;
these skills are authoritative for *how to use it without losing money*.

## Versioning

Each skill ships two versions in its frontmatter `metadata` block:

- `version` — semver of the skill itself, bumped on content changes.
- `api_version` — the EPD Commerce dated API version the skill targets
  (e.g. `2026-02-11`). When EPD Commerce ships a breaking API version, the
  skill is updated and both bumps land together.

The repository's manifest at `.well-known/skills/index.json` carries a
top-level `api_version` that all skills should agree on; CI checks the
frontmatter against the manifest and warns on drift.

## Contributing

See [CONTRIBUTING.md](./CONTRIBUTING.md). The short version:

```bash
npm install
npm run check    # validate manifest + frontmatter, run tests
```

The validator (`scripts/validate.js`) checks every skill listed in
`.well-known/skills/index.json` against the JSON Schemas under that
directory: file existence, frontmatter shape, name agreement.

## Security

To report a vulnerability in the skill content or tooling, see
[SECURITY.md](./SECURITY.md). Do not open public issues for security
reports.

## License

[MIT](./LICENSE) — fork, modify, redistribute. Attribution appreciated.
