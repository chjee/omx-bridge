# Changelog

## [Unreleased]

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
