# CLI reference

The compiled command is `dsp`. Every primary human command accepts `--json`; use it for
agents, scripts, and stable field-level inspection. Thrown command errors in JSON mode
write a stable
`{"error":{"code":"...","message":"...","details":{...}}}` envelope to stderr;
`details` is empty or omitted when there is no structured evidence.

## Commands

| Command | Purpose |
| --- | --- |
| `dsp work create <title> --key <stable-key> [--repo <path>] [--objective <text>] [--external <ref>] [--priority <1..5>] [--json]` | Create or idempotently resolve a repository-scoped work identity. |
| `dsp work ls [--repo <path>] [--status <status>] [--limit <n>] [--json]` | List current roadmap state reduced from the authoritative work ledger. |
| `dsp work show <wid> [--json]` | Show one work item with its attempts, candidate insights, and session evidence. |
| `dsp work status <wid> <status> [--json]` | Record an explicit roadmap status transition. |
| `dsp work note <wid> --kind <decision|learning|risk|question> --stdin [--session <sid>] [--json]` | Append a candidate insight without promoting it into repository canon. |
| `dsp work brief [query] [--repo <path>] [--limit <n>] [--json]` | Return roadmap queues and deterministic related-work search results. |
| `dsp work repair [--json]` | Remove only an uncommitted, non-newline work-ledger tail; refuse committed corruption. |
| `dsp new [name] [--work <wid>] [--repo <path>] [--base <local-branch>] [--branch <new-branch>] [--path <new-path>] [--json]` | Create a durable session intent and linked worktree, optionally through an atomic work-attempt reservation. |
| `dsp ls [--limit <n>] [--status <status>] [--repo <path>] [--verify] [--json]` | List sessions from the projection; optionally verify each ledger tail. |
| `dsp log <sid> [--kind <kind>] [--limit <n>] [--json]` | Read the authoritative event history for one session. |
| `dsp merge <sid> [--json]` | Merge committed session work into its recorded base branch and record the outcome. |
| `dsp remove <sid> [--force] [--json]` | Remove the linked worktree; require explicit force for dirty work. |
| `dsp open <sid> [--recover-restored-terminal] [--json]` | Create or focus the receipted Windows Herdr target. |
| `dsp status <sid> [--json]` | Compare durable session state with live Herdr state without mutation. |
| `dsp close <sid> [--recover-restored-terminal] [--json]` | Close the verified Herdr target and record the terminal receipt. |
| `dsp prompt <sid> --stdin [--acknowledge-unknown <prompt-id>] [--json]` | Submit one stdin-only prompt, optionally acknowledging an earlier unknown outcome. |
| `dsp prompt <sid> --acknowledge-unknown <prompt-id> [--json]` | Clear one unresolved prompt barrier without sending another prompt. |
| `dsp reindex [--json]` | Rebuild the disposable SQLite projection from authoritative ledgers. |
| `dsp hooks install claude [--project <path>] [--command <path>] [--json]` | Install Claude Code hooks at user or project scope. |
| `dsp doctor [--stage1] [--json]` | Validate the host, Git, runtime version, and optional Herdr dependency. |
| `dsp --version` | Print the Dispatch version. |

The provider-facing hook entry is `dsp hook claude`. It accepts Claude hook JSON on
stdin and is installed by `dsp hooks install claude`; it is not a normal interactive
command.

## Work intelligence

The work ledger at `<state>/intelligence/work/events.jsonl` is authoritative for work
identity, explicit roadmap status, attempt reservations, and candidate insights. It is
separate from per-session evidence because one work item may exist before a session and
span several terminal attempts.

`work create` requires a stable key unique within the canonical repository. Repeating the
same complete normalized creation intent is idempotent. Reusing the key with a changed
title, objective, external reference, or priority, or creating the same exact normalized
intent under another key, is rejected. Search scores returned by `work brief` are advisory
lexical overlap; they never establish identity or completion.

Keys are 1–128 lowercase ASCII letters and digits separated by single dots, underscores,
hyphens, or slashes. Input is NFKC-normalized, trimmed, lowercased, and whitespace becomes
a hyphen before validation. The duplicate fingerprint combines the canonical repository
identity with the NFKC/whitespace-normalized objective when present, otherwise the title;
case and punctuation remain significant. External reference and priority are not part of
the fingerprint, though they must remain identical for an idempotent same-key retry.
After text normalization, titles are limited to 1–200 characters, objectives to 1–4,000
when supplied, and external references to 1–500 when supplied.

