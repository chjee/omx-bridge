# Changelog

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
