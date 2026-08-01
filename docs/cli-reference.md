# CLI reference

The compiled command is `dsp`. Every primary human command accepts `--json`; use it for
agents, scripts, and stable field-level inspection.

## Commands

| Command | Purpose |
| --- | --- |
| `dsp new [name] [--repo <path>] [--base <local-branch>] [--branch <new-branch>] [--path <new-path>] [--json]` | Create a durable session intent, linked worktree, and session metadata. |
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
