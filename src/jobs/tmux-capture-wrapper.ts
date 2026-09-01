export const TMUX_CAPTURE_WRAPPER_FILE = 'capture-wrapper.js';
export const TMUX_CAPTURE_METADATA_FILE = 'capture.json';
export const TMUX_CAPTURE_STDOUT_TAIL_FILE = 'stdout.tail';
export const TMUX_CAPTURE_STDERR_TAIL_FILE = 'stderr.tail';

/**
 * A session-local Node script. Keeping the helper inside the tmux pane means it
 * shares the pane lifecycle with OMX while keeping capture state bounded even
 * when the bridge itself restarts.
 */
export function buildTmuxCaptureWrapperScript(): string {
  return String.raw`#!/usr/bin/env node
'use strict';

const fs = require('node:fs');
const { spawn } = require('node:child_process');
const { constants } = require('node:os');

function fail(message) {
  process.stderr.write('tmux capture wrapper: ' + message + '\n');
  process.exit(64);
}

const args = process.argv.slice(2);
const separator = args.indexOf('--');
if (separator < 0) fail('missing command separator');

const options = {};
for (let index = 0; index < separator; index += 2) {
  const key = args[index];
  const value = args[index + 1];
  if (!key || value === undefined || !key.startsWith('--')) fail('invalid option');
  options[key.slice(2)] = value;
}

const command = args[separator + 1];
const commandArgs = args.slice(separator + 2);
const cap = Number.parseInt(options.cap || '', 10);
const sigkillGraceMs = Number.parseInt(options['sigkill-grace-ms'] || '', 10);
if (!command || !Number.isFinite(cap) || cap <= 0 || !Number.isFinite(sigkillGraceMs) || sigkillGraceMs <= 0 || !options.stdout || !options.stderr || !options['stdout-tail'] || !options['stderr-tail'] || !options.metadata || !options['exit-code']) {
  fail('missing capture options');
}

const marker = Buffer.from('\n...[live output truncated]...\n', 'utf8');
if (marker.length >= cap) fail('capture cap is smaller than truncation marker');

function writeFully(fd, data) {
  let offset = 0;
  while (offset < data.length) {
    offset += fs.writeSync(fd, data, offset, data.length - offset);
  }
}

function writeFullyAt(fd, data, position) {
  let offset = 0;
  while (offset < data.length) {
    offset += fs.writeSync(fd, data, offset, data.length - offset, position + offset);
  }
}

class StreamCapture {
  constructor(filePath, tailPath) {
    this.filePath = filePath;
    this.tailPath = tailPath;
    this.fd = fs.openSync(filePath, 'w+', 0o600);
    this.tailFd = fs.openSync(tailPath, 'w+', 0o600);
    const budget = cap - marker.length;
    this.headCap = Math.ceil(budget / 2);
    this.tailCap = Math.floor(budget / 2);
    this.tail = Buffer.alloc(this.tailCap);
    this.tailLength = 0;
    this.tailStart = 0;
    this.stored = 0;
    this.bytesSeen = 0;
    this.truncated = false;
    this.closed = false;
    this.finalized = false;
  }

  append(chunk) {
    const buffer = Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk);
    this.bytesSeen += buffer.length;
    if (!this.truncated) {
      const remaining = cap - this.stored;
      const direct = Math.min(Math.max(remaining, 0), buffer.length);
      if (direct > 0) {
        writeFully(this.fd, buffer.subarray(0, direct));
        this.stored += direct;
      }
      if (direct === buffer.length) return;
      this.beginTruncation();
      this.appendTail(buffer.subarray(direct));
      return;
    }
    this.appendTail(buffer);
  }

  beginTruncation() {
    if (this.truncated) return;
    const tailBytes = Math.min(this.tailCap, this.stored);
    let originalTail = Buffer.alloc(0);
    if (tailBytes > 0) {
      originalTail = Buffer.alloc(tailBytes);
      fs.readSync(this.fd, originalTail, 0, tailBytes, this.stored - tailBytes);
    }
    fs.ftruncateSync(this.fd, this.headCap);
    this.stored = this.headCap;
    this.truncated = true;
    if (originalTail.length > 0) this.setTail(originalTail);
  }

  materialize() {
    fs.ftruncateSync(this.fd, this.headCap);
    writeFullyAt(this.fd, marker, this.headCap);
    writeFullyAt(this.fd, this.tailBuffer(), this.headCap + marker.length);
    fs.ftruncateSync(this.fd, this.headCap + marker.length + this.tailLength);
    this.stored = this.headCap + marker.length + this.tailLength;
  }

  appendTail(buffer) {
    if (this.tailCap === 0 || buffer.length === 0) return;
    if (buffer.length >= this.tailCap) {
      buffer.copy(this.tail, 0, buffer.length - this.tailCap);
      writeFullyAt(this.tailFd, this.tail, 0);
      fs.ftruncateSync(this.tailFd, this.tailCap);
      this.tailLength = this.tailCap;
      this.tailStart = 0;
      return;
    }
    let offset = 0;
    while (offset < buffer.length) {
      const writeAt = (this.tailStart + this.tailLength) % this.tailCap;
      const free = this.tailCap - this.tailLength;
      const amount = Math.min(buffer.length - offset, this.tailCap - writeAt, free || this.tailCap);
      buffer.copy(this.tail, writeAt, offset, offset + amount);
      writeFullyAt(this.tailFd, buffer.subarray(offset, offset + amount), writeAt);
      offset += amount;
      if (this.tailLength < this.tailCap) {
        this.tailLength += amount;
      } else {
        this.tailStart = (this.tailStart + amount) % this.tailCap;
      }
    }
  }

  setTail(buffer) {
    this.tail.fill(0);
    const retained = buffer.subarray(Math.max(0, buffer.length - this.tailCap));
    retained.copy(this.tail, 0);
    fs.ftruncateSync(this.tailFd, 0);
    writeFullyAt(this.tailFd, retained, 0);
    this.tailLength = retained.length;
    this.tailStart = 0;
  }

  tailBuffer() {
    if (this.tailLength === 0) return Buffer.alloc(0);
    if (this.tailStart === 0) return this.tail.subarray(0, this.tailLength);
    return Buffer.concat([
      this.tail.subarray(this.tailStart, this.tailStart + this.tailLength),
      this.tail.subarray(0, Math.max(0, this.tailStart + this.tailLength - this.tailCap)),
    ]);
  }

  finish() {
    if (this.closed) return;
    fs.closeSync(this.tailFd);
    fs.unlinkSync(this.tailPath);
    if (this.truncated) this.materialize();
    this.finalized = true;
    fs.closeSync(this.fd);
    this.closed = true;
  }

  metadata() {
    return {
      bytesSeen: this.bytesSeen,
      truncated: this.truncated,
      tailStart: this.tailStart,
      tailLength: this.tailLength,
      finalized: this.finalized,
    };
  }
}

const stdout = new StreamCapture(options.stdout, options['stdout-tail']);
const stderr = new StreamCapture(options.stderr, options['stderr-tail']);
let captureFailure = null;
let child;
let captureFailureTimer;
let captureFailureExitTimer;
let terminatingForCaptureFailure = false;

function signalCaptureProcessTree(signal) {
  // The wrapper replaces the pane shell with exec, so it is normally the pane
  // process-group leader. This keeps a capture failure contained in the same
  // tmux lifecycle. The direct-child fallback also keeps local test runners
  // (which do not create a separate process group) safe.
  try {
    process.kill(-process.pid, signal);
    return;
  } catch {}
  try {
    child.kill(signal);
  } catch {}
}

process.on('SIGTERM', () => {
  if (!terminatingForCaptureFailure) process.exit(143);
});

function terminateForCaptureFailure(error) {
  if (captureFailure) return;
  captureFailure = String(error && error.message ? error.message : error);
  terminatingForCaptureFailure = true;
  try { writeMetadata(null); } catch {}
  signalCaptureProcessTree('SIGTERM');
  captureFailureTimer = setTimeout(() => signalCaptureProcessTree('SIGKILL'), sigkillGraceMs);
  captureFailureTimer.unref();
  captureFailureExitTimer = setTimeout(() => process.exit(1), sigkillGraceMs + 100);
  captureFailureExitTimer.unref();
}

function writeMetadata(exitCode) {
  const metadata = {
    version: 1,
    stdout: stdout.metadata(),
    stderr: stderr.metadata(),
    captureFailure,
    exitCode,
  };
  fs.writeFileSync(options.metadata, JSON.stringify(metadata) + '\n', { encoding: 'utf8', mode: 0o600 });
}

try {
  child = spawn(command, commandArgs, { stdio: ['inherit', 'pipe', 'pipe'], detached: false });
  child.stdout.on('data', (chunk) => {
    try { stdout.append(chunk); writeMetadata(null); } catch (error) { terminateForCaptureFailure(error); }
  });
  child.stderr.on('data', (chunk) => {
    try { stderr.append(chunk); writeMetadata(null); } catch (error) { terminateForCaptureFailure(error); }
  });
  child.once('error', (error) => terminateForCaptureFailure(error));
  child.once('close', (code, signal) => {
    if (captureFailureTimer) clearTimeout(captureFailureTimer);
    if (captureFailureExitTimer) clearTimeout(captureFailureExitTimer);
    try {
      stdout.finish();
      stderr.finish();
      const exitCode = captureFailure
        ? 1
        : typeof code === 'number'
          ? code
          : signal && constants.signals[signal]
            ? 128 + constants.signals[signal]
            : 1;
      writeMetadata(exitCode);
      fs.writeFileSync(options['exit-code'], String(exitCode) + '\n', { encoding: 'utf8', mode: 0o600 });
      process.exit(exitCode);
    } catch (error) {
      process.stderr.write('tmux capture wrapper finalize failure: ' + String(error && error.message ? error.message : error) + '\n');
      process.exit(1);
    }
  });
} catch (error) {
  process.stderr.write('tmux capture wrapper startup failure: ' + String(error && error.message ? error.message : error) + '\n');
  process.exit(1);
}
`;
}
