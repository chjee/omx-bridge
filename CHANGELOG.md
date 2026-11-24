# Changelog

## [Unreleased]

## [0.1.5] - Release candidate

- Recover unlinked tmux starts across restarts and preserve a winning cancel
  or completion callback. A failed collection can retry while other jobs use
  free slots, including during startup recovery.
- Hold a timed-out job's slot until tmux termination succeeds or the session is
  confirmed absent. A normal result recorded before the retry can still win.
- Serve a stored Dispatch completion without a bridge GET. A notification miss
  now needs one GET on the first poll.
- With 1,000 retained jobs, concurrency 2 and 500 ms polling, idle scans fell
  from 3 to 1 per tick and idle p95 from 309.89 to 117.65 ms. The 25 ms budget
  was the threshold for starting the optimization.
- Before downgrading to v0.1.4, drain pending tmux starts on the new version.
  See the [release notes and rollback check](docs/release-notes-v0.1.5.md).

## [0.1.4] - 2026-11-23

### Fixed

- Log scheduled poll and cleanup failures so the next interval can retry. If a
  claimed job cannot be read before launch, requeue it while it is still
  running and preserve concurrent cancellation or completion.
- Apply the Dispatch and OpenClaw HTTP request deadline through the response
  body read. Preserve upstream abort errors when the local deadline has not expired.
- Keep notification attempt indexes distinct in the ten retained entries
  after the history fills and at the JavaScript safe integer limit.

### Performance

- Read the job store once instead of twice when admitting a new `requestId`.
  Duplicate and conflicting submissions are still resolved before queue capacity.

### Regression coverage

- Exercise existing submission idempotency over loopback HTTP. When the bridge
  accepts a job but the client times out reading the response, an identical
  replay returns the stored ID with one execution and one completion webhook.

## [0.1.3] - 2026-09-29

No breaking API, job payload, repository format, runtime dependency, or systemd
contract changes are included in this release.

### Fixed

- Derive the dispatch MCP server version from package metadata and verify that
  root, dispatch, plugin, lockfile, and OpenClaw manifest versions stay aligned.
- Reject explicit invalid non-empty bridge and dispatch operational settings at
  startup while preserving documented defaults for missing or empty values.
- Prevent shutdown from admitting new claims or starting direct-exec/tmux work
  after reconciliation, including claim and execution-lookup races.
- Retain instance-lock ownership until captured reconciliation, cleanup, and
  timed-out direct-exec runs settle and late completion notifications receive
  their bounded flush opportunity.
- Prevent an abort received during delayed CWD resolution from spawning a child
  or writing the prompt to its stdin after shutdown begins.

### Performance

- Reduce full job scans during a claim from two `listAll()` calls to one.
- Coalesce three overlapping tmux reconciliation requests into one `collect()`
  call for the same job.
- Start captured shutdown-work observers together, reducing the default nominal
  timer budget from about 28 seconds to about 14 seconds without changing the
  underlying work or lock-release ordering.

### Documentation

- Document responsive-filesystem expectations for canonical CWD validation,
  systemd containment, WSL 9p/DrvFS guidance, and the fact that CWD `realpath`
  is outside `BRIDGE_JOB_TIMEOUT_MS`.

### Upgrade notes

- Deployments that currently rely on a non-empty typo or otherwise invalid
  operational environment value will now fail startup and name the offending
  variable; missing or empty optional values retain their documented defaults.
- A dispatch deployment must keep its package metadata alongside compiled
  `dist` or `dist-test` output so the MCP server can report its package version.

## [0.1.2] - 2026-09-02

- Bound running tmux stdout and stderr artifacts per stream while preserving
  head/tail diagnostics, terminal semantics, private artifact handling, and
  existing `outputTruncated` behavior.
- Moved GitHub-hosted verification actions to supported Node 24 runtimes
  while preserving the project Node 22/24 matrix and dependent fake-runtime
  ordering.

## [0.1.1] - 2026-08-31

- Establish the MIT license and public source-distribution contract.
- Align the private root, dispatch, and plugin package metadata on version
  `0.1.1` and license `MIT` without changing runtime behavior or publishing to
  npm.

## [0.1.0] - 2026-08-28

- Record the validated operational-reliability tree as an immutable,
  tag-only provenance milestone created before the license and publication
  policy was established.
- No GitHub Release or npm package was published for this version.
