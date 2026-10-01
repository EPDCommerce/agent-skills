#!/usr/bin/env node
/**
 * Validate the documentation in docs/, and the tool calls documented
 * anywhere in the repository.
 *
 *   1. Every skill in the manifest has exactly one guide at docs/<name>.md,
 *      and no guide exists for a skill that doesn't.
 *   2. Guide frontmatter agrees with the manifest: `skill` matches the file
 *      name and a manifest entry, `surface` matches the manifest `kind`,
 *      `api_version` matches the manifest, `guide_version` is semver.
 *   3. Every guide carries the shared template's sections. A guide missing
 *      one is a guide that answers a different set of questions from its
 *      eleven siblings, which is the whole value of having a template.
 *   4. Every guide is linked from the docs index.
 *   5. Every relative Markdown link in the repository resolves to a file
 *      that exists — in docs/, in the skills, and at the root — including
 *      the heading its anchor names, where it names one.
 *   6. Every `tool:` block, in a guide or a SKILL.md, names a tool the
 *      committed tools/list snapshot declares, passes only parameters that
 *      tool declares, and passes all of the ones it requires.
 *   7. Every recipe in recipes/ carries the shared sections, is indexed, and
 *      makes claims its own tool calls bear out: the tier it says is its
 *      highest, whether it can run unattended, and which skills it chains.
 *      Every step has a checkpoint, every step that calls something says what
 *      to do when the call fails, and no identifier in a call is either a
 *      literal UUID or taken from a step that has not happened yet.
 *
 * Exits 0 on success, 1 on any failure.
 */

'use strict';

const fs = require('node:fs');
const path = require('node:path');
const matter = require('gray-matter');

const REPO_ROOT = path.resolve(__dirname, '..');
const DOCS_DIR = path.join(REPO_ROOT, 'docs');
const DOCS_INDEX = path.join(DOCS_DIR, 'README.md');
const MANIFEST_PATH = path.join(REPO_ROOT, '.well-known', 'skills', 'index.json');

/** Sections every guide answers, in the order the index promises them. */
const REQUIRED_SECTIONS = [
  'What it does',
  'When it fires',
  'What it refuses to do, and why',
  'What to check afterwards',
  'A worked transcript',
  'Where it hands off',
];

const SEMVER = /^\d+\.\d+\.\d+$/;

const RECIPES_DIR = path.join(REPO_ROOT, 'recipes');
const RECIPES_INDEX = path.join(RECIPES_DIR, 'README.md');
const COVERAGE_MD = path.join(REPO_ROOT, 'audit', 'COVERAGE.md');
// SAFETY.md decision 1: tools held to a stricter tier than their annotations.
// gen-tiers.mjs applies the same file, so the two cannot disagree.
const TIER_OVERRIDES = JSON.parse(
  fs.readFileSync(path.join(REPO_ROOT, 'scripts', 'tier-overrides.json'), 'utf8'),
).tools;

/** Sections every recipe answers, in the order recipes/README.md promises. */
const RECIPE_SECTIONS = [
  'Outcome',
  'Before you start',
  'The chain',
  'Steps',
  'Where it can stop',
  'Running it unattended',
  'What was verified',
];

/**
 * T1 is not a tier a tool has — it is any write made in test mode — so a
 * recipe's highest tier is stated for live mode and is one of these three.
 */
const TIER_RANK = { T0: 0, T2: 2, T3: 3 };

const UUID = /[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}/i;

/** Directories that are not ours to validate. */
const SKIP_DIRS = new Set(['node_modules', '.git']);

/**
 * Every `tool:` block in the repository is checked against the committed
 * tools/list snapshot, so a documented call cannot name a tool the server does
 * not have or pass an argument it does not declare.
 *
 * Overlaps `audit/coverage.mjs` on purpose. That script makes the same argument
 * check over `integration/` and `workflows/`, but it is an audit generator run
 * by hand — it writes `audit/coverage.json` — and nothing in CI invokes it.
 * This runs on every push and also covers `docs/`, which coverage.mjs does not
 * look at. Keeping both means the audit output stays reproducible and the
 * guides cannot drift between audits.
 *
 * MIN_TOOL_BLOCKS is the guard against a silent pass: if a refactor stops the
 * blocks being found, the check would otherwise succeed by matching nothing,
 * which is indistinguishable from succeeding correctly.
 */
