# Stage 0 release qualification — 2026-07-31

## Verdict

- Functional verdict: **pass**, subject to exact-candidate pull-request and `main` CI.
- Performance verdict: **targets missed**.
- Release decision: publish `v0.1.0` as a GitHub **prerelease** after both CI conditions pass.
- Decision owner: repository operator.

This verdict does not move the original targets. The compiled Windows candidate passed
the full Stage 0 lifecycle and a real Claude Code process exercised the installed hook,
but all three process-level latency targets remain missed.

## Candidate identity

- Executable source commit: `2fe9fd9` (`Make session listing projection-fast`).
- Clean evidence commit: `98b1a9b9d54efb3574f609d7382b7f2c3f8ddae0`.
- Difference between those commits: retained qualification JSON only; executable source
  is identical.
- Git tree clean before the retained post-repair measurement: yes.
- Dispatch version: `0.1.0`.
- Compiled binary SHA-256:
  `557ade13cf95d6bba70069ed63308557e7690bd1fa49a1ea9287b0f41ef090cb`.
- Embedded Bun: `1.3.14`.
- Benchmark harness Bun: `1.3.14`.

The documentation commit containing this record is not used as a substitute for CI.
The pull-request and eventual `main` heads must pass independently before the tag is
created.

## Machine-local Windows evidence

- Evidence:
  [`stage0-windows-post-query-2026-07-31.json`](stage0-windows-post-query-2026-07-31.json).
- Platform: native Windows 11 Pro `10.0.26100`, x64.
- Host: AMD Ryzen 9 5950X, 32 logical processors, 68.6 GB reported memory.
- Execution context: Codex-managed native Windows environment.
- Storage: isolated state on the host default temporary filesystem; filesystem type was
  not recorded and is therefore not inferred.
- Fixture: 500 sessions, five warm-up iterations, 30 measured iterations.

| Contract | Target | Median | p95 | Maximum | Result |
| --- | ---: | ---: | ---: | ---: | --- |
| Fresh compiled `dsp --version` process | `<25 ms` | 57.885 ms | 61.450 ms | 61.992 ms | Missed |
| Compiled `dsp hook claude` durable append | `<5 ms` | 91.606 ms | 97.217 ms | 332.978 ms | Missed |
| Compiled `dsp ls --limit 500 --json` | `<50 ms` | 96.869 ms | 103.018 ms | 345.466 ms | Missed |

Operating-system caches were not flushed. Endpoint protection and the managed execution
context may add overhead, so these measurements establish failure on this host but do
not isolate every contributor. The query median improved `29.12x` from `2821.357 ms`
after the normal list path stopped opening every authoritative ledger tail. Use
`dsp ls --verify` when full ledger-to-projection reconciliation is required.

## Remote CI evidence

- Baseline run:
  [GitHub Actions 30651557200](https://github.com/smithdak/dispatch/actions/runs/30651557200).
- Baseline commit: `8dbe8a9888c57b4f33c6980fa785ec2bdf4fde02`.
- Baseline conclusion: Windows and Ubuntu succeeded, including compilation, compiled
  lifecycle qualification, and artifact upload.
- Exact-candidate pull-request CI: pending at the time this record was authored.
- Exact-merge `main` CI: required before tagging.

The baseline run is corroborating evidence only. It does not prove the query repair or
this release-documentation head.

## Live Claude Code evidence

- Evidence class: independently retained operator-machine runtime evidence.
- Observer: Codex execution session.
- Observed at: `2026-07-31T20:45:27.779Z`.
- Evidence:
  [`stage0-live-claude-windows-2026-07-31.json`](stage0-live-claude-windows-2026-07-31.json).
- Provider: Claude Code `2.1.220`, native Windows headless process.
- Installed executable SHA-256:
  `8ca5ef99e24f1f026c403055a5f0acf272fd93e6159d19dd7f610197214865d3`.
- Result: exit `0`, expected marker returned, no provider-reported error.
- Receipt: canonical `agent.started`, `turn.started`, `turn.completed`, and
  `agent.stopped` events were durably observed; the generated worktree was cleanly
  removed without force.

This invocation ran at commit `8dbe8a9`, before the list-query repair. It proves the
installed Stage 0 hook contract on Windows, not the exact release binary digest. The
query repair does not change hook translation, but that is an inference from the diff,
not a second provider invocation.

## Residual risks and falsification conditions

1. Normal `dsp ls` reads the rebuildable SQLite projection and can be stale after a
   process failure between durable ledger append and projection update. Hook warnings,
   `dsp ls --verify`, and `dsp reindex` expose and repair the condition.
2. Provider hooks are at-least-once. Provider correlation identifiers are retained, but
   semantic cross-process deduplication is not implemented.
3. Git worktree effects and Dispatch ledger receipts are not one atomic transaction.
   Recovery is explicit; it is not represented as exactly-once behavior.
4. The latency misses are dominated by fresh compiled-process/runtime and durable-I/O
   costs after the query repair. A persistent service or native rewrite is the strongest
   path to the original targets, but neither belongs in this Stage 0 prerelease.
5. This verdict is falsified by any exact-candidate CI failure, compiled lifecycle
   failure, artifact mismatch, or regression in the retained Windows test procedure.

