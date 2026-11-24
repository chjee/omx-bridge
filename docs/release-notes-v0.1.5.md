# omx-bridge v0.1.5 release candidate

This candidate covers the changes since the published v0.1.4 source tree
(`a43a266`). The five runtime improvements were integrated on `develop` at
`00a269c`. [Previous release](https://github.com/chjee/omx-bridge/releases/tag/v0.1.4)

## Changes for users

- **Recover interrupted tmux starts.** The bridge records the session name
  before launch. If cancellation, a completion callback or a storage error
  interrupts the handoff, the runner can reclaim an unlinked session after a
  restart. An already attached session stays live. Recovery preserves an
  existing terminal result and its recorded notification. [PR #30](https://github.com/chjee/omx-bridge/pull/30)
- **Keep available slots working.** A tmux result collection error leaves
  that job running for the next poll. Startup can finish and other jobs can
  use free slots while the affected job keeps its slot. [PR #31](https://github.com/chjee/omx-bridge/pull/31)
- **Confirm timeout termination.** The runner records a timeout after a
  successful kill or confirmed session absence. If termination is uncertain,
  it holds the slot and defers the notification. Each retry reads the exit
  code first, so a newly recorded successful result can complete the job.
  [PR #32](https://github.com/chjee/omx-bridge/pull/32)
- **Read stored Dispatch notifications first.** Both wait tools can return a
  stored result with zero polling GETs and leave other jobs' notifications
  available. Submit-and-wait still sends its submission POST. A miss uses
  one GET in the first polling cycle. [PR #33](https://github.com/chjee/omx-bridge/pull/33)
- **Reduce idle file reads.** With concurrency 2, a 500 ms poll interval and
  1,000 retained 1,508-byte job files, full scans per idle tick fell from 3 to
  1, job JSON reads from 3,000 to 1,000, and idle p95 from 309.89 to
  117.65 ms. These are 100-sample measurements on Node v24.14.1 and WSL2/ext4.
  The 25 ms threshold triggered the optimization. Reading the retained jobs
  once per idle tick still costs time. [Measurements and merge criteria](benchmarks/runner-poll.md)

The release range also includes refreshed repository agent instructions,
deterministic regression tests, loopback smoke coverage and the reproducible
polling benchmark.

## Upgrade and rollback

Keep the existing service configuration, job and session directories, and
Dispatch notification store. The HTTP API, job JSON fields, session summary,
plugin configuration and systemd unit have the same contracts as v0.1.4.
The candidate reads ordinary v0.1.4 files and adds a private, per-job
`cleanup-pending.json` to track an outstanding tmux start. Source comparison
and legacy-artifact tests support forward compatibility. Restart tests cover
recovery with the candidate. A cross-version test booting the v0.1.4 binary
on a candidate-created state directory is still unverified.

**Before downgrading**, pause new submissions and leave the candidate running
to finish pending starts and recovery. Once the queue and launches are drained,
use the following read-only check. Run Bash as the service account, in the
service's actual working directory with its effective environment, including
any unit overrides. The command uses the installed bridge configuration to
read the same `.env` and resolve relative paths or the default directory.

```bash
(
  set -eu
  sessions=$(node -e '
    const { ConfigModule, ConfigService } = require("@nestjs/config");
    const { buildBridgeConfig } = require("./dist/config/bridge-config");
    ConfigModule.forRoot({ isGlobal: true }).then(() => {
      const config = buildBridgeConfig(new ConfigService());
      if (!config.tmuxSessionsDirectory) throw new Error("Empty BRIDGE_TMUX_SESSIONS_DIR");
      process.stdout.write(require("node:path").resolve(config.tmuxSessionsDirectory));
    }).catch(err => { console.error(err.message); process.exitCode = 1; });
  ')
  printf 'Session directory: %s\n' "$sessions"
  test -d "$sessions" && test ! -L "$sessions" || exit 1
  link=$(find "$sessions" -type l -print -quit)
  if test -n "$link"; then printf 'Inspect unexpected symlink: %s\n' "$link" >&2; exit 1; fi
  markers=$(find "$sessions" -name cleanup-pending.json -printf x)
  printf 'Pending tmux markers: %d\n' "${#markers}"
  test -z "$markers"
)
```

Proceed only after the directory matches the deployment, the check succeeds
with a count of zero, and session ownership and liveness are clear. Keep
submissions paused through the version switch. If a marker remains, the
directory cannot be inspected, or a session is uncertain, preserve both state
directories and defer the downgrade. Let the candidate retry recovery or
restore it against those same directories. Deleting a marker by hand discards
the recovery handle.

In v0.1.4, encountering a marker can still allow startup. Its recovery scans
running job records and cannot use the marker to terminate a live unlinked
session. It may mark an unlinked running job failed, and artifact cleanup can
reject a directory containing the unknown file. This downgrade assessment
comes from the [v0.1.4 startup path](https://github.com/chjee/omx-bridge/blob/v0.1.4/src/jobs/job-runner.service.ts#L120)
and [v0.1.4 artifact checks](https://github.com/chjee/omx-bridge/blob/v0.1.4/src/jobs/tmux-session-runner.service.ts#L327).

## Distribution and verification

Distribution is MIT-licensed source through GitHub's automatic archives.
The root, Dispatch and OpenClaw packages remain private. The non-root
package records in all three lockfiles match the dependency-reviewed
`78a31c5` tree and v0.1.4, including versions, resolved URLs, integrity
values and license metadata. Two runtime entries omit a license field:
`busboy@1.6.0` and `streamsearch@1.1.0`. Both installed versions carry MIT
terms in their own `LICENSE` files. The `sqlite-vec@0.1.9` family declares
`MIT OR Apache`; its upstream tag includes the [MIT](https://github.com/asg017/sqlite-vec/blob/v0.1.9/LICENSE-MIT)
and [Apache 2.0](https://github.com/asg017/sqlite-vec/blob/v0.1.9/LICENSE-APACHE) texts.
No runtime license remains unidentified for this source-only distribution.
Bundling dependencies would require a new license and notice review.
[Distribution policy](../README.md#license-and-distribution) · [Historical compatibility review](https://github.com/chjee/omx-bridge/pull/14)

Hosted CI passed the runtime base `00a269c` on Node 22 and 24. The release
checklist calls for hosted deterministic and fake-runtime jobs for the final
candidate revision and a separate live OMX operator smoke before manual
publication. The live smoke uses a local webhook and model credentials.
[Base CI](https://github.com/chjee/omx-bridge/actions/runs/45409270964)
· [Release verification checklist](release-verification.md)
