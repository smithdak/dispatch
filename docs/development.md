# Development

This guide covers the source checkout. It does not replace release qualification; exact
artifact and live-runtime claims require the separate evidence procedures.

## Set up the checkout

Source development requires Bun `1.3.14` and Git:

```sh
bun install --frozen-lockfile
bun run check
```

`bun run check` runs strict TypeScript checking, the core import-boundary check, and all
unit, contract, and integration tests.

## Build and qualify the host binary

```sh
bun run build
bun run qualify:binary
```

`build` compiles the host `dsp` executable with Bun bytecode. `qualify:binary` drives that
exact artifact through doctor, worktree creation, hook ingestion, merge, and removal.

Build all available compile targets separately:

```sh
bun run build:matrix
```

The matrix produces Windows x64, Linux x64, and Linux arm64 artifacts and may download
target Bun runtimes. Linux arm64 is a cross-build target, not a supported runtime target;
`doctor` currently rejects it.

## Benchmark Stage 0

Write local evidence outside the source tree unless you intend to curate and commit it:

```powershell
bun run benchmark:stage0 --output (Join-Path $env:TEMP "dispatch-stage0-evidence.json")
```

The benchmark measures fresh-process startup, provider-hook append, and a 500-session
query. It does not flush operating-system caches, and a sandboxed run is not equivalent
to an unsandboxed operator shell. See [Qualification evidence](qualification/README.md)
for the full method and retained baselines.

## Current repository map

This is the implemented tree, not the architecture's target-state scaffolding:

```text
src/
  core/
    identity/              sortable session and event IDs
    ledger/                canonical schema, locking, append, replay
    index/                 disposable SQLite projection
    worktree/              argv-safe Git lifecycle and diffstat
    config/                strict TOML overlay
    paths/                 native state paths and machine identity
  application/             lifecycle, prompt receipts, hooks, and doctor
  adapters/
    hooks/claude/           Claude payload translator and settings
    mux-windows/            protocol-pinned Herdr adapter
  ports/                   provider-neutral agent and mux contracts
  cli/                     human command surface and lazy router
  hook/                    minimal provider-facing process entry
scripts/                   build, checks, probes, benchmarks, qualification
test/
  unit/                    deterministic core, CLI, and orchestration tests
  contract/                fixture-backed provider process contracts
  integration/             real Git worktree lifecycle
skills/dispatch-history/   agent-facing history procedure
docs/decisions/            accepted architecture decisions
docs/qualification/        retained proof and reproduction methods
arch.md                    versioned architecture specification
```

Import direction is enforced: the core does not import adapters, and provider or terminal
integrations remain replaceable at the port boundary.

## Qualification profiles

The repository includes distinct scripts for:

- `bun run qualify:binary` — compiled Stage 0 lifecycle;
- `bun run qualify:windows-mux` — Windows Herdr lifecycle;
- `bun run qualify:windows-restart` — isolated cold-restart recovery; and
- `bun run qualify:windows-prompt` — isolated stdin/private-transport behavior.

The Windows profiles mutate disposable sessions and have stricter preconditions. Do not
infer a complete lifecycle, live-provider, or release-artifact pass from a narrower
profile. Follow [Qualification evidence](qualification/README.md) exactly.

## Before proposing a change

```sh
bun run check
bun run build
bun run qualify:binary
```

Then select only the additional platform or release profile whose claim the change
actually affects.