const MIN_TOOL_BLOCKS = 70;

const errors = [];
const fail = (msg) => errors.push(msg);
const rel = (p) => path.relative(REPO_ROOT, p).split(path.sep).join('/');

function readJson(p) {
  return JSON.parse(fs.readFileSync(p, 'utf8'));
}

function findMarkdown(dir) {
  const out = [];
  if (!fs.existsSync(dir)) return out;
  for (const entry of fs.readdirSync(dir, { withFileTypes: true })) {
    if (SKIP_DIRS.has(entry.name)) continue;
    const full = path.join(dir, entry.name);
    if (entry.isDirectory()) out.push(...findMarkdown(full));
    else if (entry.name.endsWith('.md')) out.push(full);
  }
  return out;
}

/**
 * Strip fenced code blocks so that links inside examples aren't checked.
 * Replaces each fenced line with an empty one to keep line numbers intact.
 */
function stripFences(src) {
  let inFence = false;
  return src
    .split('\n')
    .map((line) => {
      if (/^\s*(```|~~~)/.test(line)) {
        inFence = !inFence;
        return '';
      }
      return inFence ? '' : line;
    })
    .join('\n');
}

/** Inline links: [text](target). Autolinks and bare URLs are left alone. */
function extractLinks(src) {
  const out = [];
  const lines = stripFences(src).split('\n');
  lines.forEach((line, i) => {
    const re = /\[(?:[^\]]*)\]\(([^)\s]+)(?:\s+"[^"]*")?\)/g;
    let m;
    while ((m = re.exec(line)) !== null) out.push({ target: m[1], line: i + 1 });
  });
  return out;
}

/** http:, https:, mailto:, and protocol-relative — nothing on disk to check. */
function isExternal(target) {
  return /^[a-z][a-z0-9+.-]*:/i.test(target) || target.startsWith('//');
}

/**
 * GitHub's heading slug: lowercase, drop punctuation other than hyphen and
 * underscore, spaces to hyphens. Repeats get -1, -2, ... in document order.
 */
function slugify(heading) {
  return heading
    .replace(/`/g, '')
    .toLowerCase()
    .replace(/[^\w\s-]/g, '')
    .trim()
    .replace(/\s/g, '-');
}

function headingAnchors(src) {
  const seen = new Map();
  const anchors = new Set();
  for (const line of stripFences(src).split('\n')) {
    const m = /^#{1,6}\s+(.+?)\s*$/.exec(line);
    if (!m) continue;
    const base = slugify(m[1]);
    const n = seen.get(base) || 0;
    seen.set(base, n + 1);
    anchors.add(n === 0 ? base : `${base}-${n}`);
  }
  return anchors;
}

/**
 * Relative links in `src` that don't resolve, as if `src` were the contents
 * of `file`. Checks the anchor too, where the target is Markdown — a table of
 * contents that points at a heading someone renamed is the way these rot.
 * Pure apart from the filesystem reads, so it can be tested without writing
 * scratch files into the repository.
 */
function findBrokenLinks(file, src) {
  const broken = [];
  const anchorsOf = (p, source) => headingAnchors(source !== undefined ? source : fs.readFileSync(p, 'utf8'));

  for (const { target, line } of extractLinks(src)) {
    if (isExternal(target)) continue;

    const [rawPath, anchor] = target.split('#');

    if (rawPath === '') {
      // Same-file anchor.
      if (anchor && !anchorsOf(file, src).has(anchor)) {
        broken.push({ target, line, reason: 'anchor' });
      }
      continue;
    }

    const resolved = path.resolve(path.dirname(file), decodeURIComponent(rawPath));
    if (!fs.existsSync(resolved)) {
      broken.push({ target, line, reason: 'missing' });
      continue;
    }

    if (anchor && resolved.endsWith('.md') && fs.statSync(resolved).isFile()) {
      if (!anchorsOf(resolved).has(anchor)) broken.push({ target, line, reason: 'anchor' });
    }
  }
  return broken;
}

function checkLinks(files) {
  for (const file of files) {
    const src = fs.readFileSync(file, 'utf8');
    for (const { target, line, reason } of findBrokenLinks(file, src)) {
      fail(
        reason === 'anchor'
          ? `${rel(file)}:${line}: no such heading for anchor — ${target}`
          : `${rel(file)}:${line}: link target does not exist — ${target}`,
      );
    }
  }
}

/** Newest audit/tools-YYYY-MM-DD.json, matching how gen-tiers.mjs picks one. */
function loadToolSnapshot() {
  const dir = path.join(REPO_ROOT, 'audit');
  if (!fs.existsSync(dir)) return null;
  const snaps = fs
    .readdirSync(dir)
    .filter((f) => /^tools-\d{4}-\d{2}-\d{2}\.json$/.test(f))
    .sort();
  if (!snaps.length) return null;
  const raw = readJson(path.join(dir, snaps[snaps.length - 1]));
  const tools = raw.tools || (raw.result && raw.result.tools);
  return Array.isArray(tools) ? { name: snaps[snaps.length - 1], tools } : null;
}

/**
 * Pull `tool: <name>` / `input:` blocks out of a fenced example. Line endings
 * are normalised first: a Windows checkout with core.autocrlf stores CRLF, and
 * a \n-only pattern silently matches nothing there.
 */
function extractToolBlocks(src) {
  const text = src.replace(/\r\n/g, '\n');
  const fence = '`'.repeat(3);
  // `input:` is followed either by an indented block or by an inline `{}`,
  // which is how the no-argument tools like `ping` are written. Capturing
  // everything up to the fence handles both; an inline `{}` yields no args.
  const re = new RegExp(`tool: (\\w+)\\ninput:([\\s\\S]*?)\\n?${fence}`, 'g');
  const out = [];
  let m;
  while ((m = re.exec(text)) !== null) {
    const args = [...m[2].matchAll(/^ {2}(\w+):/gm)].map((a) => a[1]);
    const line = text.slice(0, m.index).split('\n').length;
    out.push({ tool: m[1], args, line, body: m[2] });
  }
  return out;
}

function extractToolCalls(src) {
  return extractToolBlocks(src).map(({ tool, args, line }) => ({ tool, args, line }));
}

function checkToolCalls(snapshot, files) {
  if (!snapshot) {
    fail('no audit/tools-YYYY-MM-DD.json snapshot found to check tool calls against');
    return 0;
  }
  let seen = 0;

  for (const file of files) {
    const src = fs.readFileSync(file, 'utf8');
    for (const { tool, args, line } of extractToolCalls(src)) {
      seen++;
      const def = snapshot.tools.find((t) => t.name === tool);
      if (!def) {
        fail(`${rel(file)}:${line}: no tool named "${tool}" in ${snapshot.name}`);
        continue;
      }
      const schema = def.inputSchema || {};
      const declared = Object.keys(schema.properties || {});
      const required = schema.required || [];

      for (const a of args) {
        if (!declared.includes(a)) {
          fail(`${rel(file)}:${line}: ${tool} has no parameter "${a}"`);
        }
      }
      for (const r of required) {
        if (!args.includes(r)) {
          fail(`${rel(file)}:${line}: ${tool} is missing required parameter "${r}"`);
        }
      }
    }
  }

  if (seen < MIN_TOOL_BLOCKS) {
    fail(
      `only ${seen} tool block(s) found, expected at least ${MIN_TOOL_BLOCKS} — ` +
        'the extractor is probably matching nothing rather than everything being fine',
    );
  }
  return seen;
}

function checkGuides(manifest) {
  if (!fs.existsSync(DOCS_INDEX)) {
    fail(`docs index not found at ${rel(DOCS_INDEX)}`);
    return;
  }
  const index = fs.readFileSync(DOCS_INDEX, 'utf8');

  const guidesOnDisk = fs
    .readdirSync(DOCS_DIR)
    .filter((f) => f.endsWith('.md') && f !== 'README.md');

  const expected = new Map(manifest.skills.map((s) => [s.name, s]));

  for (const [name, skill] of expected) {
    const guidePath = path.join(DOCS_DIR, `${name}.md`);
    if (!fs.existsSync(guidePath)) {
      fail(`skill "${name}" has no guide at docs/${name}.md`);
      continue;
    }

    const parsed = matter(fs.readFileSync(guidePath, 'utf8'));
    const fm = parsed.data || {};

    if (fm.skill !== name) {
      fail(`docs/${name}.md: frontmatter skill "${fm.skill}" != "${name}"`);
    }
    if (fm.surface !== skill.kind) {
      fail(
        `docs/${name}.md: frontmatter surface "${fm.surface}" != manifest kind "${skill.kind}"`,
      );
    }
    if (!SEMVER.test(String(fm.guide_version || ''))) {
      fail(`docs/${name}.md: guide_version "${fm.guide_version}" is not semver`);
    }
    if (manifest.api_version && fm.api_version !== manifest.api_version) {
      fail(
        `docs/${name}.md: api_version "${fm.api_version}" != manifest "${manifest.api_version}"`,
      );
    }

    for (const section of REQUIRED_SECTIONS) {
      const heading = new RegExp(`^#{2,3}\\s+${section.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')}\\s*$`, 'm');
      if (!heading.test(parsed.content)) {
        fail(`docs/${name}.md: missing required section "## ${section}"`);
      }
    }

    // The guide has to point at the skill it documents.
    const skillMd = skill.files.find((f) => f.endsWith('SKILL.md'));
    if (skillMd && !parsed.content.includes(skillMd)) {
      fail(`docs/${name}.md: does not link to its skill (${skillMd})`);
    }

    if (!index.includes(`(./${name}.md)`)) {
      fail(`docs/README.md: does not link to docs/${name}.md`);
    }
  }

  for (const file of guidesOnDisk) {
    const name = file.replace(/\.md$/, '');
    if (!expected.has(name)) {
      fail(`docs/${file}: no skill named "${name}" in the manifest`);
    }
  }
}

/**
 * A tool's tier, derived from its server annotations by the same rule
 * scripts/gen-tiers.mjs uses for references/tiers.md, so a recipe's stated
 * tier is checked against the table readers are told to trust. A tool in
 * tier-overrides.json takes the tier SAFETY.md decision 1 gives it.
 */
function tierOfTool(def) {
  const a = (def && def.annotations) || {};
  const override = def && TIER_OVERRIDES[def.name];
  if (override) return override.tier;
  if (a.readOnlyHint) return 'T0';
  if (a.destructiveHint) return 'T3';
  return 'T2';
}

/**
 * Tool ownership, read from audit/COVERAGE.md. The table itself lives in
 * audit/matrix.mjs, which writes files when it runs and so cannot be imported;
 * COVERAGE.md is its committed output. Returns null unless every tool in the
 * snapshot has an owner, so a change to the table's layout fails loudly
 * instead of leaving every tool unowned and every recipe passing.
 */
function loadOwners(snapshot) {
  if (!snapshot || !fs.existsSync(COVERAGE_MD)) return null;
  const owners = new Map();
  for (const line of fs.readFileSync(COVERAGE_MD, 'utf8').split(/\r?\n/)) {
    // | `tool` | Group | Annotations | Tier | `idempotency_key` | Today | `owner` | Treatment | Notes |
    const cells = line.split('|').map((c) => c.trim());
    const tool = /^`(\w+)`$/.exec(cells[1] || '');
    const owner = /^`([\w-]+)`$/.exec(cells[7] || '');
    if (tool && owner) owners.set(tool[1], owner[1]);
  }
  return snapshot.tools.every((t) => owners.has(t.name)) ? owners : null;
}

/**
 * The `### N. Title` steps under `## Steps`, each with the text up to the next
 * step. Headings inside fenced blocks are not headings.
 */
function recipeSteps(content) {
  const steps = [];
  let inFence = false;
  let inSteps = false;
  let current = null;
  for (const line of content.replace(/\r\n/g, '\n').split('\n')) {
    if (/^\s*(```|~~~)/.test(line)) inFence = !inFence;
    if (!inFence && /^## /.test(line)) {
      inSteps = /^## Steps\s*$/.test(line);
      current = null;
      continue;
    }
    const step = !inFence && inSteps && /^### (\d+)\.\s+(.*)$/.exec(line);
    if (step) {
      current = { num: Number(step[1]), title: step[2].trim(), body: '' };
      steps.push(current);
      continue;
    }
    if (current) current.body += `${line}\n`;
  }
  return steps;
}

/**
 * Everything wrong with one recipe, as messages. Pure apart from its inputs,
 * so the tests can hand it a broken recipe without writing files.
 */
function recipeProblems({ name, src, manifest, snapshot, owners, index }) {
  const problems = [];
  const { data: fm = {}, content } = matter(src);
  const skillNames = new Set(manifest.skills.map((s) => s.name));

  if (fm.recipe !== name) problems.push(`frontmatter recipe "${fm.recipe}" != "${name}"`);
  if (!SEMVER.test(String(fm.recipe_version || ''))) {
    problems.push(`recipe_version "${fm.recipe_version}" is not semver`);
  }
  if (manifest.api_version && fm.api_version !== manifest.api_version) {
    problems.push(`api_version "${fm.api_version}" != manifest "${manifest.api_version}"`);
  }
  // YAML reads an unquoted date as a Date, so accept either form.
  const verified = fm.verified instanceof Date ? fm.verified.toISOString().slice(0, 10) : String(fm.verified || '');
  if (!/^\d{4}-\d{2}-\d{2}$/.test(verified)) problems.push(`verified "${fm.verified}" is not a date`);

  const skills = Array.isArray(fm.skills) ? fm.skills : [];
  if (!skills.length) problems.push('frontmatter lists no skills');
  for (const s of skills) {
    if (!skillNames.has(s)) problems.push(`names skill "${s}", which is not in the manifest`);
    else if (!content.includes(`${s}.md`) && !content.includes(`${s}/SKILL.md`)) {
      problems.push(`names skill "${s}" but never links to it`);
    }
  }

  for (const section of RECIPE_SECTIONS) {
    const heading = new RegExp(`^##\\s+${section.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')}\\s*$`, 'm');
    if (!heading.test(content)) problems.push(`missing required section "## ${section}"`);
  }
  if (!index.includes(`(./${name}.md)`)) problems.push('is not linked from recipes/README.md');

  // The tier, the owners and the identifiers, from the calls themselves.
  let highest = 'T0';
  for (const { tool, body, line } of extractToolBlocks(src)) {
    const def = snapshot.tools.find((t) => t.name === tool);
    if (!def) continue; // checkToolCalls reports the unknown tool
    const tier = tierOfTool(def);
    if (TIER_RANK[tier] > TIER_RANK[highest]) highest = tier;
    const owner = owners.get(tool);
    if (owner && !skills.includes(owner)) {
      problems.push(`line ${line}: calls ${tool}, which ${owner} owns, but ${owner} is not in its skills`);
    }
    if (UUID.test(body)) {
      problems.push(`line ${line}: passes ${tool} a literal UUID — an identifier comes from an earlier response`);
    }
  }
  if (fm.highest_tier !== highest) {
    problems.push(`highest_tier "${fm.highest_tier}" but its tool calls reach ${highest}`);
  }
  // SAFETY.md grants no standing authorizations, so only a chain of reads may
  // run with nobody present. When EPD grants one, this rule has to learn which
  // tools, in which mode, the authorization names.
  const unattended = highest === 'T0' ? 'runs' : 'refuses';
  if (fm.unattended !== unattended) {
    problems.push(`unattended "${fm.unattended}", but a chain reaching ${highest} ${unattended}`);
  }

  const steps = recipeSteps(content);
  if (!steps.length) problems.push('has no "### N." steps under "## Steps"');
  const numbers = new Set(steps.map((s) => s.num));
  steps.forEach((step, i) => {
    if (step.num !== i + 1) problems.push(`step "${step.num}. ${step.title}" is out of sequence`);
    if (!/\*\*Checkpoint/.test(step.body)) problems.push(`step ${step.num} has no **Checkpoint**`);
    const calls = /^tool: \w+$/m.test(step.body) || /^```http\s*$/m.test(step.body);
    if (calls && !/\*\*If it fails/.test(step.body)) {
      problems.push(`step ${step.num} calls something but has no **If it fails**`);
    }
    for (const ref of step.body.matchAll(/<(step [^>]*)>/g)) {
      for (const n of ref[1].matchAll(/\bstep (\d+)/g)) {
        const from = Number(n[1]);
        if (!numbers.has(from)) problems.push(`step ${step.num} takes <${ref[1]}> from a step that does not exist`);
        else if (from > step.num) problems.push(`step ${step.num} takes <${ref[1]}> from a later step`);
      }
    }
  });

  return problems;
}

function checkRecipes(manifest, snapshot) {
  if (!fs.existsSync(RECIPES_INDEX)) {
    fail('recipes/README.md not found');
    return 0;
  }
  if (!snapshot) return 0; // checkToolCalls has already reported it
  const owners = loadOwners(snapshot);
  if (!owners) {
    fail(`${rel(COVERAGE_MD)} does not give an owner for every tool — regenerate it with node audit/matrix.mjs`);
    return 0;
  }

  const index = fs.readFileSync(RECIPES_INDEX, 'utf8');
  const files = fs.readdirSync(RECIPES_DIR).filter((f) => f.endsWith('.md') && f !== 'README.md');
  if (!files.length) fail('recipes/ holds no recipes');

  for (const file of files) {
    const name = file.replace(/\.md$/, '');
    const src = fs.readFileSync(path.join(RECIPES_DIR, file), 'utf8');
    for (const p of recipeProblems({ name, src, manifest, snapshot, owners, index })) {
      fail(`recipes/${file}: ${p}`);
    }
  }
  return files.length;
}

function main() {
  if (!fs.existsSync(DOCS_DIR)) {
    fail('docs/ not found');
    return finish(0);
  }

  const manifest = readJson(MANIFEST_PATH);
  checkGuides(manifest);

  const markdown = findMarkdown(REPO_ROOT);
  checkLinks(markdown);
  const snapshot = loadToolSnapshot();
  const toolCalls = checkToolCalls(snapshot, markdown);
  const recipes = checkRecipes(manifest, snapshot);

  return finish(manifest.skills.length, markdown.length, toolCalls, recipes);
}

function finish(guideCount, mdCount = 0, toolCalls = 0, recipeCount = 0) {
  if (errors.length === 0) {
    process.stdout.write(
      `ok — ${guideCount} guide(s) validated, ${recipeCount} recipe(s) validated, ` +
        `${mdCount} markdown file(s) link-checked, ${toolCalls} tool call(s) checked against the snapshot\n`,
    );
    process.exit(0);
  }
  for (const e of errors) process.stderr.write(`error: ${e}\n`);
  process.stderr.write(`\n${errors.length} error(s)\n`);
  process.exit(1);
}

if (require.main === module) main();

module.exports = {
  MIN_TOOL_BLOCKS,
  RECIPE_SECTIONS,
  REQUIRED_SECTIONS,
  extractLinks,
  extractToolBlocks,
  extractToolCalls,
  findBrokenLinks,
  headingAnchors,
  isExternal,
  loadOwners,
  loadToolSnapshot,
  recipeProblems,
  recipeSteps,
  slugify,
  stripFences,
  tierOfTool,
  TIER_OVERRIDES,
};
