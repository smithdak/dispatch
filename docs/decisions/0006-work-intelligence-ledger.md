# ADR 0006 — Work identity and attempt reservations use a separate global ledger

- Status: accepted for the first work-intelligence slice
- Date: 2026-08-01
- Scope: durable work identity, duplicate prevention, roadmap state, and session attempts

## Context

Dispatch session ledgers answer what happened during one execution attempt. They cannot
represent an objective that exists before a session, spans several attempts, or remains
on a roadmap after an attempt closes. Adding work events to the session vocabulary would
also force cross-session state into an aggregate whose envelope requires one `sid`.

Per-work ledgers preserve aggregate boundaries but cannot atomically reject two concurrent
creations that choose different work IDs for the same intent. Checking each file before
creating another leaves a cross-process race.

Model summaries or embedding search could retrieve similar text, but similarity is not
identity and cannot safely prevent duplicate execution.

## Decision

Dispatch uses one low-volume append-only work ledger at
`<state>/intelligence/work/events.jsonl`. Its reducer permanently reserves
repository-scoped keys and fingerprints. The application uses the ledger's global
sequence and cross-process lock to make the one-unresolved-attempt check and reservation
atomic. Direct low-level ledger writers are outside that application policy boundary and
do not receive the active-attempt guarantee.

The work ledger has its own versioned envelope and event vocabulary. It does not extend
the session envelope or add work kinds to the closed session event set. A linked session
also records `workId` inside `session.created.data`; additive data fields do not change the
session envelope contract.

Every work item has:

- a random immutable `wid`;
- a required, stable repository-scoped key;
- an immutable title/objective, optional external reference, priority, and conservative
  normalized fingerprint;
- explicit roadmap status;
- attempt reservations identified by preallocated session IDs; and
- candidate insights that are never promoted automatically.

`dsp new --work <wid>` appends `work.attempt.started` before session creation. The same
locked transaction rejects another live reservation. If creation fails before durable
session intent exists, Dispatch appends `work.attempt.cancelled`. An uncertain or crashed
reservation remains blocking and visible; v0.1 does not guess that retry is safe.

Exact keys and fingerprints prevent duplicates. Token overlap is permitted only for
ranked discovery in a briefing and carries no equivalence, status, or authorization
semantics. Work completion remains an explicit status transition and is not inferred from
agent lifecycle or Git merge events. Dispatch rejects terminal status while an attempt
remains unresolved, and authenticates joined session evidence against both work ID and
repository identity.

## Consequences

- One authoritative lock boundary prevents concurrent duplicate work creation and
  application-level starts that use `dsp new --work`.
- Work items can outlive sessions and group multiple terminal attempts.
- Session evidence stays canonical in session ledgers; briefings join by ID at read time.
- The work ledger is intentionally replayed directly in v0.1. A SQLite projection may be
  added after measured volume justifies it; it will remain disposable.
- Existing sessions remain valid and unlinked. Dispatch does not invent work IDs for them.
- A crash after attempt reservation can require explicit future reconciliation. Blocking
  is safer than starting duplicate work.
- A torn final append can be removed only through explicit locked repair; committed
  corruption remains fail-closed.
- Sync-enabled writes persist both the event file and its directory namespace before
  acknowledgement; replay re-stabilizes the complete visible ancestor chain after a
  process-only crash, including a prior interrupted recursive-directory publication.
- Linked worktrees share the primary Git worktree's identity. Independent clones and
  moved checkouts are not federated in this slice.

## Rejected alternatives

- **Work events in session ledgers:** wrong aggregate boundary and incompatible with the
  closed session kind vocabulary.
- **One ledger per work item:** requires another authoritative registry to close the
  concurrent-creation race.
- **Embeddings or generated summaries first:** useful retrieval, insufficient identity,
  and a larger privacy/provenance boundary.
- **GitHub Issues as the only store:** viable external roadmap authority, but it does not
  own local attempt reservations or Dispatch session evidence. A later adapter can bind
  an issue ID as the stable key.

The complete interface and falsification triggers are in
[`docs/intelligence-architecture.md`](../intelligence-architecture.md).
