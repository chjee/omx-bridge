'use strict';

// Run against the compiled sources in the current checkout (npm run build).
const { AsyncLocalStorage } = require('node:async_hooks');
const { promises: fs, readdirSync, readFileSync, unlinkSync } = require('node:fs');
const { createHash } = require('node:crypto');
const os = require('node:os');
const path = require('node:path');
const { performance } = require('node:perf_hooks');
const { execFileSync } = require('node:child_process');
const assert = require('node:assert/strict');
const { Logger } = require('@nestjs/common');
const fromBuild = name => require(path.resolve('dist/jobs', name));
const { JobRunnerService } = fromBuild('job-runner.service');
const { JobQueueRepository } = fromBuild('job-queue.repository');
const { JobsService } = fromBuild('jobs.service');

const samples = Number(process.env.BENCH_SAMPLES ?? 100);
assert(Number.isSafeInteger(samples) && samples > 0);
const task = { prompt: 'benchmark submission', source: 'dispatch' };
const execution = { command: 'benchmark-omx', timeoutMs: 60000, maxOutputChars: 32000 };
const uuidFile = /^[a-f\d]{8}(?:-[a-f\d]{4}){3}-[a-f\d]{12}\.json$/i;
Logger.overrideLogger(false);

function fixture(index, stamp) {
  return JSON.stringify({
    id: '00000000-0000-4000-a000-' + String(index).padStart(12, '0'),
    prompt: 'retained benchmark job', queueOrder: String(index).padStart(12, '0'),
    status: 'succeeded', createdAt: stamp, finishedAt: stamp, exitCode: 0,
    stdout: 'x'.repeat(1024), stderr: '', execution,
    notifyOutcome: { attemptedAt: stamp, mode: 'openclaw' },
  }, null, 2) + '\n';
}

function summarize(rows) {
  const sorted = rows.map(row => row.ms).sort((a, b) => a - b);
  return {
    p95Ms: sorted[Math.ceil(rows.length * 0.95) - 1],
    scans: rows.reduce((sum, row) => sum + row.scans, 0),
    reads: rows.reduce((sum, row) => sum + row.reads, 0),
    rows,
  };
}

