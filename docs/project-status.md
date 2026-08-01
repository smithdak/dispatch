# Project status

Status snapshot: `v0.2.0-alpha.3`, published on 2026-08-01 from commit `421efef`.
Dispatch is functional prerelease software, not a production-ready or complete
multi-provider agent platform.

This page separates three questions: what is implemented, what has been qualified, and
what remains open.

## Usable now

- Windows x64 is the primary Stage 0 target; Linux x64 is secondary.
- A session can be created, listed, inspected, merged, removed, and reindexed.
- Claude Code hooks can record structured activity in Dispatch-owned worktrees.
- On Windows, a protocol-18 Herdr target can be opened, focused, inspected, recovered
  after an explicitly witnessed cold restart, prompted through stdin, and closed.
- Compiled binaries embed Bun and require Git on `PATH`; source work requires Bun
  `1.3.14`.

macOS and Linux arm64 are not supported runtime targets. The repository can cross-build
a Linux arm64 binary, but `doctor` rejects that host until it is qualified.

## Release proof boundary

| Release | Proven | Not proven by that release |
| --- | --- | --- |
| [`v0.1.0`](https://github.com/smithdak/dispatch/releases/tag/v0.1.0) | Exact Windows artifact completed the Stage 0 lifecycle and was invoked by a real native Claude Code process. | Original process-level latency targets; broad provider support. |
| [`v0.2.0-alpha.1`](https://github.com/smithdak/dispatch/releases/tag/v0.2.0-alpha.1) | Exact Windows artifact passed the native Herdr full-lifecycle profile. | Restart recovery, prompting, concurrency stress, daily-driver use. |
| [`v0.2.0-alpha.2`](https://github.com/smithdak/dispatch/releases/tag/v0.2.0-alpha.2) | Exact Windows artifact passed five isolated stop/start recovery cycles. | Native conversation restore, prompting, atomic mutation fencing, daily-driver use. |
| [`v0.2.0-alpha.3`](https://github.com/smithdak/dispatch/releases/tag/v0.2.0-alpha.3) | Exact Windows artifact passed the isolated synthetic transport profile. A later recovered local receipt using an installed binary with the same SHA-256 records one isolated live-Claude prompt and completed turn with zero tools and safe cleanup. | Ordinary acceptance as a general delivery/completion guarantee, directly retained pane output, named-pipe ACL behavior or same-user confidentiality, multiline or working-agent prompting, concurrency/ID-reuse stress, other providers, sustained use. |

The alpha.3 helper was deliberately named `codex.exe` so Herdr recognized an agent-kind
foreground process. It was not OpenAI Codex; that original synthetic profile did not
invoke a provider or model.

## Stage boundaries

| Stage | State |
| --- | --- |
| Stage 0 — durable sessions | Implemented and functionally qualified on the supported x64 targets. The original process-latency targets remain missed. |
| Stage 1 — Windows orchestration | Herdr lifecycle, namespace binding, cold-restart recovery, and synthetic private-prompt transport are qualified; one isolated real-Claude prompt/turn is qualified once through recovered local evidence. Open work includes layouts, named-pipe ACL proof, multiline and working-agent prompting, concurrency stress, native conversation restore, and the two-week daily-driver test. |
| Stage 2 — provisioning | Only the filesystem probe harness exists. No provisioning engine ships before the O3 divergence-safety spike. |
| Stage 3 — outcomes and review | Merge outcomes and the history skill exist. Review handoff and richer cross-session queries do not. |
| Stages 4–5 — batch and providers | Batch execution and additional hook providers are not implemented. |

## Open release gates

### Performance

The retained Windows benchmark reduced the 500-session query median from
`2821.357 ms` to `96.869 ms`, but the original `<50 ms` query, `<25 ms` cold-start, and
`<5 ms` durable-hook-append targets all remain missed. Stage 0 is a functional pass with
a documented performance exception, not a performance pass.

### Transaction and recovery boundaries

- Git effects and ledger receipts are not one atomic transaction. Durable creation
  intent and idempotent retry cover common interruption cases; automatic startup
  reconciliation is not implemented.
- Provider hooks are at-least-once. Provider correlation identifiers are retained, but
  cross-process semantic deduplication is not implemented.
- Herdr has no atomic snapshot fence between full-target preflight and workspace-ID
  mutation. Concurrent ID reuse remains an alpha falsification risk.
- An unknown prompt outcome blocks later prompt, focus, close, merge, and remove
  mutations until an operator explicitly acknowledges the uncertainty.

### Stage 1 completion

Still required: named-pipe ACL qualification, multiline and working-agent prompting,
layouts, concurrent focus/target rollover stress, closed-workspace ID reuse stress,
native agent conversation restore, and sustained daily-driver displacement.

CI exercises the Herdr adapter against structured fakes. Native runtime qualification and
exact downloaded-artifact receipts are separate proof classes.

## Evidence

The canonical methods, exact CI links, local measurements, live Claude receipts, Herdr
lifecycle receipts, restart receipts, alpha.3 private-transport receipt, and recovered
single-turn real-Claude plus cleanup receipts are indexed under
[Qualification evidence](qualification/README.md). Raw JSON receipts should be read
through that index so their proof limits stay attached.

The architecture's strongest alternative is a ledger-only companion beside workmux. It
remains the required pivot if Stage 1 does not displace workmux in two weeks of actual
use. See the [architecture specification](../arch.md) for the kill criteria and rationale.
