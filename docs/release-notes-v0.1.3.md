# omx-bridge v0.1.3

## Highlights

- Keeps root, dispatch, plugin, lockfile, and OpenClaw manifest versions aligned
  and derives the dispatch MCP identity from package metadata.
- Fails fast on explicit invalid operational configuration while preserving the
  documented defaults for missing or empty optional settings.
- Reduces claim-time full job scans from two to one and coalesces three
  overlapping tmux reconciliation requests into one collection for the same job.
- Prevents shutdown from admitting new claims or starting new direct-exec/tmux
  work, and keeps instance-lock ownership through captured reconciliation,
  cleanup, direct-exec settlement, and bounded late-notification flushing.
- Reduces the default nominal shutdown timer budget from about 28 seconds to
  about 14 seconds by starting settlement observers together without changing
  the underlying work ordering.
- Prevents a direct-exec request aborted during delayed CWD resolution from
  spawning a child or sending its prompt after shutdown begins.

## Upgrade notes

- Existing deployments with a non-empty typo or invalid value in an operational
  environment variable can now fail startup. The error identifies one offending
  variable at a time; missing and empty optional values keep their documented
  defaults.
- Compiled `omx-dispatch` deployments must include the package metadata expected
  beside the `dist` or `dist-test` layout so the MCP server can resolve its
  version.
- Keep execution CWDs and allowed prefixes on responsive local filesystems, or
  configure network/FUSE request timeouts well below the supervisor stop timeout.
  On WSL, prefer a Linux-filesystem worktree under `/home/<user>` over `/mnt/c`.

## Compatibility

- No breaking public API, job payload, repository format, systemd, or runtime
  dependency changes are included.
- Node.js `>=22.19.0` remains the admitted runtime range; deterministic and
  fake-runtime verification cover Node 22 and Node 24.
- Root, dispatch, and plugin packages remain private and unpublished to npm.
- This preparation does not create a tag, GitHub Release, npm publication, or
  binary/bundled dependency asset.

## Change provenance

| Area | Pull request | Merge commit |
| --- | --- | --- |
| Version contract | [#18](https://github.com/chjee/omx-bridge/pull/18) | `644166ab09c4b484bb65af42365529c6411bc579` |
| Strict runtime configuration | [#19](https://github.com/chjee/omx-bridge/pull/19) | `ad5bdb132ad6f5178e5fbbdba2c21fe578baf30b` |
| Queue scan and tmux reconciliation | [#20](https://github.com/chjee/omx-bridge/pull/20) | `9628050fdaee1df1776d601b0599b92a67bd0a80` |
| Shutdown reconciliation ownership | [#21](https://github.com/chjee/omx-bridge/pull/21) | `4bec0437593c223cfc557cdbbea8ffaae28939c5` |
| Shutdown budget headroom | [#22](https://github.com/chjee/omx-bridge/pull/22) | `be034ca658756310b6ff5d31747273efb4a08ddd` |
| Timed-out in-flight ownership | [#23](https://github.com/chjee/omx-bridge/pull/23) | `674c9944dc283ea5d10eac5771513a04841bc5be` |
| Delayed-CWD pre-spawn abort gate | [#24](https://github.com/chjee/omx-bridge/pull/24) | `6816516c2170a47bfe7010b26acbb2236c7bbe73` |
| CWD filesystem timing documentation | [#25](https://github.com/chjee/omx-bridge/pull/25) | `84c37fc6f0603ac2d76607bf1cd49ffa113aafa0` |

## Verification

The unpushed release candidate passed locally with Node.js v24.14.1 and npm
11.19.0:

- version consistency at `0.1.3` and the public-hygiene check;
- 384 root tests, 59 dispatch tests, five plugin tests, and all builds/typechecks;
- loopback runtime, direct-exec containment, tmux, dispatch MCP, OpenClaw plugin,
  and fake live-OMX smoke checks.

The candidate branch is intentionally not pushed by this preparation task, so a
hosted Node 22/24 workflow run for the final candidate remains a later merge or
release gate rather than evidence claimed here.

Live model-provider execution and real external Telegram/OpenClaw delivery remain
operator-only verification and are not part of this deterministic release gate.

## Known limitations

- A dist-only dispatch deployment still requires the matching package metadata.
- Strict configuration validation reports one invalid environment value at a
  time.
- The approximately 14-second shutdown budget is a nominal timer budget; event
  loop delay, filesystem I/O, and Nest disposal are outside that formula.
- A permanently pending captured filesystem request relies on the provided
  systemd termination boundary for production process convergence.
- CWD `realpath` resolution is not bounded by `BRIDGE_JOB_TIMEOUT_MS`.
- Live OMX and real Telegram/OpenClaw delivery are not exercised by the release
  candidate gate.
