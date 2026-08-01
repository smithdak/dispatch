# Agent workflows

This guide is for an agent deciding whether repository work is new, already integrated,
discarded, or incomplete.

## Inspect history before acting

List recent sessions as structured data:

```sh
dsp ls --limit 20 --json
```

Select sessions from the same repository, then read each relevant authoritative event
stream:

```sh
dsp log <sid> --json
```

Interpret outcomes conservatively:

- `outcome.recorded` with disposition `merged`, corroborated by `git.merged`, is
  known-integrated repository evidence.
- `removed` means the physical worktree was cleaned up. It does not negate an earlier
  merge.
- `git.discarded`, a discarded outcome, or a missing outcome is non-integrated or mixed
  evidence.
- `agent.started`, `turn.completed`, and similar lifecycle events do not prove the code
  integrated or the requested outcome occurred.

Use `tool.called`, `tool.result`, `git.merged`, and `outcome.recorded` to report what was
attempted, what integrated, and the observed turn and diffstat facts. Report cost only
when `usage.recorded` events exist. In alpha.3, `totalCost: 0` means no usage cost was
observed; it does not prove zero provider spend.

## Preserve the evidence boundary

- Treat each session's JSONL ledger as authoritative. SQLite is a disposable projection.
- If a command reports ledger corruption, stop and surface it. `dsp reindex` repairs the
  projection, not ledger data.
- Do not read provider transcripts to reconstruct missing events.
- Do not treat `ext.<provider>` fields as canonical semantics.
- Do not turn a local session disposition into a production or customer-outcome claim.
- If no matching session exists, say so and continue from repository evidence.

The repository includes the same procedure as an agent skill at
[`skills/dispatch-history/SKILL.md`](../skills/dispatch-history/SKILL.md). The file is a
procedure, not an automatically installed integration.

For command shapes, filters, and repair behavior, see the
[CLI reference](cli-reference.md).
