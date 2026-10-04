#!/usr/bin/env node
/**
 * Validate the epd-skills repository.
 *
 *   1. .well-known/skills/index.json parses and validates against schema.json.
 *   2. The manifest agrees with package.json on `name` and `version`, so a
 *      release cannot bump one and ship the other.
 *   3. No two manifest entries share a name.
 *   4. Every file the manifest lists exists on disk and lives inside its own
 *      skill's directory, and every file in a skill's directory is listed.
 *      A reference or script the manifest omits is one an installer that
 *      reads the manifest never copies.
 *   5. Each skill sits at <kind>/<name>/SKILL.md: the directory matches the
 *      manifest `name`, and integration/ or workflows/ matches its `kind`.
 *   6. Every SKILL.md on disk has frontmatter that validates against
 *      skill-frontmatter.schema.json, its `name` matches the manifest, and its
 *      `metadata.api_version` matches the manifest's.
 *   7. No SKILL.md on disk is missing from the manifest, and no manifest
 *      entry references a missing SKILL.md.
 *   8. Every pinned API version in the repository — an `epd-version` header
 *      in an example or an `API_VERSION` constant in code — is the manifest's
 *      `api_version`. Webhook payload schema versions (`api_version` on an
 *      endpoint or an event) are a different thing and are not checked.
 *
 * Exits 0 on success, 1 on any failure.
 */

'use strict';

const fs = require('node:fs');
const path = require('node:path');
const matter = require('gray-matter');
const Ajv = require('ajv/dist/2020');
const addFormats = require('ajv-formats');

/** Where each kind of skill lives, and the reverse. */
const KIND_DIR = { integration: 'integration', workflow: 'workflows' };

/** Files scanned for a pinned API version. */
const VERSION_SCAN_EXT = new Set(['.md', '.js', '.mjs', '.cjs', '.py', '.php', '.json', '.yml', '.yaml']);
const SKIP_DIRS = new Set(['node_modules', '.git']);
const SKIP_FILES = new Set(['package-lock.json']);
/**
 * Not scanned for pinned versions: this file's own comments quote the forms
 * it matches, and the tests build fixtures that pin wrong versions on purpose.
 */
const SKIP_VERSION_SCAN = ['scripts/validate.js', 'scripts/__tests__/'];

/**
 * `epd-version: 2026-02-11`, `"epd-version": "2026-02-11"`,
 * `'EPD-Version': '2026-02-11'`, and `EPD_API_VERSION = '2026-02-11'` or
 * `process.env.EPD_API_VERSION ?? '2026-02-11'`. The constant form is
 * case-sensitive so a lowercase `api_version` field in a webhook payload,
 * which carries the webhook schema version, never matches.
 */
