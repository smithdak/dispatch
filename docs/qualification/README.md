# Stage 0 qualification evidence

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
