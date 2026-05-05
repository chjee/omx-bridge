# Documentation Map

This directory contains maintainer-facing guidance for `omx-bridge`. Keep this
index navigational; detailed procedures belong in the linked documents.

## Start Here

| Question | Read |
| --- | --- |
| How should bridge maintenance work proceed? | [`agent-workflow.md`](agent-workflow.md) |
| Which verification lane applies before merge or release? | [`release-verification.md`](release-verification.md) |
| How do I run deployed or loopback runtime smoke checks? | [`runtime-smoke.md`](runtime-smoke.md) |
| Who owns completion routing and callback delivery? | [`routing-contract.md`](routing-contract.md) |
| Where is the bridge job contract tracked across server, dispatch, and plugin surfaces? | [`contract-source-of-truth.md`](contract-source-of-truth.md) |

## Documentation Rules

- Keep docs bridge-specific and decision-oriented.
- Link only files that exist in this repository.
- Put long explanations in dedicated docs instead of expanding `AGENTS.md`.