const VERSION_PATTERNS = [
  /\bepd-version\b["']?\s*(?::|=>|,)\s*["']?(\d{4}-\d{2}-\d{2})/gi,
  /\b[A-Z_]*API_VERSION\b[^\n]{0,40}?(\d{4}-\d{2}-\d{2})/g,
];

/**
 * The guard against a silent pass, as in check-docs.js: if a refactor stops
 * the patterns matching, the check would succeed by finding nothing.
 */
const MIN_PINNED_VERSIONS = 20;

function readJson(p) {
  return JSON.parse(fs.readFileSync(p, 'utf8'));
}

function walk(dir, keep) {
  const out = [];
  if (!fs.existsSync(dir)) return out;
  for (const entry of fs.readdirSync(dir, { withFileTypes: true })) {
    if (SKIP_DIRS.has(entry.name)) continue;
    const full = path.join(dir, entry.name);
    if (entry.isDirectory()) out.push(...walk(full, keep));
    else if (keep(entry.name)) out.push(full);
  }
  return out;
}

function formatAjvErrors(errs) {
  return errs
    .map((e) => `${e.instancePath || '/'} ${e.message}${e.params ? ' ' + JSON.stringify(e.params) : ''}`)
    .join('; ');
}

/** Every pinned API version in `src`, with its line number. */
function findPinnedVersions(src) {
  const found = [];
  for (const re of VERSION_PATTERNS) {
    re.lastIndex = 0;
    let m;
    while ((m = re.exec(src)) !== null) {
      found.push({ version: m[1], line: src.slice(0, m.index).split('\n').length });
    }
  }
  return found;
}

/**
 * Validate the repository rooted at `root`. Pure apart from reading the
 * filesystem, so the tests can point it at a fixture.
 */
function validateRepo(root, { minPinned = MIN_PINNED_VERSIONS } = {}) {
  const errors = [];
  const warnings = [];
  const fail = (msg) => errors.push(msg);
  const rel = (p) => path.relative(root, p).split(path.sep).join('/');
  const result = (skillCount, pinned = 0) => ({ errors, warnings, skillCount, pinned });

  const wk = path.join(root, '.well-known', 'skills');
  const manifestPath = path.join(wk, 'index.json');

  const ajv = new Ajv({ allErrors: true, strict: true });
  addFormats(ajv);
  const validateManifest = ajv.compile(readJson(path.join(wk, 'schema.json')));
  const validateFrontmatter = ajv.compile(readJson(path.join(wk, 'skill-frontmatter.schema.json')));

  if (!fs.existsSync(manifestPath)) {
    fail(`manifest not found at ${rel(manifestPath)}`);
    return result(0);
  }

  let manifest;
  try {
    manifest = readJson(manifestPath);
  } catch (e) {
    fail(`failed to parse ${rel(manifestPath)}: ${e.message}`);
    return result(0);
  }

  if (!validateManifest(manifest)) {
    fail(`manifest schema violations: ${formatAjvErrors(validateManifest.errors)}`);
    return result(0);
  }

  const pkgPath = path.join(root, 'package.json');
  if (fs.existsSync(pkgPath)) {
    const pkg = readJson(pkgPath);
    if (pkg.name !== manifest.name) {
      fail(`manifest name "${manifest.name}" != package.json name "${pkg.name}"`);
    }
    if (pkg.version !== manifest.version) {
      fail(`manifest version "${manifest.version}" != package.json version "${pkg.version}"`);
    }
  } else {
    fail('package.json not found');
  }

  const seen = new Set();
  for (const skill of manifest.skills) {
    if (seen.has(skill.name)) fail(`manifest lists skill "${skill.name}" more than once`);
    seen.add(skill.name);
  }

  const manifestSkillPaths = new Map();

  for (const skill of manifest.skills) {
    const skillMdRel = skill.files.find((f) => f.endsWith('SKILL.md'));
    if (!skillMdRel) {
      fail(`manifest skill "${skill.name}" lists no SKILL.md in files`);
      continue;
    }
    const skillMd = path.resolve(root, skillMdRel);
    const skillDir = path.dirname(skillMd);
    manifestSkillPaths.set(skillMd, skill.name);

    const expectedDir = `${KIND_DIR[skill.kind]}/${skill.name}`;
    if (rel(skillDir) !== expectedDir) {
      fail(`manifest skill "${skill.name}" (kind ${skill.kind}) should live at ${expectedDir}/, not ${rel(skillDir)}/`);
    }

    const listed = new Set();
    for (const f of skill.files) {
      const abs = path.resolve(root, f);
      listed.add(abs);
      if (!fs.existsSync(abs)) {
        fail(`manifest skill "${skill.name}" references missing file ${f}`);
      }
      if (!abs.startsWith(skillDir + path.sep)) {
        fail(`manifest skill "${skill.name}" lists ${f}, which is outside ${rel(skillDir)}/`);
      }
    }
    for (const onDisk of walk(skillDir, () => true)) {
      if (!listed.has(onDisk)) {
        fail(`${rel(onDisk)} is in ${skill.name}'s directory but not in its manifest files`);
      }
    }

    if (!fs.existsSync(skillMd)) continue;

    // Any options object turns off gray-matter's cache. A cache hit — the same
    // text parsed twice — comes back with `matter` undefined, which the check
    // below would report as missing frontmatter.
    const parsed = matter(fs.readFileSync(skillMd, 'utf8'), {});
    if (!parsed.matter) {
      fail(`${skillMdRel}: missing YAML frontmatter`);
      continue;
    }

    if (!validateFrontmatter(parsed.data)) {
      fail(`${skillMdRel}: frontmatter schema violations: ${formatAjvErrors(validateFrontmatter.errors)}`);
      continue;
    }

    if (parsed.data.name !== skill.name) {
      fail(`${skillMdRel}: frontmatter name "${parsed.data.name}" != manifest name "${skill.name}"`);
    }

    if (parsed.data.metadata.api_version !== manifest.api_version) {
      fail(
        `${skillMdRel}: metadata.api_version "${parsed.data.metadata.api_version}" != manifest "${manifest.api_version}"`,
      );
    }
  }

  const onDisk = [
    ...walk(path.join(root, 'integration'), (n) => n === 'SKILL.md'),
    ...walk(path.join(root, 'workflows'), (n) => n === 'SKILL.md'),
  ];
  for (const p of onDisk) {
    if (!manifestSkillPaths.has(p)) {
      fail(`${rel(p)}: SKILL.md exists on disk but is not listed in the manifest`);
    }
  }

  let pinned = 0;
  const scanned = walk(root, (n) => VERSION_SCAN_EXT.has(path.extname(n)) && !SKIP_FILES.has(n)).filter(
    (f) => !SKIP_VERSION_SCAN.some((s) => rel(f).startsWith(s)),
  );
  for (const file of scanned) {
    for (const { version, line } of findPinnedVersions(fs.readFileSync(file, 'utf8'))) {
      pinned++;
      if (version !== manifest.api_version) {
        fail(`${rel(file)}:${line}: pins API version ${version}, manifest says ${manifest.api_version}`);
      }
    }
  }
  if (pinned < minPinned) {
    fail(
      `only ${pinned} pinned API version(s) found, expected at least ${minPinned} — ` +
        'the patterns are probably matching nothing rather than everything agreeing',
    );
  }

  return result(manifest.skills.length, pinned);
}

function main() {
  const { errors, warnings, skillCount, pinned } = validateRepo(path.resolve(__dirname, '..'));
  for (const w of warnings) process.stderr.write(`warn: ${w}\n`);
  if (errors.length === 0) {
    process.stdout.write(`ok — ${skillCount} skill(s) validated, ${pinned} pinned API version(s) agree\n`);
    process.exit(0);
  }
  for (const e of errors) process.stderr.write(`error: ${e}\n`);
  process.stderr.write(`\n${errors.length} error(s), ${warnings.length} warning(s)\n`);
  process.exit(1);
}

if (require.main === module) main();

module.exports = { findPinnedVersions, validateRepo, MIN_PINNED_VERSIONS };
