#!/usr/bin/env node
/**
 * Validate the epd-skills repository.
 *
 *   1. .well-known/skills/index.json parses and validates against schema.json.
 *   2. Every file the manifest lists exists on disk.
 *   3. Every SKILL.md on disk has frontmatter that validates against
 *      skill-frontmatter.schema.json, and its `name` matches the manifest.
 *   4. No SKILL.md on disk is missing from the manifest, and no manifest
 *      entry references a missing SKILL.md.
 *
 * Exits 0 on success, 1 on any failure.
 */

'use strict';

const fs = require('node:fs');
const path = require('node:path');
const matter = require('gray-matter');
const Ajv = require('ajv/dist/2020');
const addFormats = require('ajv-formats');

const REPO_ROOT = path.resolve(__dirname, '..');
const MANIFEST_PATH = path.join(REPO_ROOT, '.well-known', 'skills', 'index.json');
const MANIFEST_SCHEMA_PATH = path.join(REPO_ROOT, '.well-known', 'skills', 'schema.json');
const FRONTMATTER_SCHEMA_PATH = path.join(
  REPO_ROOT,
  '.well-known',
  'skills',
  'skill-frontmatter.schema.json',
);

const errors = [];
const warnings = [];

const fail = (msg) => errors.push(msg);
const warn = (msg) => warnings.push(msg);

const rel = (p) => path.relative(REPO_ROOT, p);

function readJson(p) {
  return JSON.parse(fs.readFileSync(p, 'utf8'));
}

function findSkillFiles(dir) {
  const out = [];
  if (!fs.existsSync(dir)) return out;
  for (const entry of fs.readdirSync(dir, { withFileTypes: true })) {
    const full = path.join(dir, entry.name);
    if (entry.isDirectory()) out.push(...findSkillFiles(full));
    else if (entry.name === 'SKILL.md') out.push(full);
  }
  return out;
}

function formatAjvErrors(errs) {
  return errs
    .map((e) => `${e.instancePath || '/'} ${e.message}${e.params ? ' ' + JSON.stringify(e.params) : ''}`)
    .join('; ');
}

function main() {
  const ajv = new Ajv({ allErrors: true, strict: true });
  addFormats(ajv);

  const manifestSchema = readJson(MANIFEST_SCHEMA_PATH);
  const frontmatterSchema = readJson(FRONTMATTER_SCHEMA_PATH);
  const validateManifest = ajv.compile(manifestSchema);
  const validateFrontmatter = ajv.compile(frontmatterSchema);

  if (!fs.existsSync(MANIFEST_PATH)) {
    fail(`manifest not found at ${rel(MANIFEST_PATH)}`);
    return finish(0);
  }

  let manifest;
  try {
    manifest = readJson(MANIFEST_PATH);
  } catch (e) {
    fail(`failed to parse ${rel(MANIFEST_PATH)}: ${e.message}`);
    return finish(0);
  }

  if (!validateManifest(manifest)) {
    fail(`manifest schema violations: ${formatAjvErrors(validateManifest.errors)}`);
    return finish(0);
  }

  const manifestSkillPaths = new Map();

  for (const skill of manifest.skills) {
    const skillMdRel = skill.files.find((f) => f.endsWith('SKILL.md'));
    if (!skillMdRel) {
      fail(`manifest skill "${skill.name}" lists no SKILL.md in files`);
      continue;
    }
    const skillMd = path.resolve(REPO_ROOT, skillMdRel);
    manifestSkillPaths.set(skillMd, skill.name);

    for (const f of skill.files) {
      const abs = path.resolve(REPO_ROOT, f);
      if (!fs.existsSync(abs)) {
        fail(`manifest skill "${skill.name}" references missing file ${f}`);
      }
    }

    if (!fs.existsSync(skillMd)) continue;

    const parsed = matter(fs.readFileSync(skillMd, 'utf8'));
    if (!parsed.matter) {
      fail(`${skillMdRel}: missing YAML frontmatter`);
      continue;
    }

    if (!validateFrontmatter(parsed.data)) {
      fail(
        `${skillMdRel}: frontmatter schema violations: ${formatAjvErrors(validateFrontmatter.errors)}`,
      );
      continue;
    }

    if (parsed.data.name !== skill.name) {
      fail(
        `${skillMdRel}: frontmatter name "${parsed.data.name}" != manifest name "${skill.name}"`,
      );
    }

    if (parsed.data.metadata?.api_version && manifest.api_version) {
      if (parsed.data.metadata.api_version !== manifest.api_version) {
        warn(
          `${skillMdRel}: api_version (${parsed.data.metadata.api_version}) differs from manifest (${manifest.api_version})`,
        );
      }
    }
  }

  const onDisk = [
    ...findSkillFiles(path.join(REPO_ROOT, 'integration')),
    ...findSkillFiles(path.join(REPO_ROOT, 'workflows')),
  ];

  for (const p of onDisk) {
    if (!manifestSkillPaths.has(p)) {
      fail(`${rel(p)}: SKILL.md exists on disk but is not listed in the manifest`);
    }
  }

  return finish(manifest.skills.length);
}

function finish(skillCount) {
  for (const w of warnings) process.stderr.write(`warn: ${w}\n`);
  if (errors.length === 0) {
    process.stdout.write(`ok — ${skillCount} skill(s) validated\n`);
    process.exit(0);
  }
  for (const e of errors) process.stderr.write(`error: ${e}\n`);
  process.stderr.write(`\n${errors.length} error(s), ${warnings.length} warning(s)\n`);
  process.exit(1);
}

main();
