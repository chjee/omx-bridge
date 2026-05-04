# Bridge Contract Source Of Truth

Status: design note

This note compares options for making the bridge job contract a first-class
source of truth across the NestJS bridge server, `omx-dispatch`, and the
OpenClaw plugin.

## Current State

The repository currently uses a shared representative fixture:

- `contracts/bridge-job.contract.json`
- `test/unit/bridge-contract.spec.ts`
- `omx-dispatch/contract-fixtures.test.ts`
- `omx-bridge-plugin/test/index.test.ts`

That fixture catches drift after implementation. The TypeScript declarations
are still duplicated in three runtime surfaces:

- `src/jobs/job.types.ts`
- `omx-dispatch/tool-handlers.ts`
- `omx-bridge-plugin/index.ts`

The duplication is intentional for now because the three projects have
different module targets and package boundaries:

- root bridge server: CommonJS NestJS build
- `omx-dispatch`: NodeNext ESM MCP server
- `omx-bridge-plugin`: NodeNext ESM OpenClaw plugin with TypeBox tool schemas

## Contract Scope

The first-class contract should cover fields that cross process or package
boundaries:

- job status values
- execution mode values
- execution error type values
- tmux session status values
- job source values
- `BridgeJob`
- `JobSessionSummary` / `BridgeJobSession`
- submit/callback/list status input shapes when those fields are shared

Internal-only server implementation details should stay local unless they are
serialized into bridge responses or accepted over the bridge API.

## Options

### Option 1: Keep JSON fixture as the only shared source

Keep `contracts/bridge-job.contract.json` as the compatibility guard and leave
the runtime TypeScript declarations duplicated.

Benefits:

- Lowest churn.
- No module-resolution or packaging change.
- Already covered by aggregate verification.

Costs:

- Drift is caught after the duplicated declaration changes, not prevented while
editing.
- New fields must still be added manually in three TypeScript surfaces.
- The fixture is representative, not a complete schema.

Use this when contract changes remain infrequent and small.

### Option 2: Add a repository-local shared TypeScript contract module

Create a small shared contract module that exports values and interfaces, then
import it from the root bridge, `omx-dispatch`, and `omx-bridge-plugin`.

Candidate shape:

- `contracts/bridge-job.contract.ts`
- export literal value arrays, derived union types, and shared interfaces
- keep `contracts/bridge-job.contract.json` as a runtime fixture generated from
  or validated against the TypeScript contract

Benefits:

- Runtime surfaces edit against one type definition.
- Literal arrays remain a direct source for validators, tests, and tool schemas.
- No external dependency is required.

Costs:

- Cross-project TypeScript imports must work for CommonJS root build and
  NodeNext ESM subprojects.
- Each `tsconfig.json` needs explicit include/path handling or a local package
  boundary.
- Build output and declaration paths need review so dispatch/plugin publishes
  only the files they need.

Use this when another bridge contract field is added and the duplicated
declaration edits become the main source of risk.

### Option 3: Introduce a local workspace package

Create a private package such as `@omx-bridge/contracts` and depend on it from
the root server, `omx-dispatch`, and `omx-bridge-plugin`.

Benefits:

- Cleanest long-term package boundary.
- Consumers can import from a stable package name.
- Makes future generated declarations or schemas easier to isolate.

Costs:

- Requires workspace/package-manager decisions the repo does not currently have.
- Adds install, build, and dependency graph churn.
- Increases release and local-development surface for a contract that is still
  small.

Use this only after a focused PRD accepts package-boundary churn.

## Recommendation

Do not introduce a package boundary yet.

The next implementation step should be Option 2, but only when there is a real
contract-changing PR or a dedicated refactor window. Start with a local
TypeScript contract module and keep the JSON fixture as the compatibility
artifact until all three surfaces prove they compile and test against the shared
module.

Recommended implementation gates:

1. Add the shared TypeScript contract module without changing serialized
   payload shape.
2. Move only enum-like value arrays first.
3. Run root, dispatch, and plugin typecheck/build/tests.
4. Move `BridgeJob` and `BridgeJobSession` interfaces only after value-array
   imports are stable across CommonJS and NodeNext builds.
5. Keep `contracts/bridge-job.contract.json` and the three fixture tests until
   a generated schema or fixture provides equal coverage.

## Non-Goals

- Do not add a new npm dependency for schema generation in the first pass.
- Do not convert the repository to a workspace only for this contract.
- Do not remove the JSON fixture before a replacement compatibility artifact is
  in place.
- Do not change bridge API payload shape as part of source-of-truth extraction.

## Verification For A Future Implementation

Required:

- `npm test -- --runInBand test/unit/bridge-contract.spec.ts`
- `npm --prefix omx-dispatch run typecheck`
- `npm --prefix omx-dispatch run build`
- `npm --prefix omx-dispatch test`
- `npm --prefix omx-bridge-plugin run typecheck`
- `npm --prefix omx-bridge-plugin run build`
- `npm --prefix omx-bridge-plugin test`
- `npm run verify`
- `git diff --check`

Run `npm run verify:runtime` if the implementation changes any serialized
payload shape, bridge endpoint behavior, dispatch/plugin runtime parsing, or
tmux session summary fields.
