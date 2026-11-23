# omx-bridge v0.1.4 release candidate

## Highlights

- **Runner recovery.** A transient storage failure during scheduled polling or
  cleanup is logged and the runner can retry at the next interval. If the
  prelaunch lookup fails after a claim, the runner conditionally returns the
  job to the queue. A concurrent cancellation or completion keeps its result.
- **HTTP deadlines.** Dispatch and the OpenClaw plugin use one deadline from
  request start through the response body read. A stalled body now times out
  even if headers arrived promptly. A local deadline retains the existing
  timeout message. An independent abort before that deadline reaches the caller
  as the original error, during both header and body reads.
- **Submission cost.** A new `requestId` requires one full job-store scan,
  down from two. The bridge checks the source-scoped ID and payload before
  enforcing queue capacity, so a valid replay can still succeed at capacity.
- **Notification history.** Attempt indexes continue increasing when the
  ten-entry window fills. If it contains `Number.MAX_SAFE_INTEGER`, the bridge
  assigns the smallest nonnegative integer absent from the window. Read
  `notifyHistory` in array order and use `notifyOutcome` for the latest result.

## Existing behavior covered by a new regression test

The loopback smoke exercises an accepted Dispatch submission whose response
body stalls. After the client times out and closes the socket, replaying the
same source, request ID, and payload returns the original job ID. The test
independently counts one stored job, one execution, and one completion webhook.
This guarantee applies while the original job is retained.

## Upgrade and distribution

Existing configuration and job files can be used as-is. Applications that
infer notification order from the largest index should use the history order.
Node.js `>=22.19.0` remains the supported range, with Node 22 and 24 in CI.
The three packages remain private and MIT-licensed. The GitHub distribution
uses source archives.

The candidate covers the changes from `v0.1.3` through `e2741a2`. Candidate
verification uses the [release checklist](release-verification.md). Live OMX
execution and external notification delivery are separate operator checks.
