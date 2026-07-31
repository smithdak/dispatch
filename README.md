# Dispatch

Dispatch is a local control plane for agentic work sessions. It creates an isolated Git
worktree, assigns it a durable session identity, records structured agent events in an
append-only JSONL ledger, and derives fast session views in SQLite.

This repository implements the Stage 0 command surface from [`arch.md`](arch.md):
create, list, log, merge, remove, reindex, and Claude Code hook ingestion. The complete
local lifecycle is executable and tested. The pinned Bun `1.3.14` source suite and
compiled lifecycle pass locally on native Windows x64, the primary v1 target. Remote
Windows CI and a live Claude Code invocation remain release gates.

Native Windows orchestration, copy-on-write dependency provisioning, review handoff, and
batch execution remain later stages with explicit gates; they are not represented as
finished.

## Requirements

- Windows x64 (primary v1 target) or Linux x64 (secondary target)
- Git on `PATH`
- Bun `1.3.14` for source development and release builds; legacy `1.3.6` is also locally
  qualified with a doctor warning. Other Bun versions fail `doctor` until qualified.

The compiled binary embeds Bun and does not require a separate Bun installation. Stage 1
has no selected native Windows orchestration backend yet; tmux is not a Windows
prerequisite and WSL is not treated as native Windows qualification.

## Verify and build

```sh
bun install --frozen-lockfile
bun run check
bun run build
bun run qualify:binary
```

`bun run check` runs strict TypeScript checking, the core import-boundary check, and all
unit, contract, and integration tests. `bun run build` compiles the host `dsp` binary
with bytecode. `bun run qualify:binary` drives that artifact through doctor, worktree
creation, hook ingestion, merge, and removal. The cross-build matrix is available
separately:

```sh
bun run build:matrix
```

That command targets Windows x64 plus Linux x64 and arm64 and may download target Bun
runtimes.

## First session

Run from a clean Git repository on a local branch with at least one commit:

```powershell
.\dist\dsp.exe doctor
.\dist\dsp.exe new auth-refactor
.\dist\dsp.exe ls
```

`dsp new` prints the session ID and worktree path. Work in that path, commit the result,
then merge through Dispatch while the primary repository is clean and still on the
recorded base branch:

```powershell
.\dist\dsp.exe log <sid>
.\dist\dsp.exe merge <sid>
.\dist\dsp.exe remove <sid>
```

`merge` rejects uncommitted session work, then records the committed session diffstat,
wall duration, observed turn count, and observed cost before closing the session.
`remove` refuses dirty worktrees unless `--force` is explicit; a forced dirty removal is
recorded as `git.discarded`, even if an earlier merge outcome exists.

## Claude Code hooks

Install structured hooks at Claude user scope:

```powershell
.\dist\dsp.exe hooks install claude
```

The default installer updates `%USERPROFILE%\.claude\settings.json` on Windows
idempotently and preserves existing settings. A compiled binary records its own absolute
executable path using Claude Code's shell-free exec form, so spaces are safe and `dsp`
does not need to be on `PATH`. Keep the installed executable at that path. User scope is
deliberate: future Dispatch worktrees inherit the hook without per-worktree setup. The
hook resolves cwd against Dispatch session metadata and returns without recording
anything outside a Dispatch-owned worktree.

To constrain installation to one existing project:

```powershell
.\dist\dsp.exe hooks install claude --project D:\github\repository
```

Explicit project scope writes `D:\github\repository\.claude\settings.local.json`. It is
project-local only and is **not inherited by future Dispatch worktrees**.

A compiled installation self-registers. When testing from source, pass an explicit
compiled executable path through `--command`; a Windows `.cmd` or `.bat` shim is not a
valid Claude exec-form target.

This answers how a Claude hook becomes durable query state:

```mermaid
flowchart LR
  C["Claude Code"] -->|hook JSON| T["Hook translator"]
  T -->|cwd and draft| R["Session resolver"]
  R -->|canonical event| L["JSONL ledger"]
  L -->|event projection| I["SQLite index"]
  L -->|replay stream| X["Reindex command"]
  X -->|rebuilt rows| I
  I -->|session views| Q["CLI queries"]
```

