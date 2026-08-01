# Dispatch Work Intelligence — Architecture Specification v0.1

*First executable slice for durable work identity, duplicate avoidance, roadmap state,
and evidence-backed agent briefings. Spec date: 2026-08-01. Targets Dispatch
`v0.2.0-alpha.3` on its currently supported local state model.*

## 0. Thesis and positioning

Dispatch Work Intelligence is a deterministic layer over durable work items and existing
session evidence. It answers three questions before execution: whether the work already
exists, what prior attempts actually integrated, and which planned item should run next.

It is not a transcript archive, model memory, general project manager, or authority for
external issue trackers. External roadmap identifiers remain references; Dispatch owns
the local work-to-evidence relationship.

The strongest alternative is model-generated summaries plus vector search over session
transcripts. It is rejected for this slice because similarity without canonical work
identity cannot distinguish duplicate work from an intentional revisit, while raw
transcripts expand the privacy and provenance boundary.

## 1. Design invariants

- **I1 — Work identity precedes inference.** Every tracked objective receives an immutable
  `wid`; titles and similarity scores never substitute for identity.
- **I2 — Work history is append-only.** The global work JSONL events are authoritative.
  Current status, linked sessions, insights, and briefings are reducer outputs.
- **I3 — Evidence stays in its owning ledger.** Work events link session IDs but do not
  copy provider events, Git receipts, or outcomes out of session ledgers.
- **I4 — Similarity is advisory.** Exact fingerprints may reject accidental duplicate
  creation; lexical related-work scores may only rank and warn.
- **I5 — Completion is explicit.** A `done` work status is an operator assertion. Session
  lifecycle events and agent output cannot silently close work.
- **I6 — Learning is candidate data.** Notes proposed by an agent or operator are surfaced
  as candidates and are not promoted into repository canon automatically.
- **I7 — Missing evidence is visible.** Dangling session links and absent outcomes produce
  explicit unresolved or inconsistent states; corrupt ledgers produce errors. None are
  optimistically reconstructed.

## 2. Structure and taxonomy

```text
<dispatch-state>/
├── sessions/<sid>/events.jsonl       authoritative execution evidence
└── intelligence/work/events.jsonl    authoritative work graph and reservations
```

The v0.1 work event vocabulary is deliberately small:

- `work.created` — immutable repository, title, objective, priority, external reference,
  fingerprint, and creation time.
- `work.status.changed` — explicit roadmap transition.
- `work.attempt.started` — atomic reservation of one preallocated session ID.
- `work.attempt.cancelled` — explicit release when no durable session was created.
- `work.insight.proposed` — candidate decision, learning, risk, or question.

The reducer emits a `WorkItem` containing the current status, linked session IDs, and
candidate insights. Briefing enriches those links by reading authoritative session
ledgers and reporting observed merged, discarded, active, or missing outcomes.

## 3. Interface contracts

```text
dsp work create <title> --key <stable-key> [--repo <path>] [--objective <text>]
                [--external <ref>] [--priority <1..5>] [--json]
dsp work ls [--repo <path>] [--status <status>] [--limit <n>] [--json]
dsp work show <wid> [--json]
dsp work status <wid> <planned|active|blocked|review|done|superseded> [--json]
dsp work note <wid> --kind <decision|learning|risk|question> --stdin
              [--session <sid>] [--json]
dsp work brief [query] [--repo <path>] [--limit <n>] [--json]
dsp work repair [--json]
dsp new [name] --work <wid> [...existing options]
```

`work create` allocates a random `wid` behind a required, repository-scoped stable key.
It rejects conflicting key reuse and an exact normalized fingerprint collision; a retry
with the same complete normalized creation intent returns the existing item. `new --work`
reserves a preallocated `sid` in the global work ledger before creating the session, so
concurrent starts cannot both pass. A start that fails before a durable session origin appends
`work.attempt.cancelled`; a crash after reservation remains visibly blocked until
reconciled rather than silently starting a second attempt.

`work repair` is an explicit crash-recovery operation. Under the same global lock, it
may remove only a final non-newline suffix that was never a committed JSONL record, then
fsyncs the truncation. It refuses schema, sequence, or domain corruption and never
rewrites a committed event.

`work brief` returns four roadmap queues (`active`, `blocked`, `review`, `next`) plus
ranked query matches. Each match includes a transparent lexical search score, shared terms,
attempt count, and observed session outcome counts. It does not claim semantic
equivalence or task completion.

## 4. Volatility isolation

- Similarity normalization and scoring live in the core work module; replacing lexical
  scoring does not change ledger records.
- External tracker references are opaque strings in `work.created`; provider adapters do
  not enter the core domain.
- Session interpretation lives in the application briefing service and follows the
  existing `git.merged` plus `outcome.recorded` evidence rule.
- Human or model presentation belongs to CLI/adapters; stored events remain canonical
  JSON without generated prose summaries.

## 5. Sequencing and launch scope

v0.1 ships the five work events, reducer, deterministic matching, evidence-enriched
briefing, CLI surface, and tests for corruption and safe repair, concurrency,
idempotency, cross-repository rejection, and duplicate behavior.

Deferred: dependency graphs, mutable priority/objective fields, accepted/rejected insight
decisions, explicit abandoned-reservation recovery, GitHub synchronization, embeddings,
generated summaries, cross-machine federation, and Codex/OpenCode event adapters.

## 6. Open decisions

- **O1 — External roadmap synchronization.** Recommendation: add explicit import/export
  adapters after the local identity contract is dogfooded. Resolve when one real roadmap
  is selected and conflict ownership is defined. Owner: operator.
- **O2 — Similarity backend.** Recommendation: retain lexical ranking until measured
  duplicate misses justify embeddings. Resolve with a labeled corpus of at least 100
  work-item pairs and false-positive/false-negative targets. Owner: Dispatch maintainer.
- **O3 — Insight promotion.** Recommendation: require an explicit governed promotion into
  repository canon, not merely another local status bit. Resolve when the destination
  canon and reviewer identity contract exist. Owner: operator.
- **O4 — Repository identity across clones and moves.** v0.1 canonicalizes every linked
  worktree to Git's primary worktree, but an independently cloned or moved checkout is a
  different namespace. Recommendation: bind a stable external repository identifier only
  when clone federation is required. Owner: Dispatch maintainer.

## 7. Kill and pivot triggers

- If fewer than 80% of new sessions can be linked to a work item during two weeks of
  dogfood, make work capture less intrusive or retreat to advisory history only.
- If related-work warnings exceed 20% false positives on a labeled set, disable advisory
  warnings until scoring is replaced; exact fingerprint checks remain.
- If an external tracker becomes the uncontested identity authority, preserve Dispatch
  evidence linkage but adopt its immutable issue ID instead of maintaining parallel IDs.
- If users routinely place secrets or raw transcripts in insights, remove free-form note
  capture and retain only repository pointers plus hashes.

## Appendix — Proof boundary

This specification relies only on local Dispatch contracts as of 2026-08-01. It makes no
claim that existing sessions are comprehensively captured: the current adapter coverage
and stored event population remain separate qualification concerns. The first slice is
complete only when tests prove the new ledger and commands; usefulness requires later
dogfood evidence against real roadmap work.

The reservation guarantee applies only to registered work started through
`dsp new --work`. Compatibility-mode `dsp new`, external agent processes, and direct
low-level ledger writers remain outside it; the plain command emits a warning rather than
claiming roadmap coverage.

Objectives, external references, and candidate insight bodies are local plaintext state.
They must not contain secrets or raw transcripts; v0.1 has no redaction, retention, or
actor-attestation layer.
