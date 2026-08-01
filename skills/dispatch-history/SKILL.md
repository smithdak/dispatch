---
name: dispatch-history
description: Query prior Dispatch work sessions and their authoritative event ledgers before starting or repeating repository work.
---

# Dispatch history

Use Dispatch history when a task may repeat an earlier attempt, when a prior worktree was
merged or discarded, or when the user asks what happened in earlier agent sessions.

## Procedure

1. Query the repository work briefing before starting or repeating work:

   ```sh
   dsp work brief "<task intent>" --repo . --json
   ```

   Exact keys, fingerprints, and active-attempt reservations are authoritative for
   duplicate prevention. Lexical search scores are advisory only. If a matching work
   item is `planned` or `active` and has no unresolved attempt, use
   `dsp new --work <wid>` rather than creating an unrelated session. Inspect and
   explicitly reopen `blocked`, `review`, or `done` work only when intended;
   `superseded` is terminal.

   A clean removal without merge/discard evidence and a crash-only reservation remain
   unresolved. This slice has no automatic abandonment or reconciliation command;
   surface the state rather than bypassing it with a second identity.

2. List recent sessions as structured data when the briefing identifies relevant attempts
   or when legacy sessions are not linked to work:

   ```sh
   dsp ls --limit 20 --json
   ```

3. Select sessions from the same repository. Treat an `outcome.recorded` disposition of
   `merged`, corroborated by `git.merged`, as known-integrated evidence. `removed` means
   only that the physical worktree was cleaned up; it does not negate an earlier merge.
   Treat `git.discarded`, a discarded outcome, or a missing outcome as non-integrated or
   mixed evidence. Conflicting or multiple terminal receipts/outcomes are inconsistent;
   do not claim integration or authorize a retry from them.

4. Read the authoritative event stream for each relevant session:

   ```sh
   dsp log <sid> --json
   ```

5. Use `tool.called`, `tool.result`, `git.merged`, and `outcome.recorded` events to report
   what was attempted, whether it integrated, and the observed turn/diffstat facts. Report
   cost only when `usage.recorded` events exist. In alpha.3, `totalCost: 0` means no usage
   cost was observed; it does not prove zero provider spend. Do not infer success from
   agent lifecycle events alone.

6. If a session ledger reports corruption, stop and surface it. Do not substitute the
   SQLite projection for the authoritative JSONL record. `dsp reindex` repairs only the
   projection. For the global work ledger only, `dsp work repair` may remove an
   uncommitted non-newline tail and refuses committed corruption.

## Boundaries

- Do not read provider transcripts to reconstruct missing events.
- Do not treat `ext.<provider>` fields as canonical semantics.
- Do not claim production or customer outcomes from a local session disposition.
- Do not infer work-item completion from session outcomes; roadmap status is explicit.
- Do not treat candidate insights as repository canon.
- Do not place credentials, private prompts, or raw transcripts in plaintext candidate
  insights.
- If no matching session exists, say so directly and continue from repository evidence.