The translator records provider correlation fields under `ext.claude`. It does not store
prompt bodies, command bodies, tool responses, assistant messages, or transcript
contents. Unknown future payloads retain field names and value types only, never unknown
values.

## State and configuration

On Windows, authoritative state uses native application-data paths:

```text
%LOCALAPPDATA%\dispatch\
├── machine-id
├── index.sqlite                 derived and disposable
└── sessions/
    └── <sid>/
        ├── meta.json            immutable, ledger-rebuildable facts projection
        └── events.jsonl         authoritative append-only ledger
```

For isolated development and tests, `DISPATCH_HOME` overrides the Dispatch state
directory. `DISPATCH_WORKTREE_ROOT` and `DISPATCH_BRANCH_PREFIX` override their
configuration values.

Global configuration is `%APPDATA%\dispatch\config.toml` on Windows and
`$XDG_CONFIG_HOME/dispatch/config.toml` on Linux; a repository may override it with
`.dispatch.toml`:

```toml
[worktrees]
root = "D:\\worktrees\\dispatch"
branch_prefix = "dispatch/"

[ledger]
fsync = true
lock_timeout_ms = 2000
```

Configuration is strict: unknown keys fail instead of silently accepting typos.

## Repository map

This answers where each Stage 0 responsibility lives:

```text
src/
  core/
    identity/              sortable session and event IDs
    ledger/                canonical schema, locking, append, replay
    index/                 disposable SQLite projection
    worktree/              argv-safe Git lifecycle and diffstat
    config/                strict TOML overlay
    paths/                 native state paths and machine identity
  application/             lifecycle orchestration across core boundaries
  adapters/hooks/          provider translators and hook settings
  ports/                   provider-neutral agent contract
  cli/                     human command surface and lazy router
  hook/                    minimal provider-facing process entry
scripts/                   build, qualification, boundary, and reflink probe commands
test/
  unit/                    deterministic core and CLI tests
  contract/                fixture-backed provider adapter contract
  integration/             real Git worktree lifecycle
skills/dispatch-history/   agent-facing history query procedure
docs/decisions/            implementation ADRs
arch.md                    architecture specification v0.2
```

## Stage boundaries

- Stage 0 command surface: implemented and locally verified on the pinned runtime through
  the compiled binary on native Windows x64. Remote CI and live-provider qualification
  remain open.
- Stage 1: the native Windows orchestration backend is an open architecture decision; no
  mux implementation is represented as finished.
- Stage 2: only the filesystem probe harness exists; no provisioning engine ships before
  the O3 divergence-safety spike.
- Stage 3: merge outcomes and a basic history skill exist; review handoff and richer
  cross-session queries do not.
- Stages 4–5: batch execution and additional providers are not implemented.

The architecture’s strongest alternative is a ledger-only companion beside workmux. It
remains the required pivot if Stage 1 fails to displace workmux in two weeks of actual
use.

## Known release gates

- Git lifecycle effects and ledger receipts are not one atomic transaction. Worktree
  creation records durable intent before invoking Git; merge and remove are idempotently
  retryable after common post-effect failures. Automatic startup reconciliation is not
  implemented, so an interrupted operation may still require rerunning the same command.
  An origin-only create intent remains visible in `dsp ls` and can be terminally closed
  with `dsp remove <sid>`; resuming that same creation intent is not implemented.
- Provider hooks are recorded at least once. Provider correlation identifiers are
  retained for diagnosis, but cross-process semantic deduplication is not implemented.
- The `<5 ms` hook-append and `<50 ms` 500-session query targets in `arch.md` are
  unverified on supported targets.
- The CI workflow and three-target build matrix are configured, not evidence that those
  remote jobs or artifacts have run.
- A real Claude Code process must confirm that the user-scope hook resolves and appends
  in a generated worktree. The suite exercises the identical executable stdin path with
  fixture payloads, but not Claude itself.
