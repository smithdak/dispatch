# ADR 0002 — Native Windows is the primary target

- Status: accepted
- Date: 2026-07-31
- Scope: target platform, executable hook installation, and Stage 1 sequencing

## Context

The architecture originally deferred Windows and made tmux the Stage 1 dogfood gate. The
actual daily-driver environment is a native Windows checkout, native Git, native Claude
Code, and PowerShell. WSL would qualify a separate Linux execution world and would not
prove native path, process, SQLite, or hook behavior.

Stage 0 already has substantial native evidence: the full source suite and a compiled
`dsp.exe` lifecycle complete on Windows. The remaining blockers were self-imposed target
rejection, absent Windows CI/build artifacts, a bare `dsp` hook command with no
installation contract, and projection failures that could prevent authoritative hook
capture.

## Decision

Windows x64 is the primary v1 target. Linux x64 remains a secondary CI target. macOS is
deferred until its physical-path alias failure is fixed and requalified.

Release builds remain pinned to Bun `1.3.14`, which has passed the Windows source suite
and compiled lifecycle. Legacy Bun `1.3.6` has separately passed local Windows
qualification and produces a `dsp doctor` warning. Every other runtime version fails
`doctor` until it is explicitly qualified; version-range compatibility is not inferred
from those two data points.

The compiled Windows binary installs Claude hooks with its absolute `process.execPath`
and separate arguments. This is Claude Code exec form: no shell, no quoting ambiguity,
and no dependency on a `.cmd` shim or `PATH`. Source-mode installation retains the
explicit `--command <compiled-executable>` contract.

The disposable SQLite projection cannot gate hook capture. When the index cannot open or
update, hook resolution falls back to immutable metadata plus authoritative ledgers,
appends under the session lifecycle gate, and reports a projection warning. Hooks are
ignored after `session.closed` or `worktree.removed`.

The Stage 1 tmux requirement is superseded. Before Stage 1 implementation, define a mux
port and select a native Windows backend. tmux may remain a Linux adapter, but it is not
the primary dogfood gate.

## Consequences

- Windows CI must run the pinned source suite, compile `dsp.exe`, and execute the compiled
  Stage 0 lifecycle.
- Windows artifacts are first-class outputs.
- The installed executable path is configuration state; moving or deleting the binary
  requires reinstalling hooks.
- A real native Claude Code invocation remains a release gate even though fixture-backed
  stdin ingestion runs through the compiled executable.
- Windows mux selection, long-path qualification, concurrent hook/reindex stress, and
  NTFS/ReFS provisioning behavior remain explicit follow-on work.
