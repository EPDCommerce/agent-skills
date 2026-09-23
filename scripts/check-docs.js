#!/usr/bin/env node
/**
 * Validate the human documentation in docs/.
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
 *      that exists — in docs/, in the skills, and at the root.
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

/** Directories that are not ours to validate. */
const SKIP_DIRS = new Set(['node_modules', '.git']);

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

function main() {
  if (!fs.existsSync(DOCS_DIR)) {
    fail('docs/ not found');
    return finish(0);
  }

  const manifest = readJson(MANIFEST_PATH);
  checkGuides(manifest);

  const markdown = findMarkdown(REPO_ROOT);
  checkLinks(markdown);

  return finish(manifest.skills.length, markdown.length);
}

function finish(guideCount, mdCount = 0) {
  if (errors.length === 0) {
    process.stdout.write(
      `ok — ${guideCount} guide(s) validated, ${mdCount} markdown file(s) link-checked\n`,
    );
    process.exit(0);
  }
  for (const e of errors) process.stderr.write(`error: ${e}\n`);
  process.stderr.write(`\n${errors.length} error(s)\n`);
  process.exit(1);
}

if (require.main === module) main();

module.exports = {
  REQUIRED_SECTIONS,
  extractLinks,
  findBrokenLinks,
  headingAnchors,
  isExternal,
  slugify,
  stripFences,
};
