# Qualification evidence

Qualification records keep three evidence classes separate:

1. **Machine-local evidence** is emitted by `bun run benchmark:stage0` against one
   compiled binary and an isolated temporary state directory. It is reproducible on the
   same machine, but it is not CI or provider evidence.
2. **CI evidence** is a dated link to a completed remote run at an exact Git commit. A
   configured workflow is not evidence that the workflow ran.
3. **Live-provider evidence** is a real provider process invoking the installed hook.
   Fixture-backed stdin and operator reports are useful but are labelled as such; neither
   is silently promoted to independently retained runtime evidence.

## Reproduce the local measurements

Use the pinned Bun version to build, qualify, and benchmark the host binary:

```powershell
bun run build
bun run qualify:binary
bun run benchmark:stage0 --output (Join-Path $env:TEMP "dispatch-stage0-evidence.json")
```

The benchmark constructs 500 valid session ledgers and projections outside the timed
region, then records 30 samples after five warm-up iterations for:

- fresh compiled-process startup: `dsp --version`;
- provider-facing append: `dsp hook claude`, including process startup, translation,
  resolution, ledger fsync, SQLite projection, and exit;
- the full 500-session command: `dsp ls --limit 500 --json`, including projection
  integrity checks and JSON serialization.

The output retains raw samples, median, p95, mean, extrema, binary SHA-256, embedded and
benchmark-harness Bun versions, Git state, host characteristics, and whether Codex
environment markers were present. Each sample launches a fresh process, but the script
does not flush operating-system image or filesystem caches. A sandboxed result is not an
unsandboxed operator-shell result. The architecture does not state whether its latency
targets apply to median, p95, or maximum, so the record reports all three comparisons and
does not invent a release statistic.

Use `--binary`, `--iterations`, `--warmup`, and `--sessions` to change the fixture. A
query run with any session count other than 500 deliberately receives no comparison to
the architecture's 500-session target.

## Retained 2026-07-31 evidence

- [`stage0-windows-2026-07-31.json`](stage0-windows-2026-07-31.json) is the
  clean-source, pinned-Bun baseline before the query-path repair. Its 500-session median
  was `2821.357 ms` because every normal list operation opened all 500 ledger tails.
- [`stage0-windows-post-query-2026-07-31.json`](stage0-windows-post-query-2026-07-31.json)
  measures the projection-fast implementation. Its 500-session median was `96.869 ms`,
  a `29.12x` reduction; authoritative O(session count) reconciliation remains available
  through `dsp ls --verify`.
- [`stage0-live-claude-windows-2026-07-31.json`](stage0-live-claude-windows-2026-07-31.json)
  retains the sanitized real-provider receipt. It records the installed binary digest,
  provider version and result, canonical hook event sequence, and clean worktree cleanup
  without retaining the prompt or provider transcript.

Both performance runs used Bun `1.3.14` for the harness and embedded binary in the same
Codex-managed Windows environment. They did not flush operating-system caches. The
post-repair result still misses the architecture's original `<50 ms` process-level query
target; cold start and durable hook append also miss their original targets. Stage 0 is
therefore a functional pass with a documented performance exception, not a performance
pass.

## Stage 1 native Windows lifecycle

`scripts/qualify-windows-mux.ts` drives separate compiled `dsp.exe` processes and one
explicit absolute `herdr.exe`. Every Dispatch child receives that same Herdr path through
`DISPATCH_HERDR_BIN`; the evidence hashes both executables before and after the run.

The harness reports one of four profiles: `open_status`, `external_recovery`,
`terminal_close`, or `full_lifecycle`. A generic `pass` means only that the selected
profile passed. `completeLifecycle: true` is possible only for `full_lifecycle`, which
requires both `--exercise-external-close` and `--close`, a fresh Dispatch session whose
preflight is `created` / `not_recorded`, protocol `18`, initial create-and-record,
idempotent cross-process open/status, recovery to a wholly new generation after an
external Herdr close, terminal close, and confirmed operator-focus restoration.

Run the full profile only against a disposable session:

```powershell
$created = .\dist\dsp.exe new "Stage 1 qualification" --repo (Get-Location).Path --json |
  ConvertFrom-Json
bun run scripts/qualify-windows-mux.ts --binary .\dist\dsp.exe `
  --herdr "C:\absolute\path\to\herdr.exe" --sid $created.sid `
  --exercise-external-close --close `
  --output (Join-Path $env:TEMP "dispatch-stage1-windows.json")
.\dist\dsp.exe remove $created.sid
```

Raw harness output retains local absolute paths and the disposable SID. Sanitize those
fields before committing evidence. The proof is native lifecycle evidence, not restart,
prompt-privacy, or daily-driver evidence. Herdr has no atomic snapshot fence between the
adapter's full-generation preflight and its subsequent workspace-ID close, so closed-ID
reuse stress remains an explicit alpha gate.

[`stage1-windows-herdr-2026-07-31.json`](stage1-windows-herdr-2026-07-31.json)
is the sanitized `full_lifecycle` receipt for clean source commit `fff1f98`. It binds the
local compiled candidate and exact Herdr client by SHA-256, retains the two-generation
external-close recovery sequence, and records focus/worktree/branch cleanup. It is not a
downloaded release-artifact, restart/resume, prompt, or daily-driver receipt.
