#!/usr/bin/env node
'use strict';

const fs = require('node:fs');
const path = require('node:path');

const defaultRepoRoot = path.resolve(__dirname, '..');

function parseRootArgument(args) {
  if (args.length === 0) return defaultRepoRoot;
  if (args.length === 2 && args[0] === '--root' && args[1]) {
    return path.resolve(args[1]);
  }
  throw new Error('usage: version-consistency-check.cjs [--root <repository>]');
}

function readJson(repoRoot, relativePath) {
  const filePath = path.join(repoRoot, relativePath);
  try {
    return JSON.parse(fs.readFileSync(filePath, 'utf8'));
  } catch (error) {
    const detail = error instanceof Error ? error.message : String(error);
    throw new Error(`${relativePath} could not be read as JSON: ${detail}`);
  }
}

function requireVersion(value, label) {
  if (typeof value !== 'string' || value.trim().length === 0) {
    throw new Error(`${label} must contain a non-empty version`);
  }
  return value;
}

function readPackageVersions(repoRoot, directory) {
  const prefix = directory === '.' ? '' : `${directory}/`;
  const packageJson = readJson(repoRoot, `${prefix}package.json`);
  const packageLock = readJson(repoRoot, `${prefix}package-lock.json`);
  return [
    {
      label: `${prefix}package.json`,
      version: requireVersion(packageJson.version, `${prefix}package.json`),
    },
    {
      label: `${prefix}package-lock.json`,
      version: requireVersion(packageLock.version, `${prefix}package-lock.json`),
    },
    {
      label: `${prefix}package-lock.json packages[""]`,
      version: requireVersion(
        packageLock.packages?.['']?.version,
        `${prefix}package-lock.json packages[""]`,
      ),
    },
  ];
}

function collectVersionEntries(repoRoot) {
  const entries = [
    ...readPackageVersions(repoRoot, '.'),
    ...readPackageVersions(repoRoot, 'omx-dispatch'),
    ...readPackageVersions(repoRoot, 'omx-bridge-plugin'),
  ];
  const pluginManifest = readJson(repoRoot, 'omx-bridge-plugin/openclaw.plugin.json');
  entries.push({
    label: 'omx-bridge-plugin/openclaw.plugin.json',
    version: requireVersion(
      pluginManifest.version,
      'omx-bridge-plugin/openclaw.plugin.json',
    ),
  });
  return entries;
}

function checkVersionConsistency(repoRoot) {
  const entries = collectVersionEntries(repoRoot);
  const expected = entries[0].version;
  const mismatches = entries.filter((entry) => entry.version !== expected);
  return { expected, entries, mismatches };
}

function main(
  args = process.argv.slice(2),
  output = { stdout: process.stdout, stderr: process.stderr },
) {
  try {
    const repoRoot = parseRootArgument(args);
    const result = checkVersionConsistency(repoRoot);
    if (result.mismatches.length === 0) {
      output.stdout.write(`[version-consistency] passed (${result.expected})\n`);
      return 0;
    }

    output.stderr.write('[version-consistency] failed\n');
    for (const mismatch of result.mismatches) {
      output.stderr.write(
        `${mismatch.label} version ${mismatch.version}; expected ${result.expected}\n`,
      );
    }
    return 1;
  } catch (error) {
    const detail = error instanceof Error ? error.message : String(error);
    output.stderr.write(`[version-consistency] failed: ${detail}\n`);
    return 1;
  }
}

if (require.main === module) {
  process.exitCode = main();
}

module.exports = {
  checkVersionConsistency,
  collectVersionEntries,
  main,
};