async function measure(retained, phase) {
  const dir = await fs.mkdtemp(path.join(os.tmpdir(), 'bridge-poll-'));
  const config = {
    jobsDirectory: dir, tmuxSessionsDirectory: path.join(dir, 'sessions'),
    jobPollIntervalMs: 500, maxConcurrency: 2, maxActiveJobs: 50,
    maxTerminalJobs: 1000, jobRetentionDays: 7, jobCleanupIntervalMs: 3600000,
    jobTimeoutMs: execution.timeoutMs, maxOutputChars: execution.maxOutputChars,
    omxCommand: execution.command, sigkillGraceMs: 5000, allowedCwdPrefixes: [process.cwd()],
  };
  const repository = new JobQueueRepository(config);
  const notify = { notifyJobComplete: async () => {} };
  const rows = [];
  const tickContext = new AsyncLocalStorage();
  let submission;
  let onBackendStart;
  const backend = { execute: async () => {
    assert(submission, 'unexpected or duplicate execution');
    submission.ms = performance.now() - submission.start;
    rows.push({ ms: submission.ms, scans: submission.scans, reads: submission.reads,
      overlappingTimers: submission.overlappingTimers });
    submission = undefined;
    onBackendStart();
    return { status: 'succeeded', stdout: '', stderr: '', exitCode: 0, execution };
  } };
  const runner = new JobRunnerService(repository, backend, notify, config);
  const jobs = new JobsService(repository, runner, notify, config);
  const prefix = dir + path.sep;
  const readFile = fs.readFile;
  const listAll = repository.listAll.bind(repository);
  const counter = () => submission ?? tickContext.getStore();
  fs.readFile = function(file, ...args) {
    if (typeof file === 'string' && file.startsWith(prefix) && uuidFile.test(file.slice(prefix.length))) {
      const row = counter();
      if (row) row.reads++;
    }
    return readFile(file, ...args);
  };
  repository.listAll = (...args) => {
    const row = counter();
    if (row) row.scans++;
    return listAll(...args);
  };

  const active = new Set();
  let launches;
  for (const method of ['runOnce', 'reconcileTerminalNotifications']) {
    const original = runner[method].bind(runner);
    runner[method] = (...args) => {
      const work = original(...args);
      if (method === 'runOnce') launches?.push(work);
      active.add(work);
      work.then(() => active.delete(work), () => active.delete(work));
      return work;
    };
  }
  const drain = async () => { while (active.size) await Promise.all([...active]); };
  let sampleIdle = false;
  let idleStarted = 0;
  let nextIdleTick;
  const idleDone = Promise.withResolvers();
  const tick = runner.tick.bind(runner);
  runner.tick = () => {
    if (submission && tickContext.getStore() !== submission) submission.overlappingTimers++;
    if (nextIdleTick) {
      const aligned = nextIdleTick;
      nextIdleTick = undefined;
      const work = [];
      launches = work;
      try {
        tick();
      } finally {
        launches = undefined;
      }
      Promise.all(work).then(aligned.resolve, aligned.reject);
      return;
    }
    if (!sampleIdle || idleStarted >= samples) return tick();
    idleStarted++;
    const row = { ms: 0, scans: 0, reads: 0 };
    const work = [];
    launches = work;
    const start = performance.now();
    try {
      tickContext.run(row, tick);
    } finally {
      launches = undefined;
    }
    assert(work.length > 0, 'tick did not expose its asynchronous passes');
    Promise.all(work).then(() => {
      row.ms = performance.now() - start;
      rows.push(row);
      if (rows.length === samples) idleDone.resolve();
    }, idleDone.reject);
  };

  try {
    const stamp = new Date().toISOString();
    await Promise.all(Array.from({ length: retained }, (_, i) =>
      fs.writeFile(path.join(dir, '00000000-0000-4000-a000-' + String(i).padStart(12, '0') + '.json'),
        fixture(i, stamp), { mode: 0o600 })));
    await runner.onModuleInit();
    await drain(); // Includes the immediate startup tick and asynchronous notification reconciliation.
    assert.equal((await listAll()).length, retained);
    if (phase === 'idle') {
      sampleIdle = true;
      await idleDone.promise;
      sampleIdle = false;
    } else {
      for (let i = 0; i < samples; i++) {
        await drain();
        // Start at the same phase of the real timer. Keep the timer live if the submission is slow.
        nextIdleTick = Promise.withResolvers();
        await nextIdleTick.promise;
        assert.equal(readdirSync(dir).filter(name => uuidFile.test(name)).length, retained);
        const started = Promise.withResolvers();
        onBackendStart = started.resolve;
        const timeout = setTimeout(() => started.reject(new Error('backend did not start')), 30000);
        let saved;
        try {
          submission = { start: performance.now(), scans: 0, reads: 0, overlappingTimers: 0 };
          [saved] = await Promise.all([tickContext.run(submission, () => jobs.createJob(task)), started.promise]);
        } finally {
          clearTimeout(timeout);
        }
        await drain(); // Execution, terminal transition and all immediate follow-up ticks.
        // Synchronous reset in this untimed turn prevents a new scheduled scan racing the unlink.
        const file = path.join(dir, saved.id + '.json');
        assert.equal(JSON.parse(readFileSync(file, 'utf8')).status, 'succeeded');
        unlinkSync(file);
      }
    }
    assert.equal(rows.length, samples);
    return summarize(rows);
  } finally {
    await runner.onModuleDestroy();
    fs.readFile = readFile;
    await fs.rm(dir, { recursive: true, force: true });
  }
}

async function main() {
  const output = {
    commit: execFileSync('git', ['rev-parse', 'HEAD'], { encoding: 'utf8' }).trim(),
    harnessSha256: createHash('sha256').update(readFileSync(__filename)).digest('hex'),
    runnerSha256: createHash('sha256').update(readFileSync(path.resolve('dist/jobs/job-runner.service.js'))).digest('hex'),
    node: process.version, kernel: os.release(), cpu: os.cpus()[0].model,
    tmpdir: os.tmpdir(), fsType: (await fs.statfs(os.tmpdir())).type.toString(16),
    fixtureJobBytes: Buffer.byteLength(fixture(0, new Date().toISOString())),
    samples, jobPollIntervalMs: 500, maxConcurrency: 2, conditions: {},
  };
  for (const retained of [0, 1000]) {
    output.conditions[retained] = {};
    for (const phase of ['idle', 'submit']) {
      console.error(`Measuring ${phase}, ${retained} retained files`);
      output.conditions[retained][phase] = await measure(retained, phase);
    }
  }
  console.log(JSON.stringify(output, null, 2));
}

main().catch(error => { console.error(error); process.exitCode = 1; });
