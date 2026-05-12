#!/usr/bin/env node
'use strict';

const { spawnSync } = require('node:child_process');
const fs = require('node:fs');
const path = require('node:path');

const repoRoot = path.resolve(__dirname, '..');

const forbiddenTrackedPrefixes = [
  '.omx/cache/',
  '.omx/context/',
  '.omx/logs/',
  '.omx/plans/',
  '.omx/state/',
  '.omx/tmp/',
];

const forbiddenTrackedFiles = new Set([
  '.omx/metrics.json',
  '.omx/notepad.md',
  '.omx/tmux-hook.json',
]);

const textRules = [
  {
    name: 'local operator home path',
    pattern: /\/home\/chjee\b/g,
    hint: 'Use a neutral placeholder such as /path/to/omx-bridge.',
  },
  {
    name: 'local systemd user',
    pattern: /^\s*User\s*=\s*chjee\b/gm,
    hint: 'Use a user service template or a placeholder user.',
  },
  {
    name: 'live-looking OpenClaw hook session key',
    pattern: /^OPENCLAW_HOOKS_SESSION_KEY\s*=\s*[^#\n]*telegram:direct:[0-9]{7,}\b/gm,
    hint: 'Use a placeholder such as agent:main:telegram:direct:<chat-id>.',
  },
];

function trackedFiles() {
  const result = spawnSync('git', ['ls-files', '-z'], {
    cwd: repoRoot,
    encoding: 'buffer',
  });
  if ((result.status ?? 1) !== 0 || !result.stdout) {
    const stderr = result.stderr?.toString('utf8').trim();
    const detail = stderr || result.error?.message || 'unknown git ls-files failure';
    throw new Error(`failed to list tracked files: ${detail}`);
  }
  return result.stdout
    .toString('utf8')
    .split('\0')
    .filter(Boolean)
    .sort();
}

function isLikelyBinary(buffer) {
  return buffer.includes(0);
}

function lineAndColumn(text, index) {
  let line = 1;
  let column = 1;
  for (let cursor = 0; cursor < index; cursor += 1) {
    if (text.charCodeAt(cursor) === 10) {
      line += 1;
      column = 1;
    } else {
      column += 1;
    }
  }
  return { line, column };
}

function collectTextFindings(file, text) {
  const findings = [];
  for (const rule of textRules) {
    rule.pattern.lastIndex = 0;
    let match;
    while ((match = rule.pattern.exec(text)) !== null) {
      const location = lineAndColumn(text, match.index);
      findings.push({
        file,
        line: location.line,
        column: location.column,
        name: rule.name,
        match: match[0],
        hint: rule.hint,
      });
    }
  }
  return findings;
}

function collectForbiddenTrackedOmx(files) {
  return files.filter((file) => {
    if (forbiddenTrackedFiles.has(file)) {
      return true;
    }
    return forbiddenTrackedPrefixes.some((prefix) => file.startsWith(prefix));
  });
}

function main() {
  const files = trackedFiles();
  const findings = [];
  const forbiddenOmx = collectForbiddenTrackedOmx(files);

  for (const file of forbiddenOmx) {
    findings.push({
      file,
      line: 1,
      column: 1,
      name: 'tracked local OMX artifact',
      match: file,
      hint: 'Keep OMX runtime/workflow artifacts local; promote durable decisions to docs/.',
    });
  }

  for (const file of files) {
    const fullPath = path.join(repoRoot, file);
    const buffer = fs.readFileSync(fullPath);
    if (isLikelyBinary(buffer)) {
      continue;
    }
    findings.push(...collectTextFindings(file, buffer.toString('utf8')));
  }

  if (findings.length === 0) {
    process.stdout.write('[public-hygiene] passed\n');
    return;
  }

  process.stderr.write('[public-hygiene] failed\n');
  for (const finding of findings) {
    process.stderr.write(
      `${finding.file}:${finding.line}:${finding.column} ${finding.name}: ${finding.match}\n`,
    );
    process.stderr.write(`  ${finding.hint}\n`);
  }
  process.exitCode = 1;
}

main();