Priority is an integer from 1 (highest) through 5 (lowest), defaults to 3, and sorts lower
numbers first in lists and roadmap queues. Query matches sort by lexical score, using
priority as a tie-breaker. `work create` and `work brief` default the repository to the
current Git checkout. `work ls` is global unless `--repo` is supplied.

`work ls --limit` defaults to 100 and accepts at most 10,000. `work brief --limit`
defaults to 10, accepts at most 100, and applies independently to each roadmap queue and
the related-work match list.

`new --work` reserves a preallocated session ID in the work ledger before Git or session
creation. Another start for that work item is rejected while an earlier reservation or
session is active. A failed pre-origin creation is cancelled explicitly. An uncertain
reservation remains blocking rather than being retried as if it never happened.

Plain `dsp new` remains available for compatibility, but emits an untracked-session
warning. Its session is absent from work-roadmap queues, and duplicate-prevention and
roadmap-continuity guarantees do not apply.

Statuses are `planned`, `active`, `blocked`, `review`, `done`, and `superseded`.
Completion is always an explicit status command; a merge is supporting session evidence,
not authority to mark roadmap work done. `planned`, `done`, and `superseded` are rejected
while an attempt remains unresolved; `superseded` is terminal. The `next` queue therefore
contains only planned items without unresolved attempts.

Candidate insights normalize stdin whitespace to one-line canonical text, then limit that
normalized body to 4,000 characters. They may be associated with one attempt, but remain proposals.
This release does not provide an automatic or model-controlled promotion into project
documentation. Bodies are stored as local plaintext: do not place secrets or raw provider
transcripts in them.

All linked worktrees resolve to the primary Git worktree's roadmap namespace. Separate
clones and a checkout moved to a new physical path are not unified in this release.

## Session lifecycle rules

### Create

`new` must run against a Git repository with a local branch and at least one commit. It
records durable creation intent before Git mutation. The result includes the session ID,
repository path, worktree path, session branch, base branch, and base commit.

`--base` must name an existing local branch; a commit SHA, tag, or ordinary
remote-tracking ref is not accepted. An explicit `--branch` must not already exist, and
an explicit `--path` must not already exist. Without these options, Dispatch uses the
current local branch and generates the session branch and worktree path.

If Git fails after the durable intent, the origin-only session remains visible in
`dsp ls` and can be terminally cleaned up with `dsp remove <sid>`. Resuming the same
creation intent is not implemented.

### List and repair

Normal `ls` trusts the SQLite projection. `ls --verify` compares each projected sequence
with its authoritative ledger tail and rebuilds stale projection state. Verification is
O(session count). `reindex` is the explicit full projection repair.

`ls --limit` defaults to `100`. `--status` accepts `active`, `closed`, `merged`,
`discarded`, or `removed`.

Projection repair does not repair or replace corrupt JSONL ledger data.

`dsp work repair` applies only to the separate global work ledger. It holds the work lock,
removes a final non-newline suffix that was never committed, fsyncs the result, and reports
the bytes removed. It refuses malformed committed records, sequence gaps, schema errors,
and invalid domain history.

### Merge

`merge` requires:

- committed, clean session work;
- a clean primary repository;
- the primary repository still checked out on the recorded base branch; and
- no unresolved prompt outcome.

It records the committed diffstat, wall duration, observed turn count, and the sum of any
`usage.recorded` events before the logical session closes. Alpha.3 has no usage-event
producer, so `totalCost: 0` means no cost was observed—not that provider spend was zero.
Git effects and ledger receipts are not one atomic transaction; retrying the same command
is the supported recovery path after common post-effect failures.

### Remove

`remove` deletes the linked worktree and is idempotently retryable after common
post-effect failures. Dirty worktrees are rejected unless `--force` is present. A forced
dirty removal records `git.discarded`, even if an earlier merge outcome exists.

For a linked work attempt, a clean removal without a merge or explicit outcome remains
unresolved and blocks another attempt. This release deliberately has no guess-based
abandon/retry command; merge completed work before removal, and surface accidental clean
removals for manual reconciliation rather than creating duplicate execution.

### Terminal commands

`open`, `status`, `close`, and `prompt` require the Windows Herdr adapter. `status` is
read-only. Recovery authorization never applies automatically. Prompting requires an
already-running idle foreground agent and piped stdin.

See [Windows agent sessions](windows-agent-sessions.md) for the operational contract.

## History semantics for agents

Use `dsp ls --json` to discover candidate sessions and `dsp log <sid> --json` to read the
authoritative stream. Do not infer integration from provider lifecycle events. The full
interpretation rules are in [Agent workflows](agent-workflows.md).

## Configuration

State locations, TOML keys, and environment overrides are documented in
[Configuration and state](configuration.md).
