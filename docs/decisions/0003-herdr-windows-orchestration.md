# ADR 0003 — Herdr is the first Windows orchestration backend

- Status: accepted for a qualified Stage 1 slice
- Date: 2026-07-31
- Scope: O7 backend selection, mux-port identity, and first native Windows lifecycle
- As-of basis: Herdr `0.7.5-preview.2026-07-29-44b3adb12552`, protocol `18`,
  observed locally and checked against upstream documentation on 2026-07-31

## Context

Stage 1 needs a terminal target that survives the short-lived `dsp.exe` process and can
later be discovered, focused, inspected, and closed. Dispatch must not become a terminal
emulator or long-lived supervisor. It also must not infer agent state from rendered
terminal output.

The focused Windows spike considered Herdr, WezTerm, Windows Terminal, and direct
ConPTY. The crux is addressable continuity after Dispatch exits, including recovery when
an external create succeeds but its response is lost.

Herdr exposes workspace, tab, pane, agent, and event control through CLI wrappers and a
newline-delimited JSON socket API. On Windows the transport is a named pipe. The installed
binary reports a detached server, client/server compatibility, and protocol `18`.
[The upstream socket reference](https://herdr.dev/docs/socket-api/) documents the schema,
snapshot, workspace, pane, agent, and wait surfaces; it also requires clients to check the
protocol and tolerate unknown fields. Herdr is currently
[Apache-2.0](https://github.com/herdrdev/herdr#license).

The spike also falsified the initial deterministic-target design: Herdr generates
workspace IDs, and `workspace.create` accepts cwd, environment, focus, and label but no
caller-supplied ID or idempotency key. A `targetFor(sessionId)` port would claim a safety
property the backend cannot implement.

## Decision

Herdr is the first `mux-windows` adapter. The adapter invokes one resolved absolute
`herdr.exe` with argv arrays and no shell. It requires:

- native Windows x64;
- a running, compatible Herdr server;
- protocol `18` for this initial adapter revision;
- structured JSON responses for successful commands.

The port uses server-issued receipts, not derived IDs. A persisted target is versioned
and contains at least the Herdr protocol, workspace ID, tab ID, root pane ID, terminal
ID, and canonical cwd. Display numbers are never identity.

An already receipted target is authoritative: `open` checks and reconnects that exact
generation before consulting mutable correlation fields. A conflict fails closed. Only
when no receipt exists, or the receipted generation is confirmed absent, does opening use
an `ensure` operation keyed by the deterministic label `dispatch:<sid>` plus canonical
worktree cwd:

1. Read a fresh snapshot.
2. If exactly one label-and-cwd match exists, adopt its server-issued target.
3. If no match exists, create a no-focus workspace and retain its returned workspace,
   tab, root-pane, and terminal IDs.
4. If the create response is lost or malformed, read another snapshot before retrying.
5. Adopt exactly one match, retry only after zero matches, and fail `ambiguous` after
   multiple matches.

The Dispatch ledger records the successful target in `session.opened.data.muxTarget`.
SQLite stores only a serialized projection of that receipt and must reconstruct it by
replay. An externally closed workspace is not a closed Dispatch session; a later
`dsp open` may ensure a replacement. If `dsp close` discovers an unreceipted generation,
it records that identity before mutation. Close then verifies the full target generation,
issues an ID-addressed workspace close, confirms the outcome with a fresh snapshot, and
records a target-specific terminal `session.closed`. A mismatched preflight identity is
`conflict`, never permission to close.

This is not an atomic compare-and-close guarantee. Herdr exposes no snapshot fence across
the preflight and the later `workspace close <workspaceId>` request. Concurrent ID reuse in
that interval is retained as a falsification risk; closed-ID generation stress remains a
full Stage 1 gate.

The first command surface is deliberately narrow:

```text
dsp open <sid> [--json]
dsp status <sid> [--json]
dsp close <sid> [--json]
```

`open` creates or focuses a shell workspace for the existing Dispatch worktree. `status`
is read-only and reports Dispatch lifecycle separately from Herdr state. `close` is an
explicitly terminal Dispatch lifecycle decision; merge and remove closure receipts do not
suppress its target-specific mux-close receipt.

Prompting is not in this slice. `herdr agent prompt <target> <text>` would expose prompt
text in process argv. The raw socket supports direct input and atomic prompt-plus-wait,
but implementing a Windows named-pipe client is a separate security and reliability
increment. [Herdr's agent automation contract](https://herdr.dev/docs/agent-automation/)
also distinguishes semantic agent state from terminal output; Dispatch continues to use
provider hooks as its authoritative agent-history input.

## Rejected alternatives

### WezTerm

WezTerm is the strongest fallback because its mux CLI can spawn, list, address, and close
long-lived panes. It was rejected for the first adapter because Dispatch would need to
rebuild agent-aware readiness, prompt delivery, and more recovery semantics that Herdr
already exposes. Select it if Herdr's preview protocol, recovery behavior, or daily-driver
reliability fails qualification.

### Windows Terminal

Windows Terminal remains a suitable outer renderer, but its command line is oriented to
launching and targeting windows rather than providing the complete durable workspace,
pane-generation, agent, and snapshot contract Stage 1 needs. It is not the authority for
Dispatch target identity.

### Direct ConPTY

ConPTY is a terminal transport, not a retained orchestration service. Owning it would
require a persistent Dispatch host process, violating the no-daemon invariant and moving
terminal emulation/lifecycle into product scope.

### Raw Herdr socket first

The raw socket becomes justified for private prompt delivery or subscriptions. It is
rejected for the first lifecycle slice because the CLI already supplies native named-pipe
handling, protocol checks, JSON envelopes, and stable process exit behavior. The adapter
keeps this transport replaceable.

## Consequences and qualification gates

- Herdr is an external runtime dependency; Dispatch remains the authority for session
  identity, ledger history, worktree ownership, and terminal-close policy.
- Lost create responses are reconcilable only through the label-and-cwd uniqueness
  convention. More than one match is a hard ambiguity requiring operator resolution.
- Lost prompt responses are not yet a problem because prompting is excluded. When added,
  prompt submission must never be automatically retried after an unknown outcome.
- Herdr events have no durable cursor or snapshot fence. Decisions use fresh snapshots;
  events may optimize observation later but are never authority. The unavoidable
  preflight-to-mutation TOCTOU is an alpha residual, not an atomic safety claim.
- The adapter is pinned to protocol `18`. A compatible-but-different protocol is a
  deliberate failure until its bundled schema passes conformance tests.
- GitHub CI can test the port and adapter with fakes but cannot prove interactive Windows
  desktop behavior. An alpha candidate's `full_lifecycle` native profile must start from a
  fresh `created` / `not_recorded` session and retain create, cross-process status/focus,
  external-close recovery, preflight-verified ID-addressed close, focus restoration, and
  stable executable hashes. Restart evidence remains a separate full Stage 1 gate.
- Full Stage 1 remains gated on prompt privacy, five restart/resume cycles, focus-change
  stress, closed-ID generation checks, and two weeks of daily use. This slice must not be
  represented as satisfying that dogfood gate.
