<!--
Thanks for the PR. Fill in what's relevant; delete what isn't.
-->

## Summary

<!-- One or two sentences. What changed and why. -->

## Type of change

- [ ] New skill
- [ ] Update to an existing skill (content)
- [ ] Tooling / CI / scripts
- [ ] Documentation only (README, CONTRIBUTING, etc.)
- [ ] Bug fix

## Skill changes (if applicable)

- Affected skills:
- API version targeted: `2026-02-11`
- Frontmatter `metadata.version` bump: <!-- e.g. 1.0.0 → 1.0.1 -->

## Verification

- [ ] `npm run check` passes locally.
- [ ] `npm run gen` run, and anything it changed committed (CI fails
      otherwise).
- [ ] `CHANGELOG.md` updated under `## [Unreleased]`.
- [ ] If a skill's behavior or trigger description changed, the
      `description` field still follows the "Use when … Triggers when …
      Skip when …" pattern.
- [ ] If a skill's description or refusals changed, or a prompt was added
      or reworded, a full `node testing/run.mjs` ran against the sandbox and
      `--render` updated `TESTING.md`. See `TESTING.md`.
- [ ] If new files were added, they're listed in
      `.well-known/skills/index.json`.

## Notes for reviewers

<!-- Anything non-obvious: trade-offs, breaking changes, follow-ups. -->
