---
name: dispatch-history
description: Query prior Dispatch work sessions and their authoritative event ledgers before starting or repeating repository work.
---

# Dispatch history

Use Dispatch history when a task may repeat an earlier attempt, when a prior worktree was
merged or discarded, or when the user asks what happened in earlier agent sessions.

## Procedure

1. List recent sessions as structured data:

   ```sh
   dsp ls --limit 20 --json
   ```

2. Select sessions from the same repository. Treat an `outcome.recorded` disposition of
   `merged`, corroborated by `git.merged`, as known-integrated evidence. `removed` means
   only that the physical worktree was cleaned up; it does not negate an earlier merge.
   Treat `git.discarded`, a discarded outcome, or a missing outcome as non-integrated or
   mixed evidence.

3. Read the authoritative event stream for each relevant session:

   ```sh
   dsp log <sid> --json
   ```

4. Use `tool.called`, `tool.result`, `git.merged`, and `outcome.recorded` events to report
   what was attempted, whether it integrated, and the observed turn/diffstat facts. Report
   cost only when `usage.recorded` events exist. In alpha.3, `totalCost: 0` means no usage
   cost was observed; it does not prove zero provider spend. Do not infer success from
   agent lifecycle events alone.

5. If a command reports ledger corruption, stop and surface it. Do not substitute the
   SQLite projection for the authoritative JSONL record. `dsp reindex` repairs only the
   projection; it does not repair ledger data.

## Boundaries

- Do not read provider transcripts to reconstruct missing events.
- Do not treat `ext.<provider>` fields as canonical semantics.
- Do not claim production or customer outcomes from a local session disposition.
- If no matching session exists, say so directly and continue from repository evidence.
